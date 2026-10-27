# OMP in Ompanel

Maintainer notes on how Ompanel drives OMP (oh-my-pi) through its pinned sidecar. User-facing
guides are in [docs/user](../README.md#using-ompanel), starting with the
[OMP provider guide](../user/providers-omp.md).

## Start here

- [Architecture](./architecture.md): the two forks, the server, `provider-omp`, the sidecar and
  how they connect.
- [Provider internals](./provider-internals.md): a map of `packages/provider-omp/src/server/`.

## Runtime

- [Sidecar pin](./sidecar.md): `omp.lock`, bundling, control processes and their deadlines.
- [Session processes](./processes.md)
- [Threads and sessions](./sessions.md)
- [Frames in a thread](./frames.md)
- [Frame journal](./journal.md)
- [Host tools](./host-tools.md)
- [Models and composer traits](./models.md)
- [Commands and skills](./commands.md)
- [Composer runtime](./composer.md)
- [Subagents and the Agents panel](./subagents.md)
- [Thread menu](./thread-menu.md)
- [Notify alerts](./notifications.md)
- [Security guards](./security.md)

## Settings and accounts

- [Settings](./settings.md)
- [Settings pages: keys and commands](./settings-mapping.md)
- [Accounts](./accounts.md)
- [Onboarding](./onboarding.md)

## Procedures

- [Following upstream: both forks](./fork-and-merge.md)
- [Bumping the contract and moving the pin](./contract-bump.md)
- [CI on the fork](./ci.md)
- [Testing the OMP provider](./testing.md)
- [Branding](./branding.md)

## Record

- [PRD §12 open questions](./open-questions.md)
