# Testing the OMP provider

Six layers, from fastest to most faithful.

| Layer           | Where                                                                                                                                                                                             | Drives                                                           |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Unit            | `packages/provider-omp/src/**/*.test.ts`                                                                                                                                                          | Pure functions: launch arguments, approval-mode mapping, frames  |
| Adapter         | `packages/provider-omp/src/server/adapter.test.ts` (and the process-layer tests next to it)                                                                                                       | The adapter and thread process against the scripted fake `omp`   |
| Control plane   | `packages/provider-omp/src/server/controlBinary.test.ts`                                                                                                                                          | `OmpControlService` against the scripted control fake `omp`      |
| Replay fixtures | `apps/server/src/orchestration-v2/testkit/OmpReplayFixtures.integration.test.ts`, fixtures in `testkit/fixtures/omp_*`                                                                            | The process layer against stdout recorded from the pinned fork   |
| End-to-end      | `apps/web/e2e/omp/omp-thread.spec.ts`, `omp-settings.spec.ts`, `omp-onboarding.spec.ts`, `omp-notify.spec.ts`, `omp-trust.spec.ts`, `omp-composer.spec.ts`, `omp-host-tools.spec.ts` (Playwright) | The web app and server against a real `omp` and a scripted model |
| Live            | `apps/web/e2e/omp/omp-live.spec.ts` (Playwright, `OMPANEL_LIVE=1`)                                                                                                                                | The web app and server against a real `omp` and a real model     |

