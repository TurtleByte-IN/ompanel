# OMP accounts

Settings → Providers → an OMP instance → **Accounts** lists OMP's login providers with their
auth state and signs in and out of them. Everything goes through short-lived `omp --mode rpc`
control processes (`OmpControlService`), never through a thread's session.

Accounts is the last step of [onboarding](onboarding.md). It also works on a fresh install:
when OMP refuses to start for want of a model, the control process is started again with a
placeholder model.

On mobile, Settings → Providers shows the same panel for each OMP instance: provider
list, OAuth "Open sign-in page", prompt cards (masked when `secret`), masked API-key entry and
sign-out. The phone opens OMP's own `url`, not `launchUrl`: that short link redirects through the
server's loopback address, which only the server's machine can reach.

## What the page shows

- Every provider `get_login_providers` returns: OAuth, device-code and pasted-key login flows, and
  (from RPC contract 1.6.0) API-key providers without a login flow such as OpenAI, Groq, Gemini
  and Mistral.
- Whether each is signed in, and from where: signed in (OAuth), a stored API key, an environment
  variable (named), models config, or a command-line key. Only stored credentials can be signed
  out; an env var or config key is removed at its source.
- A warning when a credential setting (for example `auth.broker.token`) is set in a project's
  `.omp/config.yml`, which is usually committed.

## Signing in

One sign-in runs at a time per instance (`server.startOmpSignIn`, state streamed by
`server.subscribeOmpSignIn`). The RPC `login` command's UI requests reach the page:

| OMP request | Page                                                                               |
| ----------- | ---------------------------------------------------------------------------------- |
| `open_url`  | "Open sign-in page" button and the link (the short `launchUrl` when OMP sends one) |
| `notify`    | progress text                                                                      |
| `input`     | a prompt card; `secret: true` prompts use a masked field                           |

Answers go back with `server.answerOmpSignIn`; `server.cancelOmpSignIn` stops the login process.
The login process has the 60 s control budget.

## Secrets

- An API key typed on the page travels browser → Ompanel server as a `Redacted` value, and from
  the server to omp only inside the `login` command's `input` field on the process's stdin. It is
  never put in argv, written to Ompanel's state directory (`~/.ompanel`), traced or logged; OMP
  stores it in its own credential store (or its auth broker).
- API-key sign-in needs OMP RPC contract **1.6.0** (oh-my-pi O-8, `login {providerId, input?,
  secretInput?}`). Against an older OMP, Ompanel refuses before sending the key, and the page
  offers no key entry (`apiKeySignIn: false`).
- Ompanel sets `secretInput: true` only for OMP 1.6.0+, so secret prompts are masked; older OMP
  fails such logins instead of prompting in clear text.
- The broker token (`auth.broker.token`) itself is never entered in Ompanel. See below.

## Auth broker

Under the provider list, the Accounts section shows OMP's auth broker settings (web and
desktop; mobile shows neither). OMP keeps credentials on a remote `omp auth-broker serve` host
when `auth.broker.url` is set, and reads both settings from its global config only, so the section
always reads and writes the global layer through the settings engine (`omp config set --scope
global`, `omp config reset`):

- `auth.broker.url`: an ordinary setting, shown with its source and a Reset.
- `auth.broker.token`: shown only as stored or not. The field takes where OMP reads the token,
  never the token: an upper-case environment variable name (`BROKER_TOKEN`) or a `!command` whose
  stdout is the token (`!op read op://vault/broker/token`). OMP resolves either at startup
  (`resolveConfigValue`). The form and the engine both refuse anything else
  (`isOmpSecretReference`), so a token never reaches `omp`'s argv. Without a source OMP uses
  `OMP_AUTH_BROKER_TOKEN` or the token file `omp auth-broker token` writes.
- Either one set by `OMP_AUTH_BROKER_URL` / `OMP_AUTH_BROKER_TOKEN` is read-only.

The OMP settings pages leave both keys out (`OMP_SETTINGS_SHOWN_ELSEWHERE`).

## Signing out

`server.listOmpSignOutAccounts` (RPC `get_logout_accounts`) lists the stored credentials for a
provider; `server.ompSignOut` (RPC `logout`) removes one and reports any source that still
authenticates the provider.
