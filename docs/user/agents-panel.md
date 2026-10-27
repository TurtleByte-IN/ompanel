# Agents panel

Agents can start subagents to work in parallel, and those can start their own. The **Agents**
panel shows a thread's subagents as a tree, and for OMP threads lets you steer, stop and revive
them.

## Open it

- On web and desktop, select **Toggle agents panel** in the chat header, or add **Agents** from
  the panel's **Add panel surface** menu.
- On mobile, tap the agents segment on the floating control above the composer, or tap an OMP
  subagent in the thread's work log.

## What you see

Each row shows a subagent's title, status (**Pending**, **Running**, **Waiting**, **Completed**,
**Failed**, **Cancelled** or **Interrupted**), nesting, model, cost and tokens. A thread with no
subagents shows "No agents yet".

Select a subagent to read its **Transcript**: its messages, tool calls and results. The
transcript keeps loading while the subagent runs.

## Steer, kill and revive

For OMP subagents, on web and desktop:

- **Steer**: type in "Steer this agent…" and select **Send**. The subagent reads the message
  while it works.
- **Kill**: stops a running subagent.
- **Revive**: restarts a finished subagent, with an optional message.

These need permission to operate the thread. Mobile shows the tree and transcripts but not these
controls.

## Limits

- OMP answers only for subagents its current process started. After the thread's OMP process
  restarts, older subagents stay in the panel, but their transcript and controls fail with OMP's
  reason.
- Transcript entries are cut at 4,000 characters each.
