---
description: Show Video Library running in a nested shell, mirrored live on the desktop, and describe what it looks like
argument-hint: "[optional: what to click through first, e.g. 'open a show' or 'the Films tab']"
allowed-tools: Bash(./scripts/nested.sh:*), Bash(make nested:*), Read
---

Show what Video Library currently looks like, following the `gnome-ext:nested-shell`
skill and this repository's `drive-extension` skill (where things are, and what is
never pressed). The user is watching the mirror window, so `say` before each step.

Requested: $ARGUMENTS

1. `./scripts/nested.sh start --clean --demo`: its own settings and the made-up
   library, nothing of the user's. A shell already running is reused as it is, so
   check `./scripts/nested.sh status` says `settings: its own (--clean)` and
   `library: the made-up one (--demo)`, and `stop` first if not. A plain `start`
   only when what is asked is the look beside the user's other extensions (Dash to
   Panel, Blur my Shell).
2. In **one** `./scripts/nested.sh do …` call, click through to what was requested and
   `shot` into your scratchpad.
3. **Read the PNG** and describe what is actually on screen.
4. `./scripts/nested.sh stop`, even if a step failed. It closes the mirror;
   `./scripts/nested.sh status` then says `not running`.

Never press, unless the user asked for exactly that:

- **Play, Continue, or an episode or film row**: the section's open command (VLC by
  default) plays the user's real media, and the tracker writes their real watched
  marks and positions.
- **Rescan**: an online scan with the user's real keys, writing
  `~/.cache/video-library/`.
- **A watched disc**, or Mark watched from a key or the pad, outside `--demo`: it
  writes the real `watched.json` and, with `tracking` `source`, a file into the
  library folder itself.

Check `./scripts/nested.sh logs` if the screenshot looks wrong or unchanged; a JS
exception leaves the previous UI up and reads as "nothing happened".
