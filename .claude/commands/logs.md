---
description: Show recent Video Library output from the GNOME Shell journal
argument-hint: "[systemd time spec, e.g. '5 min ago' — defaults to 10 min]"
allowed-tools: Bash(./scripts/dev.sh logs:*)
---

Show what the extension has logged recently.

Time window requested: $ARGUMENTS

Run `./scripts/dev.sh logs "<window>"`, using the window above — or `10 min ago` if
it's empty. Anything systemd accepts works (`5 min ago`, `today`, `09:00`).

Summarise what happened rather than dumping every line: errors and warnings, with any
stack trace in full, and which file it points at. The shipped extension logs failures
only; under the dev entry point (`make link`) it also logs `Enabled from …` on each
enable and `Rebuilt` when a rescan or a setting rebuilds what is built.
