# OMP models and composer traits

How the composer's model picker and traits menu drive an OMP thread
(`packages/provider-omp/src/server/modelTraits.ts`, `adapter.ts`).

## Model catalog

The status probe asks the same RPC server that answers `get_login_providers` for
`get_available_models`. The picker lists:

- **OMP default** (`default`): the thread leaves the model to OMP's config
  (`modelRoles.default`), and the role chip below applies.
- Every listed model once, as `provider/modelId` (model ids may contain `/`; the
  provider never does).
- Custom models from the instance settings.

A refused or unreadable catalog leaves the picker with OMP default and custom models.

## Applying a selection

T3 owns the selection. Before each prompt the adapter sends only what changed since
the last turn:

| Trait        | OMP side                                                                                                                      |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Model        | `set_model {provider, modelId}`; back on OMP default, the model the session started on                                        |
| Thinking     | `set_thinking_level`, including `inherit`; re-sent after a model change, since OMP re-applies the new model's level           |
| Fast Mode    | `set_fast_mode`                                                                                                               |
| Advisor      | `set_advisor`                                                                                                                 |
| Prewalk      | `set_prewalk`; an armed prewalk is spent by the turn it runs on, so it is re-armed every turn while on                        |
| Computer Use | the thread overlay's `computer.enabled` (see below)                                                                           |
| Vibe Mode    | `set_vibe_mode {enabled}`, from RPC contract 1.7.0 only; not offered on an older pin ([composer.md](./composer.md#vibe-mode)) |
| Role         | the thread overlay's `modelRoles.default`, then a session restart                                                             |

A refused model or thinking level fails the turn before its prompt. A refused boolean
trait (fast mode on a model without it, prewalk without a target) is logged and the
turn runs; the next turn asks again.

`cycle_model` and `cycle_thinking_level` are not used: they change OMP's state behind
T3's selection. The composer's effort keys (`composer.increaseEffort` /
`composer.decreaseEffort`) step through the thinking levels, and the model picker's
keys switch models; each lands as a selection the next turn applies.

## Thinking levels

`inherit` (the default) leaves the level to OMP's config. A listed model offers `off`
plus the efforts its `thinking.efforts` names, or `minimal`–`high` when it reasons
without naming them; a model that does not reason has no thinking selector. OMP
default and custom models offer every level; OMP clamps a pick to what the resolved
model supports.

## Computer use

`/computer` toggles an eval prelude, not a tool, so `set_tool_enabled` refuses it, and
RPC has no command for it. Its setting (`computer.enabled`) is read live, so the
adapter writes it to the thread's `--config` overlay, which OMP reloads in place.

## Role chip

On OMP default, the Role select runs the thread as one of OMP's chat roles (`smol`,
`slow`, `plan`, `vision`, `task`, `advisor`, `commit`, `tiny`). The adapter writes
`modelRoles.default: "@<role>"` to the thread's overlay before the process starts
(overlays deep-merge, so the user's own `modelRoles` entries still apply), and a role
change answers `planSelectionTransition` with `restart_session`.

The process's own fresh session runs the model OMP resolves at launch, which is the
role's model; the adapter records it before it switches to the thread's session. A
resumed session reloads the model it recorded, so when that differs, the next turn
on OMP default sends `set_model` with the launch model. Back on `default`, only a role
alias is removed from the overlay; a model a settings override put there stays.
