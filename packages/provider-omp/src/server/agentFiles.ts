// @effect-diagnostics nodeBuiltinImport:off - path validation needs `lstat` and an `O_NOFOLLOW` open, which Effect's FileSystem does not expose.
/**
 * Files in the agent directory `omp config path` prints for the instance. Nothing outside it is
 * reached: names follow fixed patterns, links must resolve inside, and a write replaces the file
 * by rename only while it is still at the version the editor read.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import {
  OMP_AGENT_FILE_MAX_BYTES,
  OMP_AGENT_FILE_NAME_PATTERN,
  OmpAgentFilesOperationError,
  ompCustomizationPathAllowed,
  type OmpAgentFile,
  type OmpAgentFileEntry,
  type OmpAgentFileRef,
  type OmpAgentFilesList,
  type OmpAgentFilesOperationErrorReason,
  type OmpCustomizationCategory,
  type OmpCustomizationEntry,
  type OmpMcpFileName,
  type OmpMcpFileState,
  type OmpMcpServerEntry,
} from "@t3tools/contracts";
import type { ProviderOmpAgentFilesController } from "@t3tools/provider-core/server/driver";
import * as Effect from "effect/Effect";

import type { OmpControlService, OmpControlTarget } from "./control.ts";
import { checkOmpModelsConfig } from "./modelsCheck.ts";
import type { OmpSidecarError } from "./sidecar.ts";

const WATCHDOG_YML = "WATCHDOG.yml";
const WATCHDOG_YAML = "WATCHDOG.yaml";
const MODELS_YML = "models.yml";
const MODELS_YAML = "models.yaml";
const MODELS_JSON = "models.json";
const AGENTS_DIR = "agents";
const MCP_FILES: ReadonlyArray<OmpMcpFileName> = ["mcp.json", ".mcp.json"];

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

/**
 * The folder `folders` names under the agent directory, each level checked like
 * {@link checkedDir}; undefined when one is missing, or created (`0o755`) when `create` is set.
 */
const checkedFolders = async (
  root: string,
  folders: ReadonlyArray<string>,
  create: boolean,
): Promise<string | undefined> => {
  let dir = root;
  for (let depth = 0; depth < folders.length; depth++) {
    const label = folders.slice(0, depth + 1).join("/");
    const next = NodePath.join(dir, folders[depth]!);
    let checked = await checkedDir(root, next, label);
    if (checked === undefined) {
      if (!create) return undefined;
      await NodeFSP.mkdir(next, { mode: 0o755 }).catch((cause: unknown) => {
        if (errorCode(cause) !== "EEXIST") throw cause;
      });
      checked = await checkedDir(root, next, label);
      if (checked === undefined) throw new Refusal("io_failed", `Could not create ${label}.`);
    }
    dir = checked;
  }
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
  /** Folders between the agent directory and the file, as OMP names them (not yet resolved). */
  readonly folders: ReadonlyArray<string>;
  readonly name: string;
  readonly relativePath: string;
  /** Permissions of a new file: owner-only for files that may hold credentials. */
  readonly createMode: number;
}

const exists = async (filePath: string) => (await lstatOrUndefined(filePath)) !== undefined;

/**
 * `preferred`, unless only `fallback` exists: OMP reads `WATCHDOG.yaml` and `models.yaml` when
 * the `.yml` file is missing (`resolveAdvisorConfigFile`, `ConfigFile`), and edits them in place.
 */
const yamlFileName = async <A extends string, B extends string>(
  root: string,
  preferred: A,
  fallback: B,
): Promise<A | B> =>
  !(await exists(NodePath.join(root, preferred))) && (await exists(NodePath.join(root, fallback)))
    ? fallback
    : preferred;

