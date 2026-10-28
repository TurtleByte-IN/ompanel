# OMP onboarding

A fresh OMP install has no default model and no credentials. Ompanel walks it through three
steps: find the sidecar, run `omp setup` in an embedded terminal, then sign in under Accounts
(PRD FR-22, §6 `omp setup` wizard).

## Where it shows

- **Settings → Providers → an OMP instance → Setup.** The three steps, each marked done, current
  or pending. It shows for an enabled OMP instance, above OMP sessions and Accounts.
- **First-run wizard → Agents.** OMP is listed first, marked Recommended, with the version of the
  sidecar it probed. An OMP that needs setup gets a **Set up** button, which opens the same
  terminal.
- The composer, model picker and provider banner offer **Open provider setup** for OMP. It goes to
  the OMP instance on Settings → Providers.

## The steps

1. **Find OMP.** The snapshot's `executable` names the binary the instance runs and where it came
   from (see [sidecar.md](sidecar.md#finding-the-sidecar)):

   | Source       | Shown as              |
   | ------------ | --------------------- |
   | `bundled`    | Bundled with Ompanel  |
   | `downloaded` | Downloaded by Ompanel |
   | `custom`     | Custom path           |

   A missing sidecar (`not_found`, failed download, a custom path that is gone) shows the
   resolver's message and **Check again**. So does any other failed check, such as a wrong RPC
   contract.

2. **Run omp setup.** **Run omp setup** opens a terminal in the instance's environment (its
   environment variables, the server's working directory). The terminal types
   `<binary> [--profile <profile>] setup` and does not run it: the user reviews it and presses
   Enter. `omp setup` needs a TTY, and OMP's own setup wizard signs in to a provider and picks a
   default model. While the terminal is open and OMP still needs setup, the section re-checks the
   instance every 5 s. **Check again** re-checks at once.
3. **Sign in under Accounts.** Once OMP is ready, the section scrolls to Accounts and lists the
   providers ([accounts.md](accounts.md)). This step is optional: a local model or an API key in
   the environment needs no sign-in. The step is marked done when OMP reports a signed-in OAuth
   provider.

## OMP is on by default (Z-09, ompanel#199)

A fresh profile has no OMP settings, and OMP must still be enabled and probed from the bundled
sidecar. Three places carry that default, and they must agree: `OmpSettings.enabled` decodes to
`true` (`packages/provider-omp/src/settings.ts`), `omp` is not in `DEFAULT_DISABLED_PROVIDER_DRIVERS`
and is in `DEFAULT_ENABLED_DEFAULT_INSTANCES` (`packages/contracts/src/settings.ts`). Until Z-09 all
three said "off" (the F-09b scaffold shipped OMP as an opt-in Preview), so the first-run screen showed
**Disabled · OMP is disabled in Ompanel settings.**

Only an explicit `enabled: false` (the Providers switch writes it) turns OMP off, and it survives
upgrades. An instance saved without an `enabled` flag, or no instance at all, is on. The OMP E2E suite
(`ompEnabledByDefault`) and the Desktop Smoke start with no `enabled` flag so a regression shows up
there; every other suite enables OMP explicitly and could not notice one.

## A fresh install is not an error (ompanel#144)

With no model, `omp --mode rpc` exits 1 before its `ready` frame. At the pinned tag it writes
this to stderr (`main.ts`, `!isInteractive && !session.model`):

```
No default model selected. Use /login, set an API key environment variable, or select a local model with /model or --model.
```

When `enabledModels` filters everything out, it writes `No model available matching
enabledModels …` instead. With no models at all, it writes `No models available.`

`OmpControlService` reads a control process's stderr for these lines only and keeps no text,
since stderr can hold credentials. A control process that exits with one of them fails with
reason `unconfigured`, not `exit`:

- **Status probe.** The probe reports `unconfigured`, and the snapshot becomes
  `status: "warning"`, `auth: unauthenticated`, `installed: true`, with the message "OMP has no
  model or sign-in yet. Run `omp setup`, then sign in under Accounts.". The provider card reads
  **Needs setup**, never "Unavailable". This result is not cached, so the first check after
  `omp setup` sees the change.
- **Sign-in, sign-out, the provider list and the command list.** These need no model of their own.
  They retry once with `--model anthropic/claude-sonnet-4-5` (`OMP_SETUP_PLACEHOLDER_MODEL`), a
  model in OMP's built-in catalog that needs no credentials to resolve. `--model` only overrides
  the default role for that process (`Settings.overrideModelRoles`) and writes nothing to
  `config.yml`. Accounts therefore works before setup, and signing in there is an alternative
  to `omp setup`.

Threads still need a model: they start once setup or a sign-in gives OMP one.
