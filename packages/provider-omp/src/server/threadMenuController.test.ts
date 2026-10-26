// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { makeOmpControlService, parseOmpShareOutput } from "./control.ts";
import { ompJournalPath } from "./journal.ts";
import { writeOmpThreadSessionRecord } from "./ompSessions.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { OmpRpcCommandError } from "./rpcProcess.ts";
import { ompStateDirs } from "./session.ts";
import { makeOmpThreadMenuController, OMP_COLLAB_CONTRACT } from "./threadMenuController.ts";
import type { OmpThreadSession } from "./threadSessions.ts";
import { makeOmpThreadSessions } from "./threadSessions.ts";
import { fakeOmpFrames, makeFakeOmpState, waitUntil } from "./testing/fakeOmp.ts";
import {
  makeFakeOmpControl,
  type FakeOmpControl,
  type FakeOmpControlScript,
} from "./testing/fakeOmpControl.ts";
import {
  JOURNAL_INSTANCE_ID,
  JOURNAL_THREAD_ID,
  journalModelSelection,
  journalRuntimePolicy,
  journalTurnInput,
} from "./testing/journalFixtures.ts";

// The fake omp and gh are `#!/bin/sh` scripts.
const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const THREAD = ThreadId.make("thread/menu");
const FILE_ID = "a1b2c3d4";
const PAGE = "<!doctype html><title>exported</title>";

/**
 * `omp share --gist` as the pinned omp prints it (commands/share.ts), with fake ids: the link is
 * `<share.serverUrl>/<gist id>#<key>`, so under Ompanel's overlay it is on the blocked host.
 */
const SHARE_STDOUT = [
  "Share URL: https://share-server-disabled.invalid/0f3a9c#k=fake-key",
  "Gist: https://gist.github.com/tester/0f3a9c",
  "",
].join("\n");

/** A request stub standing in for a running thread's process; records what it was sent. */
const runningSession = (
  answer: (command: string, params: unknown) => Effect.Effect<unknown, OmpRpcCommandError>,
) => {
  const sent: Array<{ readonly command: string; readonly params: unknown }> = [];
  const request = (command: string, params: unknown) => {
    sent.push({ command, params });
    return answer(command, params);
  };
  const session: OmpThreadSession = {
    threadId: THREAD,
    providerSessionId: ProviderSessionId.make("session-menu"),
    cwd: "/work",
    // The stub answers whatever the test scripts; the real process is typed per command.
    process: { request: request as unknown as OmpThreadSession["process"]["request"] },
    onRestartRequired: () => Effect.void,
    isBusy: () => false,
  };
  return { session, sent };
};

const makeHarness = Effect.fnUntraced(function* (
  omp: FakeOmpControl,
  options: {
    readonly running?: OmpThreadSession;
    readonly contractVersion?: string;
    readonly gh?: "ready" | "signed_out" | "missing";
    readonly cli?: FakeOmpControlScript["cli"];
  } = {},
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "omp-thread-menu-" });
  const threadsDir = path.join(root, "threads");
  const exportsDir = path.join(root, "exports");
  const control = yield* makeOmpControlService();
  const target = omp.target(
    { cli: options.cli ?? {} },
    options.gh === undefined ? {} : { gh: options.gh },
  );
  const menu = makeOmpThreadMenuController({
    control,
    target: () => Effect.succeed(target),
    globalCwd: omp.workspace,
    exportsDir,
    threadsDir,
    sessionsLocation: { root: path.join(root, "sessions"), flat: false },
    sessions: { get: (threadId) => (threadId === THREAD ? options.running : undefined) },
    contractVersion: options.contractVersion ?? "1.6.0",
    ompVersion: "18.12.6-ompanel.3",
    fileSystem,
    path,
  });
  /** A session file for the thread, recorded as the one it last ran. */
  const recordSession = Effect.gen(function* () {
    const file = path.join(root, "sessions", "bucket", `2026-10-27T10-00-00-000Z_${FILE_ID}.jsonl`);
    yield* fileSystem.makeDirectory(path.dirname(file), { recursive: true });
    yield* fileSystem.writeFileString(
      file,
      `${JSON.stringify({ type: "session", version: 3, id: FILE_ID, cwd: "/work", timestamp: "2026-10-27T10:00:00.000Z" })}\n`,
    );
    yield* writeOmpThreadSessionRecord(threadsDir, {
      threadId: THREAD,
      sessionId: FILE_ID,
      reportedSessionId: FILE_ID,
      sessionFile: file,
    });
    return file;
  });
  return { menu, exportsDir, recordSession, fileSystem };
});

