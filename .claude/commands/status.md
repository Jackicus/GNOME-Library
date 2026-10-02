---
description: Report the nested shell's state, then the install mode, the real session's state and the library size (read-only)
allowed-tools: Bash(make status), Bash(./scripts/dev.sh status), Bash(./scripts/nested.sh status)
---

Run `./scripts/nested.sh status` and `./scripts/dev.sh status`. Report in two
parts.

**Nested shell** (where changes are tried):

- **nested**: running or not, its pid, size and idle timeout. Not running is
  normal between tasks.
- **extension**: `ACTIVE` is healthy; `ERROR` means `enable()` threw (`/logs`);
  anything else after a `reload`, see `/logs` too.
- **settings**: always its own, never the user's dconf: `kept between starts`
  (`start --clean` resets them), or `fresh for this run` under `--stand-in`.
- **data**: `stand-in` is the made-up library (`start --stand-in`); `your own` is
  the user's real cache and watched marks.
- **mirror**: open on the desktop, or closed (`./scripts/nested.sh mirror on`).

**Real session (read-only)**, from `./scripts/dev.sh status`, which only reads:

- **install**: `link` means dev mode: the nested shell, and the real one at its
  next login, run `src/` through `scripts/dev-extension.js`; `old-style
  symlink` means the whole directory is one symlink, an older kind of dev
  install, `make link` again; `copy` is a real install (the shipped
  `extension.js`) that won't pick up edits until `make install` is re-run. The
  nested shell reads the same install.
- **state**: the extension's state in the user's own shell. It says nothing about
  the edits in progress, and is never fixed by reloading or enabling there:
  that is the user's to do. `unknown to the running shell` means the UUID was
  never registered there, which needs the user's logout.
- **cache**: `~/.cache/library-menu@jackicus`, holding `library.json`, `posters/`,
  `backdrops/`, `metadata/`.
- **library**: the item count per section in the user's own scan, or `not
  scanned yet` (`/scan`, at the user's request; a test uses
  `start --stand-in`).

If anything is off, say which command fixes it.