const locate = async (root: string, ref: OmpAgentFileRef): Promise<Located> => {
  switch (ref.kind) {
    case "watchdog": {
      const name = await yamlFileName(root, WATCHDOG_YML, WATCHDOG_YAML);
      return { folders: [], name, relativePath: name, createMode: 0o644 };
    }
    case "models": {
      const name = await yamlFileName(root, MODELS_YML, MODELS_YAML);
      // Inline API keys live here; OMP writes it owner-only too.
      return { folders: [], name, relativePath: name, createMode: 0o600 };
    }
    case "mcp":
      // The contract checks the name; this keeps the module safe on its own.
      if (!MCP_FILES.includes(ref.name)) {
        throw new Refusal("not_editable", `${ref.name} is not an MCP file OMP reads.`);
      }
      // Server headers and environments can carry tokens.
      return { folders: [], name: ref.name, relativePath: ref.name, createMode: 0o600 };
    case "agent":
      if (!OMP_AGENT_FILE_NAME_PATTERN.test(ref.name)) {
        throw new Refusal("not_editable", `${ref.name} is not a plain agent file name.`);
      }
      return {
        folders: [AGENTS_DIR],
        name: ref.name,
        relativePath: `${AGENTS_DIR}/${ref.name}`,
        createMode: 0o644,
      };
    case "custom": {
      if (!ompCustomizationPathAllowed(ref.category, ref.path)) {
        throw new Refusal("not_editable", `${ref.path} is not a ${ref.category} file OMP loads.`);
      }
      const parts = ref.path.split("/");
      return {
        folders: parts.slice(0, -1),
        name: parts.at(-1)!,
        relativePath: ref.path,
        createMode: 0o644,
      };
    }
  }
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

/**
 * The folder at `relative` (slash-separated) for listing: undefined when it is missing, or a link
 * that leaves the agent directory, which OMP may still follow but Ompanel does not.
 */
const listableFolder = (root: string, relative: string) =>
  checkedFolders(root, relative.split("/"), false).catch((cause: unknown) => {
    if (cause instanceof Refusal) return undefined;
    throw cause;
  });

/** Whether the editor may open `path`: an allowed name, and a file that stays inside. */
const editableEntry = async (
  root: string,
  category: OmpCustomizationCategory,
  path: string,
  entry: string,
) =>
  ompCustomizationPathAllowed(category, path) &&
  (await checkedFile(root, entry, path).then(
    (checked) => checked.exists,
    () => false,
  ));

/**
 * The files OMP loads from `relative`: entries that are files or links, not hidden, that
 * `accept` takes (`discovery/builtin.ts` `loadFilesFromDir`, `loadHooks`, `loadTools`).
 */
const listFiles = async (
  root: string,
  category: OmpCustomizationCategory,
  relative: string,
  accept: (name: string) => boolean,
): Promise<OmpCustomizationEntry[]> => {
  const dir = await listableFolder(root, relative);
  if (dir === undefined) return [];
  const items: OmpCustomizationEntry[] = [];
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!(entry.isFile() || entry.isSymbolicLink()) || !accept(entry.name)) continue;
    const path = `${relative}/${entry.name}`;
    items.push({
      category,
      path,
      editable: await editableEntry(root, category, path, NodePath.join(dir, entry.name)),
    });
  }
  return items;
};

/**
 * `<relative>/<folder>/<file>` for each folder (or link to one) holding `file`: skills
 * (`<name>/SKILL.md`) and folder tools (`<name>/index.ts`).
 */
const listFolderFiles = async (
  root: string,
  category: OmpCustomizationCategory,
  relative: string,
  file: string,
): Promise<OmpCustomizationEntry[]> => {
  const dir = await listableFolder(root, relative);
  if (dir === undefined) return [];
  const items: OmpCustomizationEntry[] = [];
  for (const entry of await NodeFSP.readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    if (!(entry.isDirectory() || entry.isSymbolicLink())) continue;
    const folder = await listableFolder(root, `${relative}/${entry.name}`);
    if (folder === undefined) continue;
    const filePath = NodePath.join(folder, file);
    if (!(await exists(filePath))) continue;
    const path = `${relative}/${entry.name}/${file}`;
    items.push({ category, path, editable: await editableEntry(root, category, path, filePath) });
  }
  return items;
};

const TOOL_FILE = /\.(?:json|md|ts|js|sh|bash|py)$/;

