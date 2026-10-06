# Changelog

## 1.1.0 (2026-10-06)

- **Updates:** Orlo checks GitHub releases at launch, every 6 hours and from the command menu. One click downloads the new version, verifies its SHA-256 and restarts.
- **Installer:** releases now include a setup exe next to the portable one.
- **Agent replies** render as Markdown (code, lists, bold, links) instead of raw text.

## 1.0.0 (2026-10-05)

First public release.

**Tasks**
- Tasks with lists, `#tags`, due dates, and a list or board view.
- Sections for Overdue, Today, Upcoming and No date. Agent work sits at the top.

**Agents**
- Delegate a task to the Claude Code, Codex or Grok CLI, choosing a model and reasoning level for Claude and Codex.
- Watch progress live, reply to resume the session, approve to complete, or stop the run.
- Each run is capped at 20 minutes. Claude runs are also limited to 30 turns and a $1.50 budget.

**Notes**
- Live Markdown editing for notes and task notes, with a formatting toolbar.
- Copying gives the raw Markdown.

**Everything else**
- A bell inside the app, Windows notifications, and a daily due reminder.
- A command menu (<kbd>Ctrl</kbd>+<kbd>K</kbd>) and keyboard navigation.
- A first-run tour and little celebrations for your first task, note, agent run and completed task.
