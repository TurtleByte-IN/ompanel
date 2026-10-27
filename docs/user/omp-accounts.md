# OMP accounts

OMP signs in to model providers itself and keeps the credentials in its own store. Ompanel shows
those providers and lets you sign in and out without opening a terminal.

Open **Settings → Providers**, select an OMP instance, and go to **Accounts**. Each instance has
its own accounts, because each [OMP profile](./providers-omp.md#set-up-omp) has its own store.

## What you see

Every provider OMP can use, with its state:

- **Signed in**: an OAuth sign-in.
- **API key**: a key you stored through OMP.
- **Environment**: an environment variable (named) supplies the key.
- **Models config**: a key in OMP's `models.yml`.
- **Command-line key**: a key passed on OMP's command line.
- **Not signed in**.

Only stored credentials (sign-ins and stored keys) can be signed out here. A key from an
environment variable or a config file is removed where it is set.

If a credential setting such as `auth.broker.token` is set in a project's `.omp/config.yml`, the
page warns you: that file is usually committed. Move the key to an environment variable or an OMP
sign-in, and reset it in the project config.

## Sign in

Select **Sign in** next to a provider. One sign-in runs at a time per instance.

- For an OAuth or device-code sign-in, select **Open sign-in page** and finish in your browser.
  If the page does not open, copy the link shown next to the button.
- When OMP asks for a code or other value, a prompt appears on the page. Secret prompts are
  masked.
- For a provider that takes an API key, select **Add API key** (or **Replace key**). The key goes
  only to OMP's credential store; Ompanel does not save, log or trace it.

Select **Cancel sign-in** to stop.

## Sign out

Select **Sign out** next to a provider, then the stored credential to remove. If another source,
such as an environment variable, still authenticates the provider, the page says so.

## Before setup

Accounts works on a fresh OMP install, before `omp setup` has picked a default model. Signing in
here is an alternative to `omp setup`; see [OMP setup](./omp-setup.md).

## Mobile

On the mobile app, open **Settings → Provider accounts**. Each OMP instance shows the same
provider list with sign-in, prompts, API-key entry and sign-out. **Open sign-in page** opens the
provider's page directly on the phone.