/** Skills, rules, prompt templates, hooks and custom tools of the agent directory. */
const listCustomization = async (root: string): Promise<ReadonlyArray<OmpCustomizationEntry>> => {
  const rulesFile = NodePath.join(root, "RULES.md");
  const groups = await Promise.all([
    listFolderFiles(root, "skill", "skills", "SKILL.md"),
    listFolderFiles(root, "skill", "managed-skills", "SKILL.md"),
    exists(rulesFile).then(async (found) =>
      found
        ? [
            {
              category: "rule" as const,
              path: "RULES.md",
              editable: await editableEntry(root, "rule", "RULES.md", rulesFile),
            },
          ]
        : [],
    ),
    listFiles(root, "rule", "rules", (name) => /\.(?:md|mdc)$/.test(name)),
    listFiles(root, "prompt", "prompts", (name) => name.endsWith(".md")),
    listFiles(root, "hook", "hooks/pre", () => true),
    listFiles(root, "hook", "hooks/post", () => true),
    listFiles(root, "tool", "tools", (name) => TOOL_FILE.test(name)),
    listFolderFiles(root, "tool", "tools", "index.ts"),
  ]);
  return groups.flat().toSorted((left, right) => left.path.localeCompare(right.path));
};

/** A remote server's URL without credentials or query, which can carry tokens. */
const safeUrl = (value: string) => {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return undefined;
  }
};

/**
 * The servers of one MCP file as OMP reads them (`discovery/builtin.ts` `loadMCPServers`): the
 * `mcpServers` record of a JSON object. Only the name, transport, command or URL and `enabled`
 * are kept; arguments, headers and environments can hold secrets.
 */
const parseMcpServers = (content: string, file: OmpMcpFileName) => {
  let data: unknown;
  try {
    data = JSON.parse(content);
  } catch {
    return undefined;
  }
  if (typeof data !== "object" || data === null) return undefined;
  const record = "mcpServers" in data ? data.mcpServers : undefined;
  if (typeof record !== "object" || record === null || Array.isArray(record)) return [];
  const servers: OmpMcpServerEntry[] = [];
  for (const [name, value] of Object.entries(record)) {
    if (typeof value !== "object" || value === null) continue;
    const config = value as Record<string, unknown>;
    const url = typeof config["url"] === "string" ? safeUrl(config["url"]) : undefined;
    const type = config["type"];
    const transport =
      type === "http" || type === "sse" || type === "stdio" ? type : url ? "http" : "stdio";
    const command = typeof config["command"] === "string" ? config["command"] : undefined;
    const target = transport === "stdio" ? command : url;
    const enabled = config["enabled"];
    servers.push({
      name,
      file,
      transport,
      ...(target === undefined ? {} : { target }),
      disabled:
        enabled === false ||
        (typeof enabled === "string" && ["false", "0"].includes(enabled.toLowerCase())),
    });
  }
  return servers;
};

/** Both MCP files and the servers OMP would load from them. */
const listMcp = async (root: string) => {
  const files: OmpMcpFileState[] = [];
  const servers: OmpMcpServerEntry[] = [];
  for (const name of MCP_FILES) {
    const entry = NodePath.join(root, name);
    if (!(await exists(entry))) {
      files.push({ name, exists: false });
      continue;
    }
    const read = await checkedFile(root, entry, name)
      .then((checked) => readChecked(checked.file, name))
      .catch((cause: unknown) => {
        if (cause instanceof Refusal) return undefined;
        throw cause;
      });
    if (read === undefined) {
      files.push({ name, exists: true, problem: "not_editable" });
      continue;
    }
    const parsed = parseMcpServers(read.content, name);
    if (parsed === undefined) {
      files.push({ name, exists: true, problem: "invalid_json" });
      continue;
    }
    files.push({ name, exists: true });
    servers.push(...parsed);
  }
  return { files, servers };
};

