---
description: Show Video Library running in a nested shell, mirrored live on the desktop, and describe what it looks like
argument-hint: "[optional: what to click through first, e.g. 'open a show' or 'the Films tab']"
allowed-tools: Bash(./scripts/nested.sh:*), Bash(make nested:*), Read
---

Show what Video Library currently looks like, following the `gnome-ext:nested-shell`
skill and this repository's `drive-extension` skill (where things are, and what is
never pressed: no Play, no Rescan). The user is watching the mirror window, so `say`
before each step.

Requested: $ARGUMENTS

1. `./scripts/nested.sh start --clean --demo`, or a plain `start` only when what is
   asked is the look beside the user's other extensions (Dash to Panel, Blur my Shell).
2. In **one** `./scripts/nested.sh do …` call, click through to what was requested and
   `shot` into your scratchpad.
3. **Read the PNG** and describe what is actually on screen.
4. `./scripts/nested.sh stop`, even if a step failed.
