# OMP thread menu

Open a thread's menu from its title in the chat header, or right-click the thread in the sidebar.
Threads that run on OMP have an **OMP** section:

| Item                              | What it does                                                                 |
| --------------------------------- | ---------------------------------------------------------------------------- |
| **Export HTML**                   | Downloads the thread's OMP session as one self-contained page                |
| **Share as gist…**                | Uploads the session, encrypted, to a secret GitHub gist with your `gh` login |
| **Share live (outside pairing)…** | Opens a live room on the running session, with links and a QR code           |
| **Stop sharing live**             | Ends the thread's live room                                                  |
| **Branch tree**                   | Shows every branch of the session, with the path the thread continues from   |

With read-only access you keep **Export HTML** and **Branch tree**; the sharing items are
disabled. The mobile app has no OMP section.

## Export HTML

Downloads `omp-session-<id>.html`. Nothing is written into your project. A thread that has not
sent a message yet has no session to export.

## Share as gist

After you confirm, OMP encrypts the session and uploads it as a secret gist using the GitHub CLI.
The link opens on `my.omp.sh` and carries the key after `#`, so the gist alone cannot be read.

You need the GitHub CLI (`gh`) installed and signed in. If it is missing or signed out, the
dialog says so and nothing is uploaded; run `gh auth login` and try again. Ompanel never lets OMP
fall back to another share server.

Typing `/share` in the composer is refused; use this menu item.

## Share live

Share live opens OMP's collaboration room on the thread's running session. Choose
**View only** (guests watch) or **View and prompt** (guests can also prompt, interrupt and answer
dialogs; their prompts run with the thread's permissions), then **Start sharing**. The dialog
shows the browser link with a QR code, the `omp join` link, and who joined.

**The links bypass Ompanel pairing.** Anyone holding one reaches the session through OMP's relay,
outside Ompanel's pairing, scopes and approvals. Share only with people you trust.

- The thread must be running: send a message first.
- The room ends when you select **Stop sharing live**, when the thread's OMP process stops
  (idle release, archive, server shutdown), or on a rewind or fork.
- Share live needs OMP RPC contract 1.7.0. When the bundled OMP is older, the dialog says so and
  **Start sharing** stays disabled.
- Ompanel does not record the links.

## Branch tree

Shows the session's messages, branch summaries and compactions as a tree. Forks are indented, the
active path is highlighted and the latest entry is marked `current`. The thread's session must be
running.
