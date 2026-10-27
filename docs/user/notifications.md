# Notifications

Ompanel tells you when a thread you are not reading finishes, fails, or needs your approval or
input. OMP threads can also alert you when the agent sends you a message while it works.

## Web and desktop

Set these under **Settings → General**:

- **Thread notifications**: the notification sound and system notification. The system
  notification shows only while the Ompanel window is not focused. If your browser blocks
  notifications, sound only is still available.
- **In-app notifications**: a toast inside Ompanel for threads other than the one on screen.
- **Agent messages** (on by default): thread notifications and toasts also fire when the agent
  sends you a message while it works.

## Agent messages

An OMP extension can tell you something mid-turn, for example "Build done". The message appears
in the thread as a card. When you are not reading that thread, it also alerts you, titled with the
thread's name, through the channels above and on your phone.

Archived threads do not alert. Messages that arrived before you opened Ompanel do not alert on
load or reconnect.

## Phones

Phones get alerts through Ompanel Connect; see [Mobile notifications](./mobile-notifications.md).
Turn agent messages off on a phone with **Settings → Notifications → Agent Messages**.

A phone gets an agent message only while the thread is running in the turn that sent it, and only
within two minutes of it being sent. Each message alerts once. This needs a relay that supports
agent messages; until then, desktop and web alerts still work.
