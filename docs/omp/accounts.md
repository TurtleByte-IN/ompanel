# OMP accounts

Settings → Providers → an OMP instance → **Accounts** lists OMP's login providers with their
auth state and signs in and out of them. Everything goes through short-lived `omp --mode rpc`
control processes (`OmpControlService`), never through a thread's session.

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
- The broker token (`auth.broker.token`) is never entered in Ompanel; OMP reads it from
  `OMP_AUTH_BROKER_TOKEN` or its token file. `auth.broker.url` is an ordinary OMP setting.

## Signing out

`server.listOmpSignOutAccounts` (RPC `get_logout_accounts`) lists the stored credentials for a
provider; `server.ompSignOut` (RPC `logout`) removes one and reports any source that still
authenticates the provider.
