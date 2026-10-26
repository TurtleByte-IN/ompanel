// @effect-diagnostics nodeBuiltinImport:off - path validation needs `lstat` and an `O_NOFOLLOW` open, which Effect's FileSystem does not expose.
/**
 * The file editors of Settings → OMP Advisor & Agents: OMP's user-level `WATCHDOG.yml` advisor
 * roster and the custom agents in `agents/*.md`, both in the instance's agent directory. OMP reads
 * the roster from `<agent dir>/WATCHDOG.yml` (`advisor/config.ts` `advisorConfigFilePath`) and the
 * agents from `<agent dir>/agents` (`task/discovery.ts`); `omp config path` prints that directory
 * for the instance's profile and environment, so each call asks it rather than guessing `~/.omp`.
 *
 * Nothing outside the agent directory is read or written: agent names are plain `.md` file names,
 * and a folder or file that is a link must resolve inside the directory. Writes go to a temporary
 * file beside the target and replace it with one rename, and only when the file is still at the
 * version the editor read.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  OMP_AGENT_FILE_MAX_BYTES,
  OMP_AGENT_FILE_NAME_PATTERN,
  OmpAgentFilesOperationError,
  type OmpAgentFile,
  type OmpAgentFileEntry,
  type OmpAgentFileRef,
  type OmpAgentFilesList,
  type OmpAgentFilesOperationErrorReason,
} from "@t3tools/contracts";
import type { ProviderOmpAgentFilesController } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import type { OmpControlService, OmpControlTarget } from "./control.ts";
import type { OmpSidecarError } from "./sidecar.ts";

const WATCHDOG_YML = "WATCHDOG.yml";
const WATCHDOG_YAML = "WATCHDOG.yaml";
const AGENTS_DIR = "agents";

/** A refusal with a reason the client shows; anything else thrown is an I/O failure. */
class Refusal extends Error {
  readonly reason: OmpAgentFilesOperationErrorReason;
  constructor(reason: OmpAgentFilesOperationErrorReason, message: string) {
    super(message);
    this.reason = reason;
  }
}

const errorCode = (cause: unknown) =>
  typeof cause === "object" && cause !== null && "code" in cause ? cause.code : undefined;

const isMissing = (cause: unknown) => {
  const code = errorCode(cause);
  return code === "ENOENT" || code === "ENOTDIR";
};

const lstatOrUndefined = (filePath: string) =>
  NodeFSP.lstat(filePath).catch((cause: unknown) => {
    if (isMissing(cause)) return undefined;
    throw cause;
  });

/** `candidate` is `root` itself or lies under it. */
const isInside = (root: string, candidate: string) => {
  const relative = NodePath.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${NodePath.sep}`) &&
      !NodePath.isAbsolute(relative))
  );
};

const sha256 = (bytes: Buffer) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

/** The agent directory with every link resolved; the directory itself may be a link. */
const realAgentDir = async (agentDir: string) => {
  // A relative answer from `omp config path` would resolve against Ompanel's own directory.
  if (!NodePath.isAbsolute(agentDir)) {
    throw new Refusal("omp_failed", `OMP reported a relative agent directory: ${agentDir}.`);
  }
  try {
    return await NodeFSP.realpath(agentDir);
  } catch (cause) {
    if (isMissing(cause)) {
      throw new Refusal("not_found", `OMP's agent directory ${agentDir} does not exist.`);
    }
    throw cause;
  }
};

/**
 * `dir` (the agent directory or a folder in it) with links resolved, or undefined when it does
 * not exist. A link that leads out of the agent directory, or anything but a folder, is refused.
 */
const checkedDir = async (root: string, dir: string, label: string) => {
  if (dir === root) return root;
  const stats = await lstatOrUndefined(dir);
  if (stats === undefined) return undefined;
  if (stats.isSymbolicLink()) {
    const target = await NodeFSP.realpath(dir).catch(() => undefined);
    if (target === undefined || !isInside(root, target)) {
      throw new Refusal("not_editable", `${label} links outside OMP's agent directory.`);
    }
    if (!(await NodeFSP.stat(target)).isDirectory()) {
      throw new Refusal("not_editable", `${label} is not a folder.`);
    }
    return target;
  }
  if (!stats.isDirectory()) throw new Refusal("not_editable", `${label} is not a folder.`);
  return dir;
};

interface CheckedFile {
  /** The directory entry: what OMP lists, and what a delete removes. */
  readonly entry: string;
  /** The regular file behind the entry (the entry, or the target of a link inside the directory). */
  readonly file: string;
  readonly exists: boolean;
}

