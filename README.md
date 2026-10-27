# Ompanel

Ompanel is a control surface for coding agents. It runs on your own computer and lets you drive the agents there from a local web app, an Electron desktop app, and a mobile app.

Its center is OMP (Oh My Pi), a coding agent that ships inside Ompanel as a sidecar: Ompanel pins one OMP release, bundles it, checks it before running it, and gives it settings pages, sign-in, plugins, subagents and usage views. See the [OMP provider guide](./docs/user/providers-omp.md).

Ompanel also works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, Pi, Muse Code and Google Antigravity. If they're set up on your computer, Ompanel can control them.

Ompanel is a fork of [T3 Code](https://github.com/pingdotgg/t3code), maintained by TurtleByte. It carries its own name, identifiers and artwork; see [docs/omp/branding.md](./docs/omp/branding.md).

## Installation

### Command line

```bash
curl -fsSL https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.ps1 | iex
```

The installer downloads the CLI from [GitHub Releases](https://github.com/TurtleByte-IN/ompanel/releases), verifies it, and links `ompanel` into `~/.local/bin`. Set `OMPANEL_CHANNEL=nightly` to follow nightly builds, or `OMPANEL_VERSION` to pin one version.

Then run `ompanel` to start the server and open the local web app. `ompanel service install` keeps it running in the background, `ompanel update` moves to a newer release, and `ompanel --help` has the full reference.

To try it once without installing, run `npx ompanel@latest` instead.

### Desktop app

Install the latest version of the desktop app from [GitHub Releases](https://github.com/TurtleByte-IN/ompanel/releases).

#### Debian, Ubuntu (`.deb`)

Download the `.deb` from [GitHub Releases](https://github.com/TurtleByte-IN/ompanel/releases), then:

```bash
sudo apt install ./Ompanel-*.deb
```

#### Arch Linux (AUR)

PKGBUILDs for `ompanel-bin` (stable) and `ompanel-nightly-bin` (nightly) live under [`packaging/aur`](./packaging/aur). They are not published to the AUR yet; build them with `makepkg -si`.

Ompanel is not in winget, Scoop or Homebrew yet.

See [Install Ompanel](./docs/user/install.md) for details, including the mobile app.

## The OMP sidecar

OMP needs no separate install: each Ompanel release bundles the OMP release it pins, and OMP updates arrive with Ompanel updates. The OMP provider is off by default. Enable it under **Settings → Providers**, then run [OMP setup](./docs/user/omp-setup.md) to sign in and pick a default model.

- [OMP provider guide](./docs/user/providers-omp.md)
- [OMP accounts](./docs/user/omp-accounts.md), [settings](./docs/user/omp-settings.md) and [plugins and skills](./docs/user/omp-plugins.md)
- How the sidecar is pinned and run: [docs/omp/sidecar.md](./docs/omp/sidecar.md)

## Other providers

Install and sign in to each provider you want to use:

- Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
- Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
- Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
- Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
- OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
- Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

Provider guides: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md) · [OpenCode](./docs/user/providers-opencode.md) · [Antigravity](./docs/user/providers-antigravity.md) · [Pi](./docs/user/providers-pi.md) · [Muse Code](./docs/user/providers-muse.md)

## Some notes

We are very very early in this project. Expect bugs.

## Documentation

Full docs live in [docs/](./docs/README.md). There's no docs site yet.

- [User guides](./docs/README.md#using-ompanel) ([docs/user](./docs/user))
- [OMP integration notes](./docs/omp) for contributors
- [Architecture overview](./docs/internals/overview.md) if you are building from source

## Contributing

### Install `vp`

Ompanel uses Vite+ so you'll need to install the global `vp` command-line tool.

#### macOS / Linux

```bash
curl -fsSL https://vite.plus | bash
```

#### Windows

```bash
irm https://vite.plus/ps1 | iex
```

Checkout their getting started guide for more information: https://viteplus.dev/guide/

### Install dependencies

```bash
vp i
```

Read [CONTRIBUTING.md](./CONTRIBUTING.md) before reporting a bug or opening a PR.

Have a feature request or need support? Open a [GitHub issue](https://github.com/TurtleByte-IN/ompanel/issues).

## License

[MIT](./LICENSE). Ompanel is based on [T3 Code](https://github.com/pingdotgg/t3code) by T3 Tools Inc., also MIT-licensed.
