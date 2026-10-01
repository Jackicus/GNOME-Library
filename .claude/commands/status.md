---
description: Report install mode, shell state, and library size
allowed-tools: Bash(make status), Bash(./scripts/dev.sh status)
---

Run `make status` and report the four lines it prints:

- **install** — `link` means dev mode (edits in `src/` are live, entry point
  `scripts/dev-extension.js`); `old-style symlink` means the whole directory is one
  symlink, an older kind of dev install — run `make link` again;
  `copy` means a real install (the shipped `extension.js`) that won't pick up
  edits until `make install` is re-run.
- **state** — `ACTIVE` is healthy. `unknown to the running shell` means the UUID was
  never registered, which needs a logout, not a reload.
- **cache** — `~/.cache/video-library`, holding `library.json`, `posters/`, `backdrops/`, `metadata/`.
- **library** — item count across sections, or `not scanned yet` (run `/scan`).

If anything is off, say which command fixes it.
