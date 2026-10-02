# Publishing to extensions.gnome.org

How the upload is built and how the extension stands against gjs.guide's
[Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).
Private API is [private-api.md](private-api.md)'s; versions are
[compatibility.md](compatibility.md)'s.

## Building the zip

`make pack` (`./scripts/dev.sh pack`):

1. checks the schema with `glib-compile-schemas --strict --dry-run` and stops
   on a warning;
2. copies `src/` to a stage, drops every `CLAUDE.md` and
   `schemas/gschemas.compiled`, and adds the root `LICENSE`;
3. runs `gnome-extensions pack` there with `--extra-source` for `lib`,
   `backend`, `icons` and `LICENSE` (it adds `extension.js`, `metadata.json`,
   `prefs.js`, `stylesheet.css` and the schema XML itself);
4. `check_pack` diffs the zip against the files that should ship (those, plus
   every `lib/*.js`, `backend/*.js` and `icons/*.svg`) and fails on anything
   missing or extra;
5. writes `dist/library-menu@jackicus.shell-extension.zip`.

The zip carries the schema XML only. GNOME Shell 44 and later compile it on
install (gjs.guide, "Port Extensions to GNOME Shell 44"): `extensionDownloader.js`
`extractExtensionArchive()` runs `glib-compile-schemas --strict` on a
download's `schemas/`, which is why the pack checks `--strict` first.

What ships: the entry points and stylesheet; `lib/`, the shell side, all of it
in the compositor; `backend/`, the scanner, run as its own process (below);
`icons/library-symbolic.svg`, the button's icon; `LICENSE`.

### Testing the zip

`make uninstall`, `make pack`,
`gnome-extensions install dist/library-menu@jackicus.shell-extension.zip`,
then log out and in. Only the zip runs the shipped `src/extension.js` rather
than `make link`'s `./scripts/dev-extension.js`. `make link` puts the
development install back.

## metadata.json

| Key | Value | Note |
|---|---|---|
| `uuid` | `library-menu@jackicus` | Fixed after the first upload |
| `name` | `Library Menu` | |
| `description` | Several paragraphs | Says a Rescan is needed, where titles are looked up, that it plays nothing, and carries the TMDB notice |
| `settings-schema` | `org.gnome.shell.extensions.library-menu` | `getSettings()` takes no argument in `lib/app.js` and `prefs.js` |
| `shell-version` | `["50"]` | [compatibility.md](compatibility.md) |
| `version-name` | `1.0` | |
| `url` | `https://github.com/Jackicus/GNOME-Library-Menu` | |
| `version`, `session-modes`, `donations`, `gettext-domain` | absent | EGO sets `version`; `user` mode only, so no `session-modes` |

## The review guidelines

Checked against both pages as read on 2026-10-02, before the 1.0 release.

- **Initialisation holds only static resources.** Module scope under `lib/` is
  imports, constants, classes and plain values: `let` module state in
  `log.js`, `shape.js`, `mediaGrid.js`, `controls.js` and `overviewPreview.js`,
  a `Set` in `controls.js`, two `Cogl.Color`s in `panel.js` and
  `shape.js`'s `setCornerRadius(DEFAULT_RADIUS)`, which fills a table of
  strings. No GObject instance, signal or source exists before `enable()`.
