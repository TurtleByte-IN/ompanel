# PRD §12 open questions

Answers on the pinned fork tag, `v18.12.6-ompanel.4` (`packages/provider-omp/omp.lock`).
Re-check them when the pin moves.

## Extension `setStatus` and `setWidget`

Ompanel shows both in a per-thread status strip above the composer, not as cards. The
mapper keeps them on the provider thread's `nativeMetadata.extensionStatus`, keyed by
`statusKey` / `widgetKey` (`applyExtensionStatus` in
`packages/provider-omp/src/server/mapper.ts`; tests "keeps extension status lines and
widgets…" in `uiRequests.test.ts`, `OmpStatusStrip.browser.test.tsx` in `apps/web`).
Neither needs a reply. The frame table in [frames.md](frames.md) has the rules.

- Nothing built into OMP sends content. RPC forwards `setWidget` only for a string
  array or a removal; OMP's one built-in widget (the autoresearch dashboard) passes a
  component factory, so only its removal arrives (`widgetKey: "autoresearch"`, no
  `widgetLines`) — every `setWidget` in the recorded `omp_*` fixtures is that. Built-in
  `setStatus` comes only from the bundled `/review` and `/annotate` commands: a
  transient progress line (`/review`: "Loading open PRs…", `/annotate`: "Rephrasing
  annotation source with the session model…"), removed when the command finishes.
- Both are keyed state that replaces itself, sent at any time; an extension may update
  its status on every turn. A card per update would pile up in the transcript, so the
  strip holds one entry per key, and an absent value removes the entry. The adapter
  applies them as soon as they arrive, even with no turn running.
- Only third-party extensions produce content, so the strip is empty for most threads
  and then renders nothing.

## `--config` overlay and `modelRoleStorage: project`

The overlay wins. OMP merges global, then project, then `--config` overlays, then
runtime overrides (`#mergeOwnLayers` in `packages/coding-agent/src/config/settings.ts`).
`modelRoleStorage` only decides where OMP's own model selector saves a role.

The pinned binary in `rpc-ui` mode, with a scratch `HOME` whose global config sets
`modelRoleStorage: project` and `modelRoles.default: fake/m-global`; the model is
`get_state`'s:

| Project `modelRoles`                                   | Overlay `modelRoles`           | Model                 |
| ------------------------------------------------------ | ------------------------------ | --------------------- |
| `default: fake/m-project`                              | none, or an empty overlay      | `fake/m-project`      |
| `default: fake/m-project`, `smol: fake/m-project-smol` | `default: fake/m-overlay`      | `fake/m-overlay`      |
| `default: fake/m-project`, `smol: fake/m-project-smol` | `default: "@smol"` (role chip) | `fake/m-project-smol` |

- Overlays merge per role, so the role chip's `@smol` resolves through the project's
  `smol`.
- Three processes on one project, each with its own overlay (or none), each ran its own
  model, and the project's `.omp/config.yml` stayed unchanged.
- Rewriting the overlay while the process runs does not change the running session's
  model, even after `new_session`. That is why a role change restarts the session
  ([models.md](./models.md#role-chip)).
- Only a runtime override outranks the overlay. With project storage, OMP's own model
  selector and setup install one (`setProjectModelRole`). RPC `set_model` does not
  persist and installs none, so nothing in an Ompanel thread does.

## Tailing subagent session files before O-3

Moot. O-3 shipped in the fork (RPC contract 1.2.0; the pin carries 1.8.0): every
`subagent_lifecycle` / `subagent_progress` / `subagent_event` frame carries `parentId`
and `depth`, and transcripts come from `get_subagent_messages`, paged by byte offset
([subagents.md](./subagents.md)). Ompanel never reads OMP's session files for subagents,
so their layout is OMP's to change.

## T3's other providers

Kept. `apps/server/src/provider/KeptProvidersSmoke.test.ts` fails when a driver leaves
`BUILT_IN_DRIVERS`, and starts Codex, Claude, Cursor, Grok, OpenCode, Antigravity, Pi,
Muse and ACP Registry through the server's instance registry: each is created, probed
and listed. No provider CLI runs and every credential variable the drivers read
(`CURSOR_API_KEY`, `XAI_API_KEY`, ...) is pinned empty, so no developer key is used and
each reports what it is missing. Sessions on each
run in the per-driver replay fixtures
(`apps/server/src/orchestration-v2/testkit/*ReplayFixtures.integration.test.ts`) and,
for Antigravity, `AntigravityAdapterV2.test.ts`.
