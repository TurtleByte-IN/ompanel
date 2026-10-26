# Ompanel

Ompanel is an "agent harness control surface". It lets you control the coding agents on your machine from a web app served by your own computer, an Electron-based desktop app, and a mobile app.

Ompanel is a fork of [T3 Code](https://github.com/pingdotgg/t3code), maintained by TurtleByte. It carries its own name, identifiers and artwork; see [docs/omp/branding.md](./docs/omp/branding.md).

Works with your subscriptions on Claude Code, Codex, Cursor, Grok Build, OpenCode, and Google Antigravity. If they're set up on your computer, Ompanel can control them.

## "Wait, what are you selling me?"

Nothing. Ompanel exists to give the best possible development experience with agents, in an app that is performant, remote-ready, and truly open. If it ever goes the wrong direction, you have everything you need to fork it and build the editor that you want.

## Installation

> [!WARNING]
> Ompanel currently supports Codex, Claude, Cursor, Grok Build, OpenCode, and Antigravity. Install and authenticate at least one provider before use:
>
> - Codex: install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`
> - Claude: install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`
> - Cursor: install [Cursor CLI](https://cursor.com/cli) and run `agent login`
> - Grok Build: install [Grok Build CLI](https://x.ai/cli) and run `grok login`
> - OpenCode: install [OpenCode](https://opencode.ai) and run `opencode auth login`
> - Antigravity: enable it in Settings, then use **Install Antigravity** and **Sign in with Google**. No CLI is required.

### Command line

```bash
curl -fsSL https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/TurtleByte-IN/ompanel/main/scripts/install.ps1 | iex
```

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

## Some notes

We are very very early in this project. Expect bugs.

## Documentation

Full docs live in [docs/](./docs). There's no docs site yet.

- [Install and first run](./docs/user/install.md)
- [Permission modes](./docs/user/permission-modes.md)
- [Keyboard shortcuts](./docs/user/keybindings.md)
- [Project settings](./docs/user/project-settings.md)
- [Appearance preferences](./docs/user/appearance.md)
- [Remote access from a phone or another machine](./docs/user/remote-access.md)
- [Connect Claude Code, Codex, ChatGPT and other agents over MCP](./docs/user/outside-agents.md)
- [Keeping app and server in sync](./docs/user/updating.md)
- [Source control integrations](./docs/user/source-control.md)
- Multiple accounts: [Codex](./docs/user/providers-codex.md) · [Claude](./docs/user/providers-claude.md)
- [Run Ompanel as a background service](./docs/user/background-service.md)

Building from source? Start at [docs/internals/overview.md](./docs/internals/overview.md).

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

[MIT](./LICENSE).
