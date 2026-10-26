# Testing the OMP provider

Three layers, from fastest to most faithful.

| Layer           | Where                                                                                                                  | Drives                                                          |
| --------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| Unit            | `packages/provider-omp/src/**/*.test.ts`                                                                               | Pure functions: launch arguments, approval-mode mapping, frames |
| Adapter         | `packages/provider-omp/src/server/adapter.test.ts` (and the process-layer tests next to it)                            | The adapter and thread process against the scripted fake `omp`  |
| Replay fixtures | `apps/server/src/orchestration-v2/testkit/OmpReplayFixtures.integration.test.ts`, fixtures in `testkit/fixtures/omp_*` | The process layer against stdout recorded from the pinned fork  |

All three run in CI with the rest of the suite; none needs a model, an
account or a built `omp`.

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
`<timestamp>_<id>.jsonl` with a title slot, header and `message` entries.
Unscripted `get_state`, `new_session`, `switch_session`, `get_messages_page`
(with stale cursors) and `set_session_name` work on that store; a `prompt`
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
`branch`, `switch_session`, `messages_page`. Its transcript,
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
