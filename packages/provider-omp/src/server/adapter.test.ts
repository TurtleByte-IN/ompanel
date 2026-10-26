// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { ProviderInstanceId, ProviderSessionId, ThreadId } from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

import { makeOmpAdapter } from "./adapter.ts";
import { OMP_EMPTY_OVERLAY, ompApprovalModeFor, ompSessionArgs } from "./launch.ts";
import { makeOmpPidfiles } from "./pidfiles.ts";
import { ompStateDirs } from "./session.ts";
import { type FakeOmpState, makeFakeOmpState } from "./testing/fakeOmp.ts";

// Process groups and the `#!/bin/sh` fake omp are POSIX; Windows trees are job objects.
const platform = HostProcess.Platform.defaultValue();
const posixOnly = describe.skipIf(platform === "win32");

const makeAdapter = (state: FakeOmpState, profile: string, vars: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const path = yield* Path.Path;
    const dirs = ompStateDirs(path, NodePath.join(state.dir, "state"));
    const pidfiles = yield* makeOmpPidfiles({ dir: dirs.pidfiles, platform: platform });
    const binaryPath = state.executable();
    const adapter = yield* makeOmpAdapter({
      instanceId: ProviderInstanceId.make("omp-work"),
      profile,
      environment: state.env(vars),
      platform: platform,
      defaultCwd: state.dir,
      resolveBinary: Effect.succeed(binaryPath),
      dirs,
      pidfiles,
      expectedContractVersion: "1.0.0",
    });
    return { adapter, dirs };
  });

const openInput = (cwd: string, runtimeMode: "approval-required" | "full-access") => ({
  threadId: ThreadId.make("thread/1"),
  providerSessionId: ProviderSessionId.make("session-1"),
  modelSelection: { instanceId: ProviderInstanceId.make("omp-work"), model: "default" },
  runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy.make({
    runtimeMode,
    interactionMode: "default",
    cwd,
  }),
});

describe("OMP launch arguments", () => {
  it("maps runtime modes to explicit approval modes", () => {
    assert.strictEqual(ompApprovalModeFor("approval-required"), "always-ask");
    assert.strictEqual(ompApprovalModeFor("auto-accept-edits"), "write");
    assert.strictEqual(ompApprovalModeFor("full-access"), "yolo");
    // Auto is not offered for OMP and must never widen permissions.
    assert.strictEqual(ompApprovalModeFor("auto"), "always-ask");
  });

  it("leaves out --profile for the default profile", () => {
    assert.deepStrictEqual(
      ompSessionArgs({ approvalMode: "yolo", profile: "", overlayPath: "/o.yml", cwd: "/w" }),
      ["--mode", "rpc-ui", "--approval-mode", "yolo", "--config", "/o.yml", "--cwd", "/w"],
    );
  });
});

posixOnly("OmpAdapter.openSession", () => {
  it.live(
    "spawns omp --mode rpc-ui with the thread's approval mode, profile, overlay and cwd",
    () =>
      Effect.gen(function* () {
        const state = yield* makeFakeOmpState;
        const work = NodePath.join(state.dir, "work tree");
        NodeFS.mkdirSync(work);
        const { adapter, dirs } = yield* makeAdapter(state, "work");

        const updates = yield* Effect.gen(function* () {
          const session = yield* adapter.openSession(openInput(work, "approval-required"));
          assert.strictEqual(session.providerSession.status, "ready");
          assert.strictEqual(session.providerSession.cwd, work);

          const overlayPath = NodePath.join(dirs.threads, "thread%2F1", "overlay.yml");
          assert.deepStrictEqual(state.argv().argv, [
            "--mode",
            "rpc-ui",
            "--approval-mode",
            "always-ask",
            "--profile",
            "work",
            "--config",
            overlayPath,
            "--cwd",
            work,
          ]);
          assert.strictEqual(state.argv().cwd, NodeFS.realpathSync(work));
          assert.strictEqual(NodeFS.readFileSync(overlayPath, "utf8"), OMP_EMPTY_OVERLAY);
          assert.strictEqual(NodeFS.statSync(overlayPath).mode & 0o777, 0o600);
          // After the handshake the session enables OMP's ask dialog.
          assert.deepStrictEqual(state.events(), [
            "command:negotiate_protocol",
            "command:set_ask_dialog",
          ]);
          assert.strictEqual(NodeFS.readdirSync(dirs.pidfiles).length, 1);

          // The thread binds to the session the process opened.
          const providerThread = yield* session.ensureThread({
            threadId: ThreadId.make("thread/1"),
            modelSelection: openInput(work, "approval-required").modelSelection,
            runtimePolicy: openInput(work, "approval-required").runtimePolicy,
          });
          assert.strictEqual(providerThread.nativeThreadRef?.nativeId, "fake-session");
          return session.events;
        }).pipe(Effect.scoped);

        // Stopping the thread closed stdin; omp drained and exited on its own.
        assert.include(state.events(), "stdin-end");
        assert.notInclude(state.events(), "sigterm");
        assert.deepStrictEqual(NodeFS.readdirSync(dirs.pidfiles), []);
        const last = yield* updates.pipe(Stream.runLast);
        assert.strictEqual(last._tag, "Some");
        if (last._tag === "Some" && last.value.type === "provider_session.updated") {
          assert.strictEqual(last.value.providerSession.status, "stopped");
        }
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses to open a session on a sidecar with another contract", () =>
    Effect.gen(function* () {
      const state = yield* makeFakeOmpState;
      const { adapter } = yield* makeAdapter(state, "", { FAKE_OMP_CONTRACT: "1.3.0" });
      const error = yield* adapter
        .openSession(openInput(state.dir, "full-access"))
        .pipe(Effect.scoped, Effect.flip);
      assert.strictEqual(error._tag, "ProviderAdapterOpenSessionError");
      if (error._tag === "ProviderAdapterOpenSessionError") {
        assert.propertyVal(error.cause, "_tag", "OmpContractMismatchError");
      }
      assert.include(state.argv().argv, "yolo");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
