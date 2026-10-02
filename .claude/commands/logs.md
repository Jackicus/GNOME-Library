---
description: Show what Library logged in the nested shell (or, read-only, the real session's journal)
argument-hint: "[N lines of the nested shell's log, default 80; or a systemd time spec such as '5 min ago' for the real session's journal]"
allowed-tools: Bash(./scripts/nested.sh status), Bash(./scripts/nested.sh logs:*), Bash(./scripts/dev.sh logs:*)
---

Show what the extension has logged recently.

Requested: $ARGUMENTS

**The nested shell** is where changes are tried, so its log is the one to read.
If the request above is empty or a number, run `./scripts/nested.sh status`; if a
nested shell is running, `./scripts/nested.sh logs <N>` (80 when none was given;
add `--all` for the D-Bus and portal chatter the default filters out). If none is
running, say so: its log goes with it at `stop`, and a fresh one starts at
`start`.

**The real session's journal**, read-only, only when the request is a time spec
(`5 min ago`, `today`, `09:00`) or asks for the user's own desktop:
`./scripts/dev.sh logs "<window>"`. Head the answer "real session (read-only)":
it is what Library did on the user's desktop, not in the nested shell.

Summarise rather than dump: errors and warnings, with any stack trace in full and
the file it points at. The shipped extension logs failures only; under the dev
entry point (`make link`, which the nested shell reads too) it also logs
`Enabled from …` on each enable and `Rebuilt` when a rescan or a setting rebuilds
what is built. Only `[Library]` lines are this extension's; other
extensions' errors (when enabled in the nested settings) are not. Exceptions inside a GNOME
extension only ever surface in these logs, never in a terminal, so this is the
place to look when something silently does nothing (no button beside Show Apps,
a grid that never fills).
