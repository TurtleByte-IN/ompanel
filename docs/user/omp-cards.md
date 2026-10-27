# OMP tool and turn cards

In an OMP thread, each tool call appears as a card in the work log that updates as the tool runs.
Select a card to see its details. The mobile work log shows the same cards.

## Tool cards

| Tool                                        | Card                                                                                                  |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Shell commands                              | The command, its live output and a non-zero exit code                                                 |
| File edits and writes                       | The file, a diff, and added and removed line counts                                                   |
| Structural edits (`ast_edit`)               | The proposed change, marked "Proposed: files not modified yet" until the agent applies or discards it |
| Todo list                                   | The todo list once the call ends                                                                      |
| Questions the agent asked (`ask`)           | The answers you gave                                                                                  |
| Debugger (`debug`)                          | State, stop reason, stack **Frames**, **Scopes** and **Locals**, and evaluation results               |
| Language server (`lsp`)                     | The action, server, file and symbol, and the result                                                   |
| Code evaluation (`eval`)                    | Each cell's code, output, status and duration, with images inline                                     |
| Image generation                            | The generated pictures, provider, model and saved paths                                               |
| Text to speech                              | An audio player for the generated file                                                                |
| Memory (`recall`, `retain`, ...)            | The operation, query or items, and the result                                                         |
| `xd://` devices and other `scheme://` paths | Labelled with the device or scheme                                                                    |
| Anything else                               | The arguments and the result text                                                                     |

Images and audio are served from your own server; nothing is fetched from elsewhere.

A structural edit has no apply or discard buttons: OMP decides, and the card turns **Applied** or
**Discarded**.

## Turn cards

- **Compaction**: one card per compaction while OMP summarises the context, with the summary when
  it ends.
- **OMP queue**: messages OMP holds while it works; see
  [OMP in the composer](./omp-composer.md#steering-and-the-queue).
- **Agent messages**: messages OMP or an extension shows you mid-turn (for example "Build done").
  See [Notifications](./notifications.md).

## Approval and question cards

When OMP asks before running a tool, an approval card appears above the composer with
**Approve**, **Decline**, and under **More approval options** a choice to approve the narrowest
grant OMP offers (for this session, or always). The thread's
[permission mode](./permission-modes.md) decides when OMP asks.

When OMP or an extension asks a question, a question card appears: pick an option, type an
answer, or both when OMP allows. Some questions have a deadline; when it passes the card closes
and OMP takes its default.
