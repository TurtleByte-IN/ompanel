# OMP setup

A fresh OMP install has no default model and no sign-in. Until it has one, its provider card reads
**Needs setup** rather than an error, and OMP threads cannot start.

## Where to set it up

- **Welcome wizard.** On the **Check your agents** step OMP is listed first. Select **Set up** to
  open the setup terminal. See [Welcome wizard](./welcome-wizard.md).
- **Settings → Providers → an OMP instance → OMP setup.** The three steps below, each marked
  done, current or pending. It shows for an enabled OMP instance.
- The composer, model picker and provider banner offer **Open provider setup**, which goes to the
  OMP instance in Settings.

## The steps

1. **Find OMP.** Shows the `omp` binary the instance runs and where it came from: **Bundled with
   Ompanel**, **Downloaded by Ompanel** or **Custom path**. If OMP is missing or fails its check,
   the step shows why, with **Check again**.
2. **Run omp setup.** Opens a terminal with `omp setup` (and the instance's `--profile`) typed but
   not run. Review it and press Enter. OMP's own wizard signs you in to a provider and picks a
   default model. While the terminal is open, Ompanel checks again every 5 seconds;
   **Check again** checks at once.
3. **Sign in under Accounts.** Once OMP is ready, the page scrolls to
   [Accounts](./omp-accounts.md). This step is optional: a local model or an API key in the
   environment needs no sign-in.

You can skip step 2 and sign in under Accounts directly: Accounts works before setup.

## Limits

- Setup runs in the instance's environment, so it uses that instance's environment variables and
  profile.
- Threads need a model: they start once setup or a sign-in gives OMP one.