/** Refuses an entry that is not a regular file, or a link whose target leaves the directory. */
const checkedFile = async (root: string, entry: string, label: string): Promise<CheckedFile> => {
  const stats = await lstatOrUndefined(entry);
  if (stats === undefined) return { entry, file: entry, exists: false };
  if (stats.isSymbolicLink()) {
    const target = await NodeFSP.realpath(entry).catch(() => undefined);
    if (target === undefined || target === root || !isInside(root, target)) {
      throw new Refusal("not_editable", `${label} links outside OMP's agent directory.`);
    }
    if (!(await NodeFSP.stat(target)).isFile()) {
      throw new Refusal("not_editable", `${label} is not a regular file.`);
    }
    return { entry, file: target, exists: true };
  }
  if (!stats.isFile()) throw new Refusal("not_editable", `${label} is not a regular file.`);
  return { entry, file: entry, exists: true };
};

/** The file's text and version; the last path component must not be a link (`O_NOFOLLOW`). */
const readChecked = async (file: string, label: string) => {
  const handle = await NodeFSP.open(
    file,
    NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0),
  );
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Refusal("not_editable", `${label} is not a regular file.`);
    if (stats.size > OMP_AGENT_FILE_MAX_BYTES) {
      throw new Refusal("too_large", `${label} is larger than ${OMP_AGENT_FILE_MAX_BYTES} bytes.`);
    }
    const bytes = await handle.readFile();
    const content = bytes.toString("utf8");
    // Saving a file that is not UTF-8 text would replace its undecodable bytes.
    if (!Buffer.from(content, "utf8").equals(bytes)) {
      throw new Refusal("not_editable", `${label} is not UTF-8 text.`);
    }
    return { content, version: sha256(bytes), mode: stats.mode & 0o777 };
  } finally {
    await handle.close();
  }
};

interface Located {
  /** The folder holding the file, as OMP names it (not yet resolved). */
  readonly dir: string;
  readonly name: string;
  readonly relativePath: string;
}

/** OMP's editor writes `WATCHDOG.yaml` in place when only that exists (`resolveAdvisorConfigFile`). */
const watchdogFileName = async (root: string) =>
  (await lstatOrUndefined(NodePath.join(root, WATCHDOG_YML))) === undefined &&
  (await lstatOrUndefined(NodePath.join(root, WATCHDOG_YAML))) !== undefined
    ? WATCHDOG_YAML
    : WATCHDOG_YML;

const locate = async (root: string, ref: OmpAgentFileRef): Promise<Located> => {
  if (ref.kind === "watchdog") {
    const name = await watchdogFileName(root);
    return { dir: root, name, relativePath: name };
  }
  // The contract checks the name too; this keeps the module safe on its own.
  if (!OMP_AGENT_FILE_NAME_PATTERN.test(ref.name)) {
    throw new Refusal("not_editable", `${ref.name} is not a plain agent file name.`);
  }
  return {
    dir: NodePath.join(root, AGENTS_DIR),
    name: ref.name,
    relativePath: `${AGENTS_DIR}/${ref.name}`,
  };
};

/** Every `agents/*.md` entry, with whether the editor may open it. */
const listAgents = async (root: string): Promise<ReadonlyArray<OmpAgentFileEntry>> => {
  const dir = await checkedDir(root, NodePath.join(root, AGENTS_DIR), AGENTS_DIR);
  if (dir === undefined) return [];
  const entries = await NodeFSP.readdir(dir, { withFileTypes: true });
  const agents: OmpAgentFileEntry[] = [];
  for (const entry of entries) {
    // OMP loads files and links ending in `.md` (`task/discovery.ts` `loadAgentsFromDir`).
    if (!(entry.isFile() || entry.isSymbolicLink()) || !entry.name.endsWith(".md")) continue;
    let editable = OMP_AGENT_FILE_NAME_PATTERN.test(entry.name);
    if (editable && entry.isSymbolicLink()) {
      editable = await checkedFile(root, NodePath.join(dir, entry.name), entry.name).then(
        () => true,
        () => false,
      );
    }
    agents.push({ name: entry.name, editable });
  }
  return agents.toSorted((left, right) => left.name.localeCompare(right.name));
};

