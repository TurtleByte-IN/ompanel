# Mobile app

The Ompanel mobile app connects to Ompanel running on another machine and lets you follow and
drive its threads from your phone. To get the app, see [Install Ompanel](./install.md#mobile-app);
to connect it, see [Remote access](./remote-access.md).

## OMP on mobile

| What                 | Where                                   | On mobile                                                                                         |
| -------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------- |
| OMP sign-in          | **Settings → Providers**                | Sign in and out, answer prompts, enter API keys ([OMP accounts](./omp-accounts.md))               |
| OMP settings         | **Settings → OMP**                      | Read-only: value, source and restart note ([OMP settings](./omp-settings.md))                     |
| Workspace trust      | **Settings → Threads**                  | **Trust project agent config** for the selected project ([Workspace trust](./workspace-trust.md)) |
| Subagents            | The agents segment above the composer   | Tree and transcripts; no steer, kill or revive ([Agents panel](./agents-panel.md))                |
| Tool cards           | The thread's work log                   | The same cards as on web ([OMP tool and turn cards](./omp-cards.md))                              |
| Agent message alerts | **Settings → General → Agent messages** | Push alerts ([Notifications](./notifications.md))                                                 |
| Usage                | **Usage** in the workspace navigation   | Totals and limits ([Usage and limits](./usage.md))                                                |

## Not on mobile

- Editing OMP settings, plugins, skills and agent files. Use web or desktop.
- The OMP section of the thread menu: Export HTML, Share as gist, Share live and Branch tree.
- Steering, killing or reviving subagents.
- OMP setup (`omp setup` needs a terminal); sign in under **Provider accounts** instead.

## Notifications

Push notifications need Ompanel Connect; see [Mobile notifications](./mobile-notifications.md).
