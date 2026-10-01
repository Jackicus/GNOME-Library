---
description: Apply src/ edits to Video Library in the nested shell and check for errors
allowed-tools: Bash(./scripts/nested.sh status), Bash(./scripts/nested.sh start:*), Bash(./scripts/nested.sh reload), Bash(./scripts/nested.sh logs:*), Bash(./scripts/nested.sh mirror:*), Bash(./scripts/nested.sh stop)
---

Apply the current `src/` edits to Video Library in this repository's **nested
shell**, then confirm they took. Never the user's own session: `make reload` and
`./scripts/dev.sh reload` disable and enable the extension on the real desktop,
which is the user's to do.

1. `./scripts/nested.sh status`.
   - **Not running:** `./scripts/nested.sh start --clean` (add `--demo` for a
     library to look at: the made-up one, since `--clean` alone reads the user's
     own cache, and an empty section shows only its placeholder). A fresh start
     loads the current `src/`, so Video Library is ACTIVE with the edits when it
     returns; skip step 2.
   - **Running with `settings: shared with the real session`** (a plain `start`):
     do not reload. A reload rewrites `enabled-extensions` in the user's real
     dconf through that shell's own dconf-service. Say so, and offer
     `./scripts/nested.sh stop` then `start --clean`.
   - **Running with its own settings (`--clean`):** go on.
2. `./scripts/nested.sh reload`. It waits for ACTIVE.
3. `./scripts/nested.sh logs 40` and report whether it came up clean. A healthy
   reload logs `[Video Library] Enabled from
   $XDG_RUNTIME_DIR/video-library/lib-<checksum>` (a new checksum when `lib/`
   changed); `[Video Library] Rebuilt` follows a rescan or a setting's change.
   Anything with `Failed to load`, `Error during disable`, or a JS stack trace
   under a `[Video Library]` line is a real failure: quote it and say which file
   it points at.

How to see it: the mirror window on the desktop shows the nested shell live
(`./scripts/nested.sh mirror on` if `status` says it is closed); the library
opens from its button beside Show Apps, so `/preview` (or the `drive-extension`
skill) opens it and screenshots it. Leave the nested shell running for that, and
stop it (`./scripts/nested.sh stop`) when the work is done. Never press Play,
Continue, an episode or film row, a watched disc or Rescan there: they reach the
user's real player, media, watched marks and keys.

A reload re-imports `lib/` only. An edit to `scripts/dev-extension.js`,
`metadata.json` or the schema's keys needs `./scripts/nested.sh stop` then
`start --clean` (`glib-compile-schemas src/schemas` first, for the schema), not a
reload, and no logout: only the real session needs one, and that is the user's
to do.