/** File operations on one agent directory, as `omp config path` printed it. */
export const ompAgentDirFiles = (agentDir: string) => {
  const list = async (): Promise<OmpAgentFilesList> => {
    const root = await realAgentDir(agentDir);
    const watchdog = await yamlFileName(root, WATCHDOG_YML, WATCHDOG_YAML);
    const models = await yamlFileName(root, MODELS_YML, MODELS_YAML);
    const modelsExists = await exists(NodePath.join(root, models));
    const mcp = await listMcp(root);
    return {
      agentDir,
      watchdogFileName: watchdog,
      watchdogExists: await exists(NodePath.join(root, watchdog)),
      agents: await listAgents(root),
      modelsFileName: models,
      modelsExists,
      modelsLegacyJson: !modelsExists && (await exists(NodePath.join(root, MODELS_JSON))),
      mcpFiles: mcp.files,
      mcpServers: mcp.servers,
      customization: await listCustomization(root),
    };
  };

  /** The located file, with its folders checked; `create` makes missing folders. */
  const open = async (ref: OmpAgentFileRef, create: boolean) => {
    const root = await realAgentDir(agentDir);
    const located = await locate(root, ref);
    const dir = await checkedFolders(root, located.folders, create);
    if (dir === undefined) return { root, located, checked: undefined };
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
    if (input.file.kind === "models" && input.baseVersion === undefined) {
      const root = await realAgentDir(agentDir);
      if (
        !(await exists(NodePath.join(root, MODELS_YML))) &&
        !(await exists(NodePath.join(root, MODELS_YAML))) &&
        (await exists(NodePath.join(root, MODELS_JSON)))
      ) {
        throw new Refusal(
          "not_editable",
          "OMP still has a legacy models.json; start OMP once so it migrates it to models.yml, then edit that.",
        );
      }
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
      await NodeFSP.writeFile(temporary, bytes, {
        flag: "wx",
        mode: current?.mode ?? located.createMode,
      });
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
  readonly control: Pick<OmpControlService, "configPath" | "modelsInAgentDir" | "agentsUnpack">;
  /** This instance's omp, resolved and verified for this call, run in `cwd`. */
  readonly target: (cwd: string) => Effect.Effect<OmpControlTarget, OmpSidecarError>;
  /** A directory with no project config; the agent directory does not depend on it. */
  readonly globalCwd: string;
}): ProviderOmpAgentFilesController => {
  const ompFailed = (error: { readonly message: string }) =>
    new OmpAgentFilesOperationError({ reason: "omp_failed", message: error.message });
  const target = input.target(input.globalCwd).pipe(Effect.mapError(ompFailed));
  const files = target.pipe(
    Effect.flatMap((resolved) => input.control.configPath(resolved)),
    Effect.mapError(ompFailed),
    Effect.map(ompAgentDirFiles),
  );
  return {
    list: files.pipe(Effect.flatMap((dir) => run("list files", dir.list))),
    read: (file) => files.pipe(Effect.flatMap((dir) => run("read the file", () => dir.read(file)))),
    write: (change) =>
      change.file.kind === "models"
        ? Effect.gen(function* () {
            // OMP loads the new text in a scratch agent directory first; the file is untouched
            // unless it passes.
            const checkedModels = yield* checkOmpModelsConfig({
              control: input.control,
              target: yield* target,
              content: change.content,
            });
            const dir = yield* files;
            const written = yield* run("write the file", () => dir.write(change));
            return { ...written, checkedModels };
          })
        : files.pipe(Effect.flatMap((dir) => run("write the file", () => dir.write(change)))),
    remove: (change) =>
      files.pipe(Effect.flatMap((dir) => run("delete the file", () => dir.remove(change)))),
    unpackAgents: Effect.gen(function* () {
      const resolved = yield* target;
      const result = yield* input.control.agentsUnpack(resolved).pipe(Effect.mapError(ompFailed));
      const dir = yield* files;
      const listed = yield* run("list files", dir.list);
      return {
        written: result.written.map((file) => NodePath.basename(file)),
        skipped: result.skipped.map((file) => NodePath.basename(file)),
        files: listed,
      };
    }),
  };
};
