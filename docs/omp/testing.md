# Testing the OMP provider

Five layers, from fastest to most faithful.

| Layer           | Where                                                                                                                  | Drives                                                           |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| Unit            | `packages/provider-omp/src/**/*.test.ts`                                                                               | Pure functions: launch arguments, approval-mode mapping, frames  |
| Adapter         | `packages/provider-omp/src/server/adapter.test.ts` (and the process-layer tests next to it)                            | The adapter and thread process against the scripted fake `omp`   |
| Replay fixtures | `apps/server/src/orchestration-v2/testkit/OmpReplayFixtures.integration.test.ts`, fixtures in `testkit/fixtures/omp_*` | The process layer against stdout recorded from the pinned fork   |
| End-to-end      | `apps/web/e2e/omp/omp-thread.spec.ts` (Playwright)                                                                     | The web app and server against a real `omp` and a scripted model |
| Live            | `apps/web/e2e/omp/omp-live.spec.ts` (Playwright, `OMPANEL_LIVE=1`)                                                     | The web app and server against a real `omp` and a real model     |

The first three run in CI with the rest of the suite; none needs a model, an
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
newest session, like OMP's `autoResume`.

`fakeOmpFrames` builds contract-shaped frames: `promptTurn` (ack,
`agent_start`, streamed thinking and text, an optional tool execution,
`agent_end`, `prompt_result`), `sessionInfoUpdate`, `subagentLifecycle`,
`subagentEvent`, `commandOutput`, `notice`, `assistant`.

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

`e2e/omp/ompSuite.ts` holds what both Playwright specs share: the hooks that
start one stack and one paired page per file and record a trace per step, and
the page helpers the steps use. `e2e/omp/ompStack.ts` starts everything in a
throwaway directory: a `HOME`
and Ompanel home, a git workspace the server bootstraps as a project, the
server from source (`apps/server/src/bin.ts`, serving `apps/web/dist`) with
the OMP instance pointed at the given binary, and the scripted model
(`e2e/omp/scriptedModel.ts`, adapted from the fork's
`fake-openai-server.ts`). OMP's agent directory gets the model's
`models.yml` and `modelRoles.default: fake/fake-model`. The model answers by
the last message: `run: <command>` calls the shell tool, a tool result gets
`ran: <first line>`, Ompanel's text generation prompts get the JSON they ask
for, and anything else gets two streamed paragraphs. Nothing reads the
developer's `~/.omp` or Ompanel home, and no API key is used.

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
`apps/web/.playwright/omp-artifacts/`, or to `OMPANEL_E2E_ARTIFACTS_DIR`; the
HTML report goes to `apps/web/playwright-report/`. Open a trace with
`pnpm --filter @t3tools/web exec playwright show-trace <zip>`.

In CI, `OMP E2E` caches the binary by the pinned commit, so only the first
run after a re-pin builds it; it uploads the screenshots, traces and report as
the `omp-e2e` artifact. The build and the Chromium install are the composite
action `.github/actions/setup-omp-e2e`, shared with `OMP live`.

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
environment only. Without it the job passes, runs nothing, and posts the
notice "OMP live suite skipped" on the run and in its summary. The run
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
- `/context` output contains ANSI colour escapes.
