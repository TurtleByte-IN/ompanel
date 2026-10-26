# OMP notify alerts

An OMP extension can tell the user something mid-turn with `ctx.ui.notify(message, type)`.
`omp` sends it as `extension_ui_request` `notify`. Ompanel shows it in the thread and, when the
user is not reading that thread, alerts it on the desktop, in the web app, and on phones.

## The path

1. **Mapper.** `packages/provider-omp/src/server/mapper.ts` turns the request into a `notification`
   turn item with `source: { kind: "agent" }`, the first 200 characters as `summary` and the
   whole message as `detail`. `notifyType: "error"` gives a failed outcome. OMP's own notices keep
   other sources and never alert.
2. **Thread shell.** Every thread shell carries `latestAgentNotification`: the newest `agent`
   notification's item id, summary, time and run (`OrchestrationV2AgentNotificationSummary`). The
   SQLite read uses a partial index added by migration 070 (`070_ShellAgentNotificationIndex`).
   The migration only adds that index; dropping it restores the previous schema with the same
   answers. Older servers omit the field.
3. **Desktop and web.** `ThreadNotificationCoordinator` alerts when a thread's
   `latestAgentNotification` changes to a new item id. The thread title is the title and the
   agent's words are the body. It skips archived threads and a thread's first sighting, so page
   loads and reconnects stay quiet. It uses the existing alert channels: the notification sound and
   system notification under the notification mode (the system notification only while the window
   is unfocused), and an in-app toast, when In-app notifications is on, for threads other than the
   one on screen. Settings > General > Agent messages (`agentMessageNotificationsEnabled`, default
   on) turns this alert off.
4. **Server to relay.** `AgentAwarenessRelay` publishes the thread's agent-activity state when its
   `agentMessage` (`{ id, text, sentAt }`) changes, as it does for phase changes. This needs the
   environment linked to Ompanel Connect with agent-activity publishing on. The agent's words go to
   the relay only while they can still alert, so the relay never keeps them longer than that:
   - only while the thread is `starting` or `running` in the run that sent the message, so after
     Stop or a settle a follow-up run never pushes an earlier run's message;
   - only within two minutes of `sentAt`; when the window closes the server publishes again
     without the words, which replaces the relay's stored copy;
   - only in the unbroken run of publishes that introduced it: once a publish leaves it out (for
     example while the thread waits for input) the message is retired and is not sent again when
     the run resumes, so the relay cannot see it as new and push it twice.
5. **Relay.** The publisher compares the message with the stored row's. It alerts a new message
   only while the thread is `starting` or `running`, once per message id, and only within the
   two-minute freshness window. Attention and terminal phases carry their own alert, so a message
   that arrives with one of them does not ring twice. iPhones get a plain push notification
   (`ApnsDeliveries.sendAgentMessageForTarget`). Android devices get it through the existing FCM
   queue (`agentMessageId` on the job), which rings it only when no attention or completion alert
   rings in the same delivery. Both recheck the device's preferences and the message's age when
   the queued job runs.
6. **Phones.** Settings > Notifications > Agent Messages sets the device's
   `notifyOnAgentMessage` preference on the relay. A device registered before the preference
   existed omits it and gets agent messages. The relay's registration response echoes the
   preference it stored. A relay that predates it drops the preference and does not echo it, so
   a phone with Agent Messages off keeps no registration record and registers again on every
   foreground until a relay confirms "off".

There is no new relay phase: phone apps reject phases they do not know.

## Tests

- Mapper source: `packages/provider-omp/src/server/mapper.test.ts`.
- Shell field from SQLite and memory, and the index: `ProjectionStore.test.ts`,
  `070_ShellAgentNotificationIndex.test.ts`.
- Server publish on a notify-shaped item: `apps/server/src/relay/AgentAwarenessRelay.test.ts`.
- Relay routing, policy and delivery: `AgentActivityPublisher.test.ts`,
  `agentActivityPolicy.test.ts`, `FcmDeliveries.test.ts`, `ApnsDeliveries.test.ts`.
- Web and mobile: `ThreadNotificationCoordinator.logic.test.ts`, `remoteRegistration.test.ts`.
- End to end: `apps/web/e2e/omp/omp-notify.spec.ts` runs a real `omp` with an extension that calls
  `ctx.ui.notify` mid-turn. It checks the toast in another view, the row in the thread, the publish
  at a loopback relay (`apps/web/e2e/omp/relayStub.ts`), and that turning Agent messages off mutes
  the toast.

## Deploying

Phones get these alerts only after the relay with this change is deployed. Deployment is the
relay's usual one ([`infra/relay/README.md`](../../infra/relay/README.md#deployment)); there is no
relay database migration. Until then the hosted relay ignores the new optional fields, and desktop
and web alerts work on their own.