/** File operations on one agent directory, as `omp config path` printed it. */
export const ompAgentDirFiles = (agentDir: string) => {
  const list = async (): Promise<OmpAgentFilesList> => {
    const root = await realAgentDir(agentDir);
    const watchdog = await watchdogFileName(root);
    return {
      agentDir,
      watchdogFileName: watchdog,
      watchdogExists: (await lstatOrUndefined(NodePath.join(root, watchdog))) !== undefined,
      agents: await listAgents(root),
    };
  };

  /** The located file, with its folder checked; `create` makes a missing `agents/` folder. */
  const open = async (ref: OmpAgentFileRef, create: boolean) => {
    const root = await realAgentDir(agentDir);
    const located = await locate(root, ref);
    let dir = await checkedDir(root, located.dir, AGENTS_DIR);
    if (dir === undefined) {
      if (!create) return { root, located, checked: undefined };
      await NodeFSP.mkdir(located.dir, { mode: 0o755 }).catch((cause: unknown) => {
        if (errorCode(cause) !== "EEXIST") throw cause;
      });
      dir = await checkedDir(root, located.dir, AGENTS_DIR);
      if (dir === undefined) throw new Refusal("io_failed", `Could not create ${AGENTS_DIR}.`);
    }
    const checked = await checkedFile(root, NodePath.join(dir, located.name), located.relativePath);
    return { root, located, checked };
  };

  const read = async (ref: OmpAgentFileRef): Promise<OmpAgentFile> => {
    const { located, checked } = await open(ref, false);
    if (checked === undefined || !checked.exists) {
      return { file: ref, relativePath: located.relativePath };
    }
    const current = await readChecked(checked.file, located.relativePath);
    return {
      file: ref,
      relativePath: located.relativePath,
      content: current.content,
      version: current.version,
    };
  };

  const write = async (input: {
    readonly file: OmpAgentFileRef;
    readonly content: string;
    readonly baseVersion: string | undefined;
  }): Promise<OmpAgentFile> => {
    const bytes = Buffer.from(input.content, "utf8");
    if (bytes.length > OMP_AGENT_FILE_MAX_BYTES) {
      throw new Refusal("too_large", `The file is larger than ${OMP_AGENT_FILE_MAX_BYTES} bytes.`);
    }
    const { located, checked } = await open(input.file, true);
    if (checked === undefined)
      throw new Refusal("io_failed", `Could not open ${located.relativePath}.`);
    const current = checked.exists
      ? await readChecked(checked.file, located.relativePath)
      : undefined;
    if (current?.version !== input.baseVersion) {
      throw new Refusal(
        "conflict",
        current === undefined
          ? `${located.relativePath} was removed since it was opened.`
          : input.baseVersion === undefined
            ? `${located.relativePath} already exists.`
            : `${located.relativePath} changed since it was opened; reload it first.`,
      );
    }
    const temporary = NodePath.join(
      NodePath.dirname(checked.file),
      `.${NodePath.basename(checked.file)}.${NodeCrypto.randomUUID()}.tmp`,
    );
    try {
      await NodeFSP.writeFile(temporary, bytes, { flag: "wx", mode: current?.mode ?? 0o644 });
      await NodeFSP.rename(temporary, checked.file);
    } catch (cause) {
      await NodeFSP.rm(temporary, { force: true });
      throw cause;
    }
    return {
      file: input.file,
      relativePath: located.relativePath,
      content: input.content,
      version: sha256(bytes),
    };
  };

  const remove = async (input: {
    readonly file: OmpAgentFileRef;
    readonly baseVersion: string;
  }): Promise<OmpAgentFilesList> => {
    const { located, checked } = await open(input.file, false);
    if (checked === undefined || !checked.exists) {
      throw new Refusal("not_found", `${located.relativePath} does not exist.`);
    }
    const current = await readChecked(checked.file, located.relativePath);
    if (current.version !== input.baseVersion) {
      throw new Refusal(
        "conflict",
        `${located.relativePath} changed since it was opened; reload it first.`,
      );
    }
    // A link is removed, not the file it points to.
    await NodeFSP.unlink(checked.entry);
    return list();
  };

  return { list, read, write, remove };
};

const run = <A>(operation: string, use: () => Promise<A>) =>
  Effect.tryPromise({
    try: use,
    catch: (cause) =>
      cause instanceof Refusal
        ? new OmpAgentFilesOperationError({ reason: cause.reason, message: cause.message })
        : new OmpAgentFilesOperationError({
            reason: "io_failed",
            message: `Could not ${operation} in OMP's agent directory.`,
          }),
  });

export const makeOmpAgentFilesController = (input: {
  readonly control: Pick<OmpControlService, "configPath">;
  /** This instance's omp, resolved and verified for this call, run in `cwd`. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** A directory with no project config; the agent directory does not depend on it. */
  readonly globalCwd: string;
}): ProviderOmpAgentFilesController => {
  const files = input.target(input.globalCwd).pipe(
    Effect.flatMap(input.control.configPath),
    Effect.mapError(
      (error) => new OmpAgentFilesOperationError({ reason: "omp_failed", message: error.message }),
    ),
    Effect.map(ompAgentDirFiles),
  );
  return {
    list: files.pipe(Effect.flatMap((dir) => run("list files", dir.list))),
    read: (file) => files.pipe(Effect.flatMap((dir) => run("read the file", () => dir.read(file)))),
    write: (change) =>
      files.pipe(Effect.flatMap((dir) => run("write the file", () => dir.write(change)))),
    remove: (change) =>
      files.pipe(Effect.flatMap((dir) => run("delete the file", () => dir.remove(change)))),
  };
};