- **`disable()` undoes `enable()`.** `LibraryApp.disable()` removes the
  keybinding, every `connectObject` owner, the file monitor and its timers,
  calls `_teardown()` (previews, browser, pane, pop-up, focus group,
  container), removes the slide hook, detaches the button, releases the
  workspaces it held and disables the playback watcher, tracker and controls, each of which drops its own
  subscriptions, cancellables and sources. The three wraps of methods it does
  not own come off chain-safely ([private-api.md](private-api.md#chain-safe-wraps)).
- **No deprecated modules** (`ByteArray`, `Mainloop`, `Lang`), **no GTK in the
  shell, no shell in the preferences**: `prefs.js` imports Adw, Gtk, Gdk, Gio,
  GLib and Pango, plus `lib/library.js` (Gio, GLib) and `lib/actions.js` (no
  imports).
- **Not interfering with the extension system.** The shipped `extension.js`
  imports `./lib/app.js` statically; the staging that lets `make reload` pick
  up edits lives only in `./scripts/dev-extension.js`, which never ships.
- **Other extensions.** The guidelines discourage interacting with another
  extension and review it case by case. The one reach, into Dash to Panel's
  panel for the button beside Show Apps, happens only while **Work with Dash
  to Panel** (`dash-to-panel`, off by default) is on: off, nothing of Dash to
  Panel is read or watched. On, it uses Dash to Panel's exported
  `global.dashToPanel` and its `panels-created` signal, and one chain-safe
  wrap ([private-api.md](private-api.md#the-button-beside-show-apps-librarybuttonjs)).
  Say so in the upload notes.
- **No `GObject.run_dispose()`.**
- **Logging.** The shipped extension logs failures only. Informational lines
  go through `lib/log.js` `note()`, which only the development entry point
  turns on.
- **Scripts and network.** The one script is the scanner, in GJS, run as
  `gjs -m backend/scanLibrary.js` in its own process: in the compositor its
  folder walk and network waits would be dropped frames, and in the
  preferences closing the window would kill a scan. It asks
  `api.tvmaze.com`, `api.themoviedb.org`, `en.wikipedia.org`, and for games
  `store.steampowered.com`, Steam's CDN, `id.twitch.tv` and `api.igdb.com`, over Soup 3
  and writes `~/.cache/library-menu@jackicus/`; the extension watches the file it
  writes. Only a Rescan button (`prefs.js` `_scanButton`) or an empty Games tab's
  Find Games (`app.js` `_scan`) starts it, and it reads the keys from the settings,
  so no key is ever on a command line; each source can
  be switched off per section (`<prefix>-online`). The preferences also start
  `gnome-control-center background` from the Accent colour row.
- **Spawning a player.** `lib/app.js` runs the section's
  `<prefix>-open-command` (`vlc --fullscreen --play-and-exit --qt-continue=0`
  by default), parsed with `GLib.shell_parse_argv` and run through
  `Util.spawn` only when `GLib.find_program_in_path` finds it, else
  `Gio.AppInfo.launch_default_for_uri_async`. The description says so; name it
  in the upload notes too.
- **No telemetry, clipboard or privileged subprocess.**
- **Functional out of the box**: neither section has a default folder, so an
  untouched install shows an empty library; the description says to add
  folders and Rescan.
- **Knowing the code**: optional chaining is on genuinely optional paths (a
  browser not built yet, Dash to Panel absent, controller monitoring not
  started), and a `catch` either reports, changes the UI, or says in a
  comment why the failure is expected.
- **Schemas**: ID and path under `org.gnome.shell.extensions`, file named
  after the ID, XML only.
- **Licence**: GPL-2.0-or-later, packed from the root `LICENSE`.
- **No unnecessary files**: `check_pack` enforces it.
- **A linter**: `make lint`, gjs.guide's ESLint rules, run by `make check` and
  CI.

## Decided and open before uploading

1. **Per-item attribution: not shown, by decision.** TVmaze's and Wikipedia's text
   is CC BY-SA; the README and the description credit both, and the pane shows a
   synopsis without a source line, to keep it simple for now.
2. **GNOME 48 and 49** are unclaimed until booted ([compatibility.md](compatibility.md)).

## Uploading

At https://extensions.gnome.org/upload/, or
`gnome-extensions upload --accept-tos dist/library-menu@jackicus.shell-extension.zip`,
which asks for the EGO login (`--user`, `--password-file` exist; keep a
password off command lines and logs). Each upload is reviewed before it is
published, and EGO assigns `version`.