The first four run in CI with the rest of the suite; none needs a model, an
account or a built `omp`. The end-to-end test has its own CI job, `OMP E2E`,
which builds `omp` from the pinned tag ([End-to-end](#end-to-end)). The live
suite runs nightly in its own workflow and needs a model key
([Live suite](#live-suite)).

## The fake `omp`

`packages/provider-omp/src/server/testing/fakeOmp.fixture.mjs` is a Node
script that stands in for `omp --mode rpc-ui`. Tests get it through
`makeFakeOmpState` in `testing/fakeOmp.ts`, which gives a scratch directory,
an executable `omp` (`state.executable()`), and what the fake observed:
`argv()`, `events()` (commands, `stdin-end`, `sigterm`), `commands()` (every
command line it read) and `tree()`.

It always writes `ready` first and answers `negotiate_protocol`. Everything
else is scripted per test:

```ts
const state = yield * makeFakeOmpState;
const env = state.env(
  state.script({
    afterNegotiate: [{ emit: fakeOmpFrames.notice("hello") }],
    commands: {
      prompt: fakeOmpFrames.promptTurn({ text: ["Hel", "lo"] }),
      fork: [{ fail: "busy", code: "session_busy" }],
    },
  }),
);
```

| Script key       | Runs                                                                     |
| ---------------- | ------------------------------------------------------------------------ |
| `afterReady`     | Right after `ready`, before the handshake                                |
| `afterNegotiate` | After the `negotiate_protocol` response (default: `notice` "negotiated") |
| `commands[type]` | On every receipt of that command                                         |

| Step                     | Effect                                                           |
| ------------------------ | ---------------------------------------------------------------- |
| `{ respond: data }`      | Success response to the triggering command                       |
| `{ fail, code? }`        | Error response, e.g. `code: "session_busy"`                      |
| `{ emit: frame }`        | One frame; the string `"$id"` inside it becomes the command's id |
| `{ emitChunked: frame }` | The frame as protocol v2 `rpc_chunk` frames of 256 KiB           |
| `{ writeRaw: text }`     | Raw stdout, for framing violations                               |
| `{ sleepMs }`            | A pause; steps run in order, one chain per process               |
| `{ exit: code }`         | Exit once stdout is flushed                                      |

Unscripted commands keep defaults: `get_state` reports the current session id
(which follows the last `session_info_update` the fake wrote), anything else
fails with `code: "unsupported"`. Process behaviour that is not about frames
stays on environment variables: `FAKE_OMP_CONTRACT`,
`FAKE_OMP_NEGOTIATE_CONTRACT`, `FAKE_OMP_V1_ONLY`, `FAKE_OMP_FIRST_FRAME`,
`FAKE_OMP_SPAWN_TREE`, `FAKE_OMP_IGNORE_SIGTERM`, `FAKE_OMP_IGNORE_STDIN_END`.

With `state.sessionStore()` merged into `env(...)` (`FAKE_OMP_SESSIONS_DIR`),
the fake keeps sessions on disk the way OMP does, under `state.sessions.root`
(pass `state.sessions` as the adapter's `sessions`): one bucket per `--cwd`,
`<timestamp>_<id>.jsonl` with a title slot, header and `message` entries
(random ids and timestamps, chained by `parentId`).
Unscripted `get_state`, `new_session`, `switch_session`, `get_messages_page`
(with stale cursors), `set_session_name`, `get_entries` (with `since`),
`get_tree`, `get_branch_messages`, `branch` and `fork` work on that store
(`branch` and `fork` write a new file keeping entry ids, like OMP); a `prompt`
records its user message and an emitted `agent_end` its messages; an accepted
`host_cwd_change_result` moves the file into the new directory's bucket, as
`/wt` does. `sessionStore(root, { autoResume: true })` starts on the bucket's
newest session, like OMP's `autoResume`. Unscripted `export_html` writes a
page of the stored session (title and message texts) to `outputPath`.

With `FAKE_OMP_CONTRACT` at 1.7.0 or later the fake hosts one collab room like
OMP's RPC (`collab_start`, `collab_status`, `collab_stop`, and a
`collab_state` frame when the room starts or ends); an older contract answers
them as unknown commands. Its links carry `FAKE_OMP_COLLAB_TOKEN`, so a test
can check that the token reaches no journal or log
(`threadMenuController.test.ts`).

`fakeOmpFrames` builds contract-shaped frames: `promptTurn` (ack,
`agent_start`, streamed thinking and text, an optional tool execution,
`agent_end`, `prompt_result`), `sessionInfoUpdate`, `subagentLifecycle`,
`subagentEvent`, `commandOutput`, `notice`, `assistant`.

## The control fake `omp`

`testing/fakeOmpControl.fixture.mjs` stands in for the short-lived `omp`
processes `OmpControlService` starts (`control.ts`): one-shot CLI commands
(`--version`, `config list|set|reset|path`, `usage`, `stats`, `skill list`,
`plugin list`, `agents unpack`, `--export <session> <out>`, `share`, each with
an optional `--profile`) and
`--mode rpc` control servers (`get_login_providers`, `login`).
`makeFakeOmpControl` in `testing/fakeOmpControl.ts` gives a scratch directory,
an executable `omp`, a `workspace` and what the fake saw: `starts()` (pid,
argv, cwd of every process) and `frames()` (every RPC line it read).
`controlBinary.test.ts` runs the real service on the real spawner against it.

`target(script)` returns an `OmpControlTarget` whose `omp` answers with the
pinned fork's output (`PINNED_*`, captured in a scratch `HOME`: CLI output from
the v18.12.6-ompanel.3 sidecar, unchanged in the pinned v18.12.6-ompanel.6, whose CLI
contract 1.1.0 only adds `config list --scope`, and the `ready` frame from v18.12.6-ompanel.6; typed against the vendored CLI
and wire contracts) unless `script` replaces a command:

```ts
const omp = yield * makeFakeOmpControl;
const target = omp.target({
  cli: { usage: { stdout: "{", exitCode: 0 }, "skill list": { hang: true } },
  rpc: {
    commands: {
      login: [{ emit: input }, { await: input.id, onCancel: [{ fail: "API key is required" }] }],
    },
  },
});
```

A CLI command prints `stdout`/`stderr` and exits with `exitCode`, or hangs;
`--export` also writes its `html` to the output path. `target(script, { gh })`
puts a fake GitHub CLI on the target's `PATH` whose `gh auth status` succeeds
(`ready`) or fails (`signed_out`), or none (`missing`); the `PATH` then holds
nothing else, so no test reaches a real `gh` or uploads anything.
An RPC server runs `beforeReady`, writes `ready`, runs `afterReady` (the
pinned `setWidget` and `available_commands_update` frames), then the steps of
each command: `emit`, `respond`, `fail`, `raw`, `stderr`, `await` (a UI
response, with `onCancel` when it is cancelled), `exit` and `hang`. It exits
when its stdin closes, as OMP does.

## Replay fixtures

Each scenario in `testkit/fixtures/ompScenarios.ts` drives one thread process
and asserts what it saw: `context`, `rename`, `fresh`, `compact`, `cancel`,
`branch`, `rewind`, `fork`, `fork_busy`, `switch_session`, `messages_page`. Its transcript,
`testkit/fixtures/omp_<name>/omp_transcript.ndjson`, holds the launch
arguments, every stdin line (`expect_outbound`), every raw stdout line
(`emit_inbound`, `rpc_chunk` sequences kept), the stdin close and the exit.

The replay suite (`OmpAdapterV2.testkit.ts`) runs the real `startOmpRpcProcess`
on a spawner that plays the transcript back: the host must write exactly the
recorded stdin, in order, and close stdin at the end; each write releases the
stdout recorded after it. A scenario's own assertions run again on the replay.
The suite fails when a transcript was recorded against a different `omp.lock`
tag or RPC contract version, so re-record after every re-pin.

These are transport replays. Once the frame mapper and UI handlers land, the
same transcripts can feed an orchestrator-level harness like Pi's.

### Recording

You need a checkout of the pinned fork at the `omp.lock` commit, with
dependencies installed and the native addon present, and `bun`:

```sh
git -C ../oh-my-pi worktree add --detach ../wt/oh-my-pi/scratch "$(jq -r .tag packages/provider-omp/omp.lock)"
(cd ../wt/oh-my-pi/scratch && bun install --frozen-lockfile && bun --cwd=packages/natives run build)
pnpm --filter t3 record:omp-replay --omp-source ../wt/oh-my-pi/scratch [--scenario <name>]
```

`T3_BUN_BIN` overrides the `bun` used. The recorder refuses a checkout at
another commit. For each scenario it:

1. starts a local OpenAI-compatible model (adapted from the fork's
   `packages/coding-agent/test/rpc-wire/fake-openai-server.ts`) that answers
   "pong" and, for a turn containing "slow", streams one delta and stalls;
2. runs `bun <checkout>/packages/coding-agent/src/cli.ts --mode rpc-ui` with
   the adapter's flags plus `--model fake/fake-model --no-extensions
   --no-skills --no-rules --no-lsp --no-title`, in a throwaway `HOME`,
   `PI_CODING_AGENT_DIR` and workspace (the agent dir's `config.yml` sets
   `compaction.keepRecentTokens: 10` so a short session can compact);
3. records the process, replaces the temp root, the CLI path, the home
   directory and the model URL with placeholders, replays the result through
   the process layer, and only then writes the fixture. A failed live run
   leaves what it saw in `$TMPDIR/omp-record-<name>.failed.ndjson`.

## RPC wire contract

`packages/provider-omp/src/contract.test.ts` validates frames against the vendored
`packages/provider-omp/contract/rpc-wire.schema.json` with Ajv (2020-12, strict): every
`emit_inbound`/`expect_outbound` frame in
`apps/server/src/orchestration-v2/testkit/fixtures/omp_*/omp_transcript.ndjson`, the `fakeOmpFrames`
builders, and what `fakeOmp.fixture.mjs` writes (handshake, `get_state`, collab, unsupported, a
scripted turn, `rpc_chunk` reassembled, the session-store answers). Host commands are checked against
their `params`, OMP frames against `RpcServerFrame`, and successful response `data` against the
command's `result` (absent `data` is allowed, as `RpcResponse` declares). An unknown frame `type`,
malformed frames and mismatched response data are rejected. The schema closes no object, so
undeclared properties pass until a pin closes one; a re-pin whose recorded frames stop conforming
fails here.

```sh
cd packages/provider-omp && pnpm exec vp test run --config ../../vite.config.ts --dir . src/contract.test.ts
```

## Component checks

- Share gist: `apps/web/src/components/chat/OmpShareGistDialog.browser.test.tsx` ("uploads only
  after the confirm, then shows the share link and its gist"; "shows the trim note when OMP trimmed
  large content"; "shows the refusal when gh is missing, with no link, and lets the user retry";
  "Cancel closes the dialog without uploading"). Server side:
  `threadMenuController.test.ts` › "refuses Share gist before anything uploads unless gh is signed in".
- OMP instance Profile field:
  `apps/web/src/components/settings/ProviderSettingsForm.omp.browser.test.tsx` shows Profile after
  Binary path (placeholder "default"), stores a valid name and omits it when cleared; invalid names
  ("Work Space", "../work", "-work", "con") fail `OmpSettings`, the schema the server decodes instance
  config with (`settings.test.ts` › "OmpSettings.profile").

```sh
cd apps/web && pnpm exec vp test run --project browser src/components/chat/OmpShareGistDialog.browser.test.tsx src/components/settings/ProviderSettingsForm.omp.browser.test.tsx
```

## End-to-end

`apps/web/e2e/omp/omp-thread.spec.ts` is gate G1: one OMP thread through the
web app in headless Chromium. Its steps run in order on one page:

1. create a thread, pick OMP in the model picker, set Supervised;
2. send a message; the reply streams (the first paragraph renders while the
   model is still sending the second; Ompanel's default
   `responseStreamingMode` shows streamed text a paragraph at a time);
3. ask for a shell command; approve the command approval card; the command runs
   in the thread's T3 terminal (`terminal` host tool, [host-tools.md](host-tools.md));
4. switch to Full access; the next command runs without an approval card, and
   the thread's `omp` process (from the server's pidfiles) is the same one;
5. rewind: `test.fixme` until C-11 (ompanel#74) lands;
6. fork: `test.fixme` until C-11 (ompanel#74) lands;
7. commit from the Git actions menu with an empty message; the subject comes
   from OMP text generation (`omp -p`).

`apps/web/e2e/omp/omp-settings.spec.ts` is gate G2: OMP's control plane
through the web app. Its steps run in order on one page, every page opened
with a full page load:

1. OMP settings pages and the Usage page's OMP tab show OMP's data on a full
   page load, once the client's IndexedDB `server-config` cache lists OMP (ompanel#128:
   the pages read OMP before the connection was up; they now wait for it and show the
   connection's status meanwhile, so a failed environment shows why);
2. `/wt <branch>` in an OMP thread makes a T3 worktree (`git worktree list`),
   the thread list and git panel show the branch, and the next message runs
   OMP with `--cwd` in the worktree;
3. sign-in through Settings → Providers → OMP → Accounts against a fake login
   provider (below): Sign in, open the vendor page, paste its code, Submit;
   the provider shows Signed in and the vendor's token endpoint got the code;
4. one non-credential key on every OMP settings page that `omp config set`
   writes (Models & Roles, Routing, Thinking, Advisor & Agents, Sampling,
   Approvals & Tools, Memory, Context, Modes, Runtime incl.
   `telemetry.otlpExportEnabled`, Search, Discovery, MCP, Customization, All
   settings), read back with `omp config get <key> --json` from the stack's
   OMP home;
5. every key the real `omp config list` reports is on a page, on All settings
   (advanced) (its row count matches) or shown elsewhere (the auth broker keys);
6. the layer switch on Routing writes `retry.maxRetries` to the workspace
   project's `.omp/config.yml`: `config list` reports it with source `project`
   in the workspace and the global value outside it; Reset removes it;
7. Models & Roles edits `enabledModels`' global entries (CLI contract 1.1.0,
   `omp config list --scope global`): with a plain entry and an entry scoped to
   another folder in the global layer, the field shows the plain entry and lists
   the folder entry read-only; a new plain entry written from the form lands in
   the global layer next to the folder entry, which is kept as written;
8. Custom providers: a provider and model added in the form and saved (OMP
   checks the file first); `omp models <provider> --json` lists the model;
9. Terminal prefs stay read-only, and `omp config get` is unchanged;
10. Plugins: a marketplace on disk added, its plugin installed, disabled and
    enabled again, each after the confirmation that shows the command; `omp
    plugin list --json` agrees; Skills lists the plugin's skill, as `omp skill
    list` does. Nothing needs the network;
11. Accounts → Auth broker: the broker URL written and read back with `omp
    config get`, a literal token refused in the form with nothing written, an
    environment variable name accepted (`config list` reports it stored and
    redacted), then both reset so later steps run without a broker.

`apps/web/e2e/omp/omp-onboarding.spec.ts` is P-07's [onboarding](onboarding.md)
on a fresh OMP home (`freshOmpHome`: no `config.yml`, no `models.yml`), so the
real `omp --mode rpc` refuses to start for want of a model (ompanel#144):

1. the OMP card reads Needs setup, never Unavailable, and the Setup section
   shows the sidecar found and `omp setup` as the current step;
2. Accounts lists the login providers before setup (the placeholder-model
   control server);
3. Run omp setup opens the embedded terminal with the command typed; the test
   then leaves the OMP home as the wizard would (`completeOmpSetup`: the
   scripted model's `models.yml` and `modelRoles.default`), the section's
   re-check sees OMP ready and hands over to Accounts, and a sign-in starts
   there. OMP's own setup TUI is not driven.

The fake login provider (`e2e/omp/fakeSignIn.ts`): OMP lists only built-in
login providers in the control servers Ompanel starts (`--no-extensions`), so
the stack's OMP instance runs a wrapper `omp`. Control servers go through
`fakeSignInOmp.mjs`, which passes every frame to the real `omp` except
`get_login_providers` (which gains `g2-fake-vendor`) and `login`,
`get_logout_accounts` and `logout` for that provider. Its `login` answers as
OMP does for an OAuth provider: `open_url` to a vendor page on loopback that
shows a one-time code, an `input` request for the code, then the code traded
at the vendor's token endpoint. Every other `omp` start execs the real binary,
so thread processes keep their pid and command line. No real vendor is
contacted.

`apps/web/e2e/omp/omp-notify.spec.ts` covers OMP `notify` alerts
([notifications.md](notifications.md)). The spec writes an OMP extension
into its agent directory that calls `ctx.ui.notify` a few seconds into a turn
whose prompt names a message; the stack links the environment to a loopback relay
(`e2e/omp/relayStub.ts`, the stack's `relayStub` option) that records every
agent-activity publish and 404s every other route. Its steps:

1. turn on In-app notifications; Agent messages is on by default;
2. start a stalled turn, open another view; the agent's message shows as a
   toast, the relay received the running thread's state with that message as
   `agentMessage`, and the thread shows it as a notification row;
3. turn Agent messages off; the next notify still reaches the relay (phones
   decide per device) but shows no toast.

`apps/web/e2e/omp/omp-trust.spec.ts` covers [workspace trust](security.md#workspace-trust).
The workspace gets its own agent config: an `.omp/config.yml` that allows every
command (`tools.approval`, `bash.patterns`) and turns on project MCP config, and
an `.mcp.json` naming a stdio MCP server that records every start with the
command line of the process that started it. Its steps:

1. untrusted (the default): a Supervised thread's command still shows the
   approval card, no process started the project's MCP server (neither the
   thread's `omp` nor a control server), nothing imported the project's custom
   tool `.omp/tools/trust-tool-probe` (a control `omp` starts in the project
   folder, and its own overlay carries `workspace.trusted: false`), and the
   thread's overlay holds `workspace.trusted: false`;
2. Trust project agent config turned on in Settings → Threads for the project
   (the setting does not say "Not enforced"): a new Supervised thread's command
   runs without an approval card, its `omp` started the MCP server and imported
   the custom tool.

`apps/web/e2e/omp/omp-composer.spec.ts` covers the composer extras (goal mode,
magic keywords, traits, Vibe Mode) and, last, a staged `ast_edit` card
([frames.md](frames.md)): `ast edit: <pattern> => <replacement> in <file>`
makes the scripted model call `ast_edit` (or write its `xd://` device), and the
model then hangs so the preview waits mid-turn. The card shows the proposal with
Accept and Reject while the file is untouched; Accept applies it (the file
changes, the card reads applied, no buttons, also after a reload); a second
proposal is rejected and the file keeps its text.

`apps/web/e2e/omp/omp-host-tools.spec.ts` covers T3's MCP tools in an OMP
thread ([host-tools.md](host-tools.md)). Ompanel issues the thread an MCP
credential, the driver gives OMP every tool of Ompanel's MCP server with
`set_host_tools`, and the scripted model calls them by name. The first two
steps run on one Full access thread, so no tool asks for approval:

1. `tool: t3_preview_list {"limit":5}`: OMP offered the model `terminal` as a
   tool and T3's MCP tools (`t3_preview_list`, `preview_open`,
   `delegate_task`, …) as `xd://` devices in its system prompt. The model
   calls the device with `write xd://t3_preview_list`, which goes through
   Ompanel's MCP server. The result (the thread's preview tabs, none here)
   comes back in the model's next request. The turn's work log shows the
   `xd://t3_preview_list` entry, and the reply is `ran: …`.
   `t3_preview_list` needs no browser to host a preview, so it runs headless;
2. `tool: delegate_task {"task":…,"mode":"wait"}`: T3 starts a child thread on
   the same OMP instance. The child's turn runs on the scripted model and
   completes. The parent's tool result says `completed` and holds the child's
   reply, and the parent's reply links the child. The child is listed in the
   parent's Lineage panel and opens from there as a subagent thread with the
   task and the reply.
3. `/move` from the composer, on a new Full access thread. The test adds a git
   worktree of the workspace on a new branch, plus an empty folder beside it.
   `/move <folder>` reaches OMP, OMP asks the host, and the thread shows
   `Move rejected by host: … is not a checkout of the project`. `/move <worktree>`
   is accepted: OMP reports `Moved to …`, the thread shows the worktree's
   branch, and the next message starts `omp` with `--cwd` at the worktree.

`e2e/omp/ompSuite.ts` holds what the Playwright specs share: the hooks that
start one stack and one paired page per file and record a trace per step, and
the page helpers the steps use. `e2e/omp/ompStack.ts` starts everything in a
throwaway directory: a `HOME`
and Ompanel home, a git workspace the server bootstraps as a project, the
server from source (`apps/server/src/bin.ts`, serving `apps/web/dist`) with
the OMP instance pointed at the given binary, and the scripted model
(`e2e/omp/scriptedModel.ts`, adapted from the fork's
`fake-openai-server.ts`). OMP's agent directory gets the model's
`models.yml` and `modelRoles.default: fake/fake-model`. The model answers by
the last message: `run: <command>` calls the shell tool, a line
`tool: <name> <json-args>` calls the offered tool `<name>` with those
arguments, or writes them to its `xd://<name>` device when OMP mounted it
there (T3's MCP tools; the reply `scripted model cannot call <name>: …` says
it was offered neither way or the arguments are not a JSON object), a
tool result gets `ran: <first line>`, `vibe spawn: <name>` in vibe mode starts
one `good` worker named `<name>` with `vibe_spawn`, Ompanel's text generation prompts get
the JSON they ask for, and anything else gets two streamed paragraphs. OMP's
`collab.relayUrl`
is a loopback relay (`e2e/omp/collabRelay.ts`, cut down from the fork's
`packages/collab-web/scripts/local-relay.ts`), so Share live opens and stops a
real room without the internet. That step runs untraced; the parity spec's QR
screenshot masks the code and both links, and its two links join the teardown secrets scan. Nothing reads
the developer's `~/.omp` or Ompanel home, and no API key is used.

Run it locally (the Node version in `package.json` `engines`, `bun`, and a
Rust toolchain for the fork's native addon on the first build):

```sh
export OMPANEL_E2E_OMP_BINARY=$(node apps/web/e2e/omp/build-omp.ts ../wt/oh-my-pi/scratch | tail -n 1)
node apps/web/node_modules/playwright/cli.js install --only-shell chromium   # once
vp run --filter @t3tools/web test:e2e
```

`build-omp.ts` clones the fork at the `omp.lock` tag when the directory does
not exist, refuses a checkout at another commit, builds the native addon and
the `omp` binary (skipped when `dist/omp.commit` already names the pinned
commit) and prints the binary's path. `test:e2e` builds the web app, then
runs Playwright on every spec in `e2e/` (the live suite is skipped without
`OMPANEL_LIVE=1`). Screenshots, `server.log` and one trace per step go to
`apps/web/.playwright/omp-artifacts/`, or to `OMPANEL_E2E_ARTIFACTS_DIR` (G2's
in its `g2/` subdirectory); the HTML report goes to `apps/web/playwright-report/`.
Open a trace with
`pnpm --filter @t3tools/web exec playwright show-trace <zip>`.

In CI, `OMP E2E` caches the binary by the pinned commit, so only the first
run after a re-pin builds it; it uploads the screenshots, traces and report as
the `omp-e2e` artifact. The build and the Chromium install are the composite
action `.github/actions/setup-omp-e2e`, shared with `OMP live`.

### Parity checks

`apps/web/e2e/omp/omp-parity.spec.ts` runs in the same stack as the G1 thread suite and is part of
`test:e2e`. Steps, in order:

1. "opens the Agents panel and lists fanned-out subagents": `fanout: parity-alpha, parity-beta` in
   Full access; the Agents panel lists both as Completed.
2. "shows T3's checkpoint summary under an OMP turn that changed a file": a turn rewrites
   `README.md`; the summary under it reads "1 changed file", +2 −1, `README.md`, Open diff.
3. "shows the Share live browser link as a QR code, outside the trace": untraced; the QR code
   rendered in the dialog encodes exactly the browser link (compared module by module with
   `@t3tools/shared/qrCode`); the screenshot masks the QR code and both links, and both links join
   the teardown secrets scan.
4. "launches an OMP thread on the instance's named profile": the profile `parity-work` gets the
   scripted model's `config.yml` and `models.yml`. The step sets Profile on the OMP instance in
   Settings → Providers and starts a new thread. The thread's `omp` runs with
   `--profile parity-work`, and its session file is under
   `~/.omp/profiles/parity-work/agent/sessions`, not the default agent directory.

Artifacts go to `apps/web/.playwright/omp-parity-artifacts/`, or to `parity/` under
`OMPANEL_E2E_ARTIFACTS_DIR`. Run it alone with
`pnpm --filter @t3tools/web exec playwright test e2e/omp/omp-parity.spec.ts` (after `vp build`,
with `OMPANEL_E2E_OMP_BINARY` set).

In CI, `OMP E2E` also runs the live suite against the scripted model after `Test`
(`test:e2e:live:prebuilt`: `OMPANEL_LIVE=1`, without rebuilding the web app) and uploads it as the
`omp-e2e-live` artifact.

## Live suite

`apps/web/e2e/omp/omp-live.spec.ts` runs one OMP thread through the web app
against the `omp` built from the `omp.lock` tag and a real model. It is
skipped unless `OMPANEL_LIVE=1`. Its steps run in order on one page:

1. streamed turn: a new OMP thread in Supervised; the reply's first paragraph
   is on screen before its second has arrived;
2. approval-driven tool run: the model asks to run a shell command; nothing
   runs until the approval card is approved, then the command writes
   `live-approval.txt` and the reply quotes its output;
3. subagent fan-out: in Full access the model starts two subagents with OMP's
   `task` tool; the agents panel lists both as Completed;
4. rewind: two turns each give the model a code word; "Edit from here" on the
   second removes it, and the model, asked for every code word, names only
   the first, in the same `omp` process;
5. text generation: a commit with an empty message gets its subject from OMP
   (`omp -p`).

The model is Anthropic's, chosen with `OMPANEL_LIVE_MODEL` (default
`anthropic/claude-haiku-4-5`). The key is read from
`OMPANEL_LIVE_ANTHROPIC_API_KEY` and reaches OMP only as the Ompanel server's
`ANTHROPIC_API_KEY` environment variable, which every `omp` it starts
inherits: never on a command line, never in a file, and replaced by
`<redacted>` in the saved `server.log`. OMP's agent directory gets
`modelRoles.default: <model>`; nothing else changes from the end-to-end
stack. With `OMPANEL_LIVE=1` and no key, the suite fails at its first step
and names the variable.

The prompts are worded so the scripted model answers them as well:
`OMPANEL_LIVE_MODEL=scripted` runs the suite with no key, which checks the
suite itself. The scripted model additionally starts one `task` subagent per
name after `fanout: a, b`, answers a subagent (the only caller offered OMP's
`yield` tool) by yielding, repeats the text after "Reply with exactly these
two paragraphs and nothing else:", and answers "List every code word I asked
you to remember" from the `code word: <word>` lines of the history it was
sent.

```sh
export OMPANEL_E2E_OMP_BINARY=$(node apps/web/e2e/omp/build-omp.ts ../wt/oh-my-pi/scratch | tail -n 1)
export OMPANEL_LIVE_ANTHROPIC_API_KEY=...   # or OMPANEL_LIVE_MODEL=scripted
vp run --filter @t3tools/web test:e2e:live
```

Artifacts go to `apps/web/.playwright/omp-live-artifacts/`, or to
`live/` under `OMPANEL_E2E_ARTIFACTS_DIR`.

In CI, `.github/workflows/omp-live.yml` (`OMP live`) runs the suite nightly,
on pull requests that change it, and on demand (`workflow_dispatch`, with an
optional `model` input; `scripted` needs no key). The key is the repository
secret `OMPANEL_LIVE_ANTHROPIC_API_KEY`, passed to the test step's
environment only. Without it the job runs the suite against the scripted model
and posts the notice "OMP live suite ran scripted" on the run and in its summary. The run
uploads the `omp-live` artifact. `OMP live` is not a required check.

## What the recordings show (pinned tag)

- A `prompt` that starts a model turn is acked without `data`; only builtins
  that finish locally ack `{ agentInvoked: false }`. The turn ends with
  `prompt_result`.
- `/fresh` starts a new provider session id but announces it only as
  `command_output`; there is no `session_info_update`. The ack carries no
  `data`, and a `prompt_result` with `agentInvoked: true, status: "aborted"`
  follows although no turn ran. Read the new id with `get_state`.
- `/rename <title>` writes `command_output` and a `session_info_update`
  with the title.
- `/compact` acks `{ agentInvoked: false }`, then sends
  `manual_compaction_start` and `manual_compaction_end` (with the compaction
  `result`, or `aborted`), then a `command_output` summary.
- `/handoff [focus]` acks `{ agentInvoked: false }`, then sends one
  `command_output` ("Context handed off and compacted in place.") once the
  model wrote the document. There are no compaction frames and no
  `session_info_update`; `get_state` keeps the session id and file, and
  `get_entries` holds a new `compaction` entry.
- `/security` with OMP's default `security.enabled: false` writes its
  "Security is disabled" `command_output` before the ack.
- `/context` output contains ANSI colour escapes.