describe("parseOmpShareOutput", () => {
  it("reads the share URL, the gist and the trim note", () => {
    assert.deepStrictEqual(
      parseOmpShareOutput(
        `${SHARE_STDOUT}Note: large content was trimmed to fit the share size limit.\n`,
      ),
      {
        url: "https://share-server-disabled.invalid/0f3a9c#k=fake-key",
        gistUrl: "https://gist.github.com/tester/0f3a9c",
        truncated: true,
      },
    );
    assert.deepStrictEqual(parseOmpShareOutput("Share URL: https://my.omp.sh/s/1#k=x\n"), {
      url: "https://my.omp.sh/s/1#k=x",
      gistUrl: null,
      truncated: false,
    });
    assert.isNull(parseOmpShareOutput("Session not found.\n"));
  });
});

posixOnly("OMP thread menu", () => {
  it.effect("exports an idle thread's session file with `omp --export` and cleans up", () =>
    Effect.gen(function* () {
      const omp = yield* makeFakeOmpControl;
      const { menu, exportsDir, recordSession, fileSystem } = yield* makeHarness(omp, {
        cli: { "--export": { stdout: "Exported to: out.html\n", html: PAGE } },
      });
      const missing = yield* menu.exportHtml(THREAD).pipe(Effect.flip);
      assert.strictEqual(missing.reason, "no_session");

      const file = yield* recordSession;
      const page = yield* menu.exportHtml(THREAD);
      assert.deepStrictEqual(page, { fileName: `omp-session-${FILE_ID}.html`, html: PAGE });
      const exported = omp.starts().at(-1);
      assert.deepStrictEqual(exported?.argv.slice(0, 2), ["--export", file]);
      assert.include(exported?.argv[2] ?? "", exportsDir);
      // The rendered page is read and removed; nothing stays behind.
      assert.deepStrictEqual(yield* fileSystem.readDirectory(exportsDir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("exports a running thread with RPC `export_html` into its own scratch file", () =>
    Effect.gen(function* () {
      const omp = yield* makeFakeOmpControl;
      const fs = yield* FileSystem.FileSystem;
      const { session, sent } = runningSession((command, params) => {
        if (command === "get_state") {
          return Effect.succeed({ sessionId: "s", sessionFile: `/omp/b/x_${FILE_ID}.jsonl` });
        }
        const { outputPath } = params as { readonly outputPath: string };
        return fs
          .writeFileString(outputPath, PAGE)
          .pipe(Effect.as({ path: outputPath }), Effect.orDie);
      });
      const { menu, exportsDir, fileSystem } = yield* makeHarness(omp, { running: session });
      const page = yield* menu.exportHtml(THREAD);
      assert.deepStrictEqual(page, { fileName: `omp-session-${FILE_ID}.html`, html: PAGE });
      assert.deepStrictEqual(
        sent.map((entry) => entry.command),
        ["get_state", "export_html"],
      );
      assert.lengthOf(omp.starts(), 0);
      assert.deepStrictEqual(yield* fileSystem.readDirectory(exportsDir), []);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("refuses Share gist before anything uploads unless gh is signed in", () =>
    Effect.gen(function* () {
      const omp = yield* makeFakeOmpControl;
      for (const gh of ["missing", "signed_out"] as const) {
        const { menu, recordSession } = yield* makeHarness(omp, {
          gh,
          cli: { share: { stdout: SHARE_STDOUT } },
        });
        yield* recordSession;
        const refused = yield* menu.shareGist(THREAD).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "gh_unavailable");
        assert.include(refused.message, "Nothing was uploaded");
      }
      // `omp share` never started.
      assert.isFalse(omp.starts().some((start) => start.argv.includes("share")));

      const { menu, recordSession } = yield* makeHarness(omp, {
        gh: "ready",
        cli: { share: { stdout: SHARE_STDOUT } },
      });
      const file = yield* recordSession;
      const shared = yield* menu.shareGist(THREAD);
      // The link is rebuilt on OMP's own viewer, whatever host the share server setting named.
      assert.deepStrictEqual(shared, {
        url: "https://my.omp.sh/s/0f3a9c#k=fake-key",
        gistUrl: "https://gist.github.com/tester/0f3a9c",
        truncated: false,
      });
      const share = omp.starts().at(-1);
      assert.deepStrictEqual(share?.argv, ["share", file, "--gist"]);
      // The overlay outranks project settings, so a repo's `share.serverUrl` never applies.
      assert.strictEqual(
        share?.overlay,
        'share:\n  serverUrl: "https://share-server-disabled.invalid"\n  store: gist\n',
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("never returns a link that is not Ompanel's gist on OMP's viewer", () =>
    Effect.gen(function* () {
      const omp = yield* makeFakeOmpControl;
      const outputs = [
        // The gist failed and the fallback upload to the blocked host failed: omp exits 1.
        { stdout: "", stderr: "Error: fetch failed\n", exitCode: 1 },
        // A share-server upload (no gist) or a link on another host: refused, never passed on.
        { stdout: "Share URL: https://share-server-disabled.invalid/abc#k=x\n" },
        {
          stdout:
            "Share URL: https://evil.example/0f3a9c#k=x\nGist: https://gist.github.com/t/0f3a9c\n",
        },
      ];
      for (const output of outputs) {
        const { menu, recordSession } = yield* makeHarness(omp, {
          gh: "ready",
          cli: { share: output },
        });
        yield* recordSession;
        const refused = yield* menu.shareGist(THREAD).pipe(Effect.flip);
        assert.strictEqual(refused.reason, "omp_failed");
        if (output.exitCode === 1) assert.include(refused.message, "Nothing was uploaded");
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("says Share live needs a newer OMP on a contract without the collab RPC", () =>
    Effect.gen(function* () {
      const omp = yield* makeFakeOmpControl;
      const { session, sent } = runningSession(() => Effect.die("no collab RPC on 1.6.0"));
      const { menu } = yield* makeHarness(omp, { running: session, contractVersion: "1.6.0" });
      const started = yield* menu
        .startCollab({ threadId: THREAD, access: "view" })
        .pipe(Effect.flip);
      assert.strictEqual(started.reason, "needs_newer_omp");
      assert.include(started.message, OMP_COLLAB_CONTRACT);
      assert.include(started.message, "18.12.6-ompanel.3");
      const status = yield* menu.collabStatus(THREAD).pipe(Effect.flip);
      assert.strictEqual(status.reason, "needs_newer_omp");
      assert.deepStrictEqual(yield* menu.stopCollab(THREAD), { stopped: false });
      assert.lengthOf(sent, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("starts, reads and stops a room in the running session; idle threads have none", () =>
    Effect.gen(function* () {
      const omp = yield* makeFakeOmpControl;
      const idle = yield* makeHarness(omp, { contractVersion: "1.7.0" });
      const notRunning = yield* idle.menu
        .startCollab({ threadId: THREAD, access: "view" })
        .pipe(Effect.flip);
      assert.strictEqual(notRunning.reason, "not_running");
      assert.deepStrictEqual(yield* idle.menu.collabStatus(THREAD), {
        active: false,
        participants: [],
      });
      assert.strictEqual(
        (yield* idle.menu.branchTree(THREAD).pipe(Effect.flip)).reason,
        "not_running",
      );

      const room = {
        active: true,
        access: "view",
        link: "omp://join/room#read",
        webLink: "https://my.omp.sh/#room.read",
        relayConnected: true,
        participants: [{ name: "host", role: "host" }],
        // Fields T3 does not know are dropped, never passed on.
        writeToken: "never-forwarded",
      };
      const { session, sent } = runningSession((command) =>
        command === "collab_stop"
          ? Effect.succeed({ stopped: true })
          : command === "get_tree"
            ? Effect.succeed({ tree: [], leafId: null })
            : Effect.succeed(room),
      );
      const { menu } = yield* makeHarness(omp, { running: session, contractVersion: "1.7.0" });
      const started = yield* menu.startCollab({ threadId: THREAD, access: "view" });
      assert.strictEqual(started.webLink, "https://my.omp.sh/#room.read");
      assert.notProperty(started, "writeToken");
      assert.deepStrictEqual(sent[0], { command: "collab_start", params: { access: "view" } });
      assert.isTrue((yield* menu.collabStatus(THREAD)).active);
      assert.deepStrictEqual(yield* menu.stopCollab(THREAD), { stopped: true });
      assert.deepStrictEqual(yield* menu.branchTree(THREAD), {
        nodes: [],
        leafId: null,
        activePath: [],
      });
      assert.deepStrictEqual(
        sent.map((entry) => entry.command),
        ["collab_start", "collab_status", "collab_stop", "get_tree"],
      );

      const broken = runningSession(() =>
        Effect.fail(new OmpRpcCommandError({ command: "collab_start", detail: "no relay" })),
      );
      const failing = yield* makeHarness(omp, {
        running: broken.session,
        contractVersion: "1.7.0",
      });
      const failed = yield* failing.menu
        .startCollab({ threadId: THREAD, access: "control" })
        .pipe(Effect.flip);
      assert.strictEqual(failed.reason, "omp_failed");
      assert.include(failed.message, "no relay");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

/** Every log line the effect writes, as structured JSON (message, annotations, spans, cause). */
const captureLogs = () => {
  const lines: Array<string> = [];
  const logger = Logger.map(Logger.formatJson, (line) => void lines.push(line));
  return {
    lines,
    provide: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(Logger.layer([logger])),
        Effect.provideService(References.MinimumLogLevel, "All"),
      ),
  };
};

posixOnly("OMP collab links stay out of the journal and the logs", () => {
  it.live(
    "keeps links, late answers included, out of the journal and logs; stops a lost start",
    () => {
      const token = "fake-collab-token-7c1e";
      const logs = captureLogs();
      return Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const path = yield* Path.Path;
        const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
        const threadSessions = makeOmpThreadSessions();
        const prompt = [...fakeOmpFrames.promptTurn({ text: ["Hi"] })];
        const promptResult = prompt.pop()!;
        const adapter = yield* makeOmpAdapter({
          instanceId: JOURNAL_INSTANCE_ID,
          profile: "",
          environment: state.env({
            ...state.sessionStore(),
            FAKE_OMP_CONTRACT: "1.7.0",
            FAKE_OMP_COLLAB_TOKEN: token,
            // A slow relay: room answers come after the short deadlines below.
            FAKE_OMP_COLLAB_DELAY_MS: "400",
            ...state.script({
              commands: {
                prompt: [
                  ...prompt,
                  // A misbehaving OMP: a room frame mid-turn that carries the control link.
                  {
                    emit: {
                      type: "collab_state",
                      active: true,
                      participantCount: 1,
                      link: `omp://join/fake-room#${token}.write`,
                    },
                  },
                  // The turn stays open while the room calls below run, so late answers land in it.
                  { sleepMs: 2_500 },
                  promptResult,
                ],
              },
            }),
          }),
          platform,
          defaultCwd: state.dir,
          resolveBinary: Effect.succeed(state.executable()),
          dirs,
          pidfiles: yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform }),
          expectedContractVersion: "1.7.0",
          threadSessions,
          sessions: state.sessions,
        }).pipe(
          Effect.provideService(ProviderContinuationRequests.ProviderContinuationRequests, {
            offer: () => Effect.void,
            take: Effect.never,
          }),
        );
        const menu = makeOmpThreadMenuController({
          control: yield* makeOmpControlService(),
          target: () => Effect.die("no CLI in this test"),
          globalCwd: state.dir,
          exportsDir: NodePath.join(state.dir, "exports"),
          threadsDir: dirs.threads,
          sessionsLocation: state.sessions,
          sessions: threadSessions,
          contractVersion: "1.7.0",
          ompVersion: "test",
          fileSystem: yield* FileSystem.FileSystem,
          path,
        });
        // The same thread through deadlines shorter than the relay's answers.
        const impatient = makeOmpThreadMenuController({
          control: yield* makeOmpControlService(),
          target: () => Effect.die("no CLI in this test"),
          globalCwd: state.dir,
          exportsDir: NodePath.join(state.dir, "exports"),
          threadsDir: dirs.threads,
          sessionsLocation: state.sessions,
          sessions: threadSessions,
          contractVersion: "1.7.0",
          ompVersion: "test",
          fileSystem: yield* FileSystem.FileSystem,
          path,
          timeoutsMs: { collabStart: 100, collab: 100 },
        });

        const outer = yield* Effect.scope;
        const turns: Array<string> = [];
        const collector = yield* Effect.gen(function* () {
          const session = yield* adapter.openSession({
            threadId: JOURNAL_THREAD_ID,
            providerSessionId: ProviderSessionId.make("session-collab"),
            modelSelection: journalModelSelection,
            runtimePolicy: journalRuntimePolicy,
          });
          const fiber = yield* session.events.pipe(
            Stream.runForEach((event) =>
              Effect.sync(() => {
                if (event.type === "turn.terminal") turns.push(event.type);
              }),
            ),
            Effect.forkIn(outer),
          );
          const providerThread = yield* session.ensureThread({
            threadId: JOURNAL_THREAD_ID,
            modelSelection: journalModelSelection,
            runtimePolicy: journalRuntimePolicy,
          });
          yield* session.startTurn(journalTurnInput(providerThread, 1, yield* DateTime.now));
          assert.isTrue(yield* waitUntil(() => state.events().includes("command:prompt")));

          // A start that times out is stopped: OMP cancels it, and no room is left open.
          const lost = yield* impatient
            .startCollab({ threadId: JOURNAL_THREAD_ID, access: "control" })
            .pipe(Effect.flip);
          assert.strictEqual(lost.reason, "timeout");
          assert.isTrue(yield* waitUntil(() => state.events().includes("command:collab_stop")));
          assert.isFalse((yield* menu.collabStatus(JOURNAL_THREAD_ID)).active);

          const started = yield* menu.startCollab({
            threadId: JOURNAL_THREAD_ID,
            access: "control",
          });
          assert.include(started.link ?? "", token);
          assert.include(started.webLink ?? "", token);
          // A status read that gives up; its answer, links and all, arrives later mid-turn.
          const late = yield* impatient.collabStatus(JOURNAL_THREAD_ID).pipe(Effect.flip);
          assert.strictEqual(late.reason, "timeout");
          // The fake wrote that answer (its second status answer) after the read gave up.
          assert.isTrue(
            yield* waitUntil(
              () =>
                state.events().filter((event) => event === "collab-answer:collab_status").length ===
                2,
            ),
          );
          assert.lengthOf(turns, 0, "the late answers arrived while the turn ran");
          assert.deepStrictEqual(yield* menu.stopCollab(JOURNAL_THREAD_ID), { stopped: true });
          assert.isTrue(yield* waitUntil(() => turns.length === 1));
          return fiber;
        }).pipe(Effect.scoped);
        yield* Fiber.await(collector);

        const journal = NodeFS.readFileSync(
          ompJournalPath(path, dirs.threads, JOURNAL_THREAD_ID),
          "utf8",
        );
        // The turn was journaled; the frame with the link was not.
        assert.include(journal, '"k":"turn"');
        assert.notInclude(journal, token);
        assert.notInclude(journal, "collab_");
        // The adapter saw the room frames (it logs their type) and logged no link.
        assert.isTrue(logs.lines.some((line) => line.includes("collab_state")));
        assert.isFalse(logs.lines.some((line) => line.includes(token)));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer), logs.provide);
    },
  );
});
