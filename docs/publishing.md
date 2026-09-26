# Publishing to extensions.gnome.org

How to build the upload, what goes in it, and how the extension stands against
the EGO review guidelines. The guidelines are gjs.guide's
[Review Guidelines](https://gjs.guide/extensions/review-guidelines/review-guidelines.html)
and [Best Practices](https://gjs.guide/extensions/review-guidelines/best-practices.html).

Private API use is a separate concern with its own page,
[private-api.md](private-api.md) — this page links to it rather than
repeating what it covers.

## Building the zip

```sh
make pack
```

This runs `scripts/dev.sh pack` (`cmd_pack`), which:

1. checks the schema with `glib-compile-schemas --strict --dry-run
   "$SRC_DIR/schemas"` and stops if it fails — the same check an install
   enforces, run as part of every pack rather than left as a manual step;
2. copies `src/` into a temporary staging directory, strips it with
   `strip_unshipped` (`__pycache__/`, `*.pyc`, every `CLAUDE.md` including
   `src/backend/CLAUDE.md`) and the compiled schema, and copies the repo
   root's `LICENSE` into the stage;
3. runs `gnome-extensions pack --force --extra-source=lib --extra-source=backend
   --extra-source=icons --extra-source=LICENSE -o dist .` from inside that
   staged copy. `gnome-extensions` adds `extension.js`, `metadata.json`,
   `prefs.js`, `stylesheet.css` and every `schemas/*.gschema.xml` itself
   (`command-pack.c`); `lib/`, `backend/`, `icons/` and `LICENSE` all need
   naming because none of them is one of its recognised top-level files;
4. calls `check_pack`, which computes the expected file list (`extension.js
   prefs.js metadata.json stylesheet.css schemas/*.gschema.xml LICENSE`, every
   `lib/*.js`, every `backend/*.py` outside `__pycache__`, every `icons/*.svg`)
   and diffs it against `unzip -Z1` of the built zip, failing loudly and
   naming both what's missing and what shouldn't be there on any mismatch;
5. deletes the staging directory and reports
   `dist/video-library@jackicus.shell-extension.zip`.

What each shipped part is:

- **`extension.js`, `metadata.json`, `prefs.js`, `stylesheet.css`,
  `schemas/*.gschema.xml`** — the entry points and the two files
  `gnome-extensions` always looks for.
- **`LICENSE`** — GPL-2.0-or-later, copied in from the repo root at pack time.
- **`lib/`** — the shell-side implementation: the surface, the grid, the
  detail pane, tracking, playback-following, controls, the wrap/unwrap points
  into Dash to Panel and the overview. All of it runs inside the compositor
  process.
- **`backend/`** — a Python 3 program (`scan_library.py`, `media_scanner.py`,
  `metadata.py`) that walks the configured folders, fetches artwork and
  metadata online, and writes `~/.cache/video-library/library.json`. It is
  not GJS and is not spawned by `extension.js`: the preferences' Rescan
  buttons and `dev.sh scan` both invoke it out-of-process with `python3`. See
  [Scripts, subprocesses and network access](#scripts-subprocesses-and-network-access)
  below — this is the part of the review most worth thinking about before
  uploading.
- **`icons/library-symbolic.svg`** — the one icon, used for the button beside
  Show Apps.

What is left out, and why it is safe to leave out:

- **`src/schemas/gschemas.compiled`** — deleted from the stage before packing.
  GNOME 46 onward compiles the schema on install rather than expecting it in
  the zip (`extensionDownloader.js` runs `glib-compile-schemas --strict` after
  unzipping an EGO download).
- **`__pycache__/`, `*.pyc`** — stripped by `strip_pycache`.
- **`CLAUDE.md`** (root and `src/backend/`) — stripped by `strip_unshipped`.
- **`scripts/`, `README.md`, `docs/`, `.claude/`, `.git`, `dist/`** — never
  part of `src/`, so never seen by the packer at all; `--extra-source` only
  reaches directories under the packed tree.

### Testing the zip before uploading

```sh
make uninstall
make pack
gnome-extensions install dist/video-library@jackicus.shell-extension.zip
# log out and back in, then enable it
```

Do this rather than `gnome-extensions install --force` over the development
link: `--force` deletes the existing extension directory recursively, which
would take the development link (and everything it points at under `src/`)
with it. `make link` restores the development install afterwards.

This is also the only way to exercise exactly what a reviewer receives: `make
link` installs `scripts/dev-extension.js` as the entry point (for
edit-without-restart during development — see
[Avoid interfering with the extension system](#avoid-interfering-with-the-extension-system-meets)
below), which is not what ships. Only an installed zip runs the real
`src/extension.js` and proves the packed `backend/` and `icons/` paths
resolve the way its `this.dir`-relative code expects.

## metadata.json

Current contents:

| Key | Value | Verdict |
|---|---|---|
| `uuid` | `video-library@jackicus` | Valid characters, not under `gnome.org`. Cannot change after the first upload |
| `name` | `Video Library` | Matches the UUID, the schema and the repo name |
| `description` | multi-paragraph, with the TMDB notice | Says what it draws, that Python and a Rescan are needed, where it looks things up, and that it plays nothing itself |
| `settings-schema` | set | Correct; `getSettings()` is called with no arguments in both `lib/app.js` and `prefs.js`, as Best Practices asks |
| `shell-version` | `["50"]` | The only version actually booted (per `CLAUDE.md`, 48 and 49 are audited against the shell's sources, not booted, so they're not claimed yet) |
| `version-name` | `"1.0"` | Valid: letters, numbers, space and period only, ≤ 16 characters |
| `url` | `https://github.com/Jackicus/GNOME-Video-Library` | Set |
| `version` | absent | Correct — EGO assigns and increments this itself; it should never be set here |
| `session-modes` | absent | Correct — the extension only needs `user` mode and the guideline says the key "MUST be dropped" in that case |
| `donations`, `gettext-domain` | absent | Correct; neither is required |

## The review guidelines, point by point

### Only use initialization for static resources: meets

`src/extension.js`'s class body has no constructor; module scope across every
file under `lib/` is `import`, `const`, `class` and `GObject.registerClass()`
definitions — spot-checked in `lib/library.js`, `lib/controls.js` and
`lib/panel.js`, where the only top-level `new` calls are plain values
(`new Set([...])` in `controls.js`, two `new Cogl.Color(...)` constants in
`panel.js`), which is what the guideline allows ("static data structures and
instances of built-in JavaScript objects"). Nothing is instantiated,
connected or scheduled before `enable()` runs.

### Destroy all objects / disconnect all signals / remove main loop sources: meets, spot-checked

`VideoLibraryApp.disable()` (`lib/app.js`) removes the keybinding
(`Main.wm.removeKeybinding('library-shortcut')`), disconnects every
`connectObject` owner it holds (`global.workspace_manager`, `global.display`,
`Main.layoutManager`, `Main.overview`, `global.stage`, the theme context, its
own settings), removes its rebuild timer with `GLib.source_remove`, and calls
`_teardown()`, which removes the focus group
(`global.focus_manager.remove_group`) and disables the browser, tracker,
playback watcher and controls in turn.

Each of those sub-modules was checked directly rather than taken on trust:

- **`lib/playback.js`**'s `PlaybackWatcher.disable()` unsubscribes all three
  D-Bus signal subscriptions it made in `enable()`
  (`bus.signal_unsubscribe`), cancels its `Gio.Cancellable`, and removes the
  30-second poll source.
- **`lib/controls.js`**'s `Controls.disable()` disconnects its settings and
  calls `_stopPads()`, which disconnects every pad, clears the axis map, and
  removes every held key's `GLib.timeout_add` source before clearing the map.
- **`lib/tracking.js`**'s `Tracker.disable()` disconnects its settings and
  cancels its cancellable.
- **`lib/libraryButton.js`** and **`lib/mediaMenu.js`** wrap shell methods
  they do not own (`panel._updateGroupedElements`, the overview layout's
  `_getAppDisplayBoxForState`) and unwrap them chain-safely: each restores the
  stock method only if its own wrap is still the outermost one, so it cannot
  take a wrap installed after it (Games Menu's own, per the coexistence note
  in the root `CLAUDE.md`) down with it.

If a gap exists, it is most likely in a codepath this pass did not reach
(`lib/mediaGrid.js`, `lib/detailView.js`, `lib/widgets.js`,
`lib/overviewPreview.js`'s clone bookkeeping) rather than the modules above.

### Do not use deprecated modules: meets

No `ByteArray`, `imports.mainloop`, `imports.lang` or `Mainloop` anywhere
under `lib/`, `extension.js` or `prefs.js`.

### No GTK in the shell, no shell libraries in the preferences: meets

Nothing under `lib/` or `extension.js` imports `Gtk`, `Gdk` or `Adw`.
`prefs.js` imports `Adw`, `Gtk`, `Gdk`, `Gio`, `GLib` and `Pango`, plus two
shared modules — `lib/library.js` (imports only `Gio`, `GLib`) and
`lib/actions.js` (no imports at all) — neither of which pulls in `Clutter`,
`Meta`, `St` or `Shell`.

### Avoid interfering with the extension system: meets

The shipped `src/extension.js` is a plain, synchronous `enable()`/`disable()`
that statically imports `./lib/app.js` — nothing is staged, checksummed or
dynamically imported from outside the extension's own tree. The
checksum-staging trick that makes `make reload` pick up an edit without a
shell restart (documented in the root `CLAUDE.md`) lives only in
`scripts/dev-extension.js`, which `make link` installs in its place for
development and which never ships. The `_sweepStages` cleanup that keeps that
mechanism from accumulating stale directories lives there too, so it's not a
concern for what a reviewer receives.

### Code must not be obfuscated: meets

Plain ES modules, unminified, throughout.

### No excessive logging: meets

The shipped extension logs only on real failure — a `console.warn` or
`console.error` next to a caught exception (a corrupt `library.json`, a
folder file that failed to write, a scan that failed, a player that could not
be listed or resumed) — which is what the guideline ("MUST NOT print
excessively... use logs only for important messages and errors") allows.
Informational lines — `lib/app.js`'s rebuild notice, `lib/controls.js`'s
libmanette-not-installed notice — go through `src/lib/log.js`'s `note()`,
which only logs when `setVerbose(true)` has been called; only
`scripts/dev-extension.js` (dev-only, never shipped) calls it. The shipped
`extension.js` never logs on a successful enable or an ordinary rebuild.

### Scripts, subprocesses and network access: the review's centre of gravity, still open

The review guidelines' "Scripts and Binaries" rule is that a script "MUST be
written in GJS, unless absolutely necessary," and Best Practices separately
says "Avoid spawning external shell commands where possible... use D-Bus for
system service communication; offload heavy tasks to separate apps
communicating via D-Bus." This extension's `backend/` is a substantial,
non-GJS program: three Python files (`scan_library.py`, `media_scanner.py`,
`metadata.py`) that walk the filesystem, make outbound HTTPS requests to
`api.tvmaze.com`, `api.themoviedb.org` and `en.wikipedia.org` with
`urllib.request`, and write image and JSON files into
`~/.cache/video-library/`. It is launched two ways, both already careful
about the one thing that matters most (never putting a credential on a
command line):

- **From the preferences.** `prefs.js`'s `_scanButton` runs
  `Gio.Subprocess.new(['python3', '<path>/backend/scan_library.py',
  '--from-settings', '--only', <section>, ...], ...)`, with stdout silenced
  and stderr captured only to log a failure. Only ever on a Rescan button
  press — nothing runs on enable, on a timer, or in the background.
- **From the scanner itself.** `scan_library.py --from-settings` reads every
  setting it needs — folders, source order, the online switch, `credentials`
  — by spawning `gsettings get <schema> <key>` per key
  (`_setting`/`_setting_value` in `scan_library.py`) rather than linking
  PyGObject's `Gio.Settings` for it (PyGObject *is* used, but only for
  `GdkPixbuf` in `metadata.py`, to scale artwork on the way into the cache).
  A value read this way is held in memory only long enough to build the
  request that needs it, exactly as CLAUDE.md's API-key rule requires, and is
  never echoed.

None of this is secretive — the root `CLAUDE.md` documents the whole design,
down to which source needs a key and why the scanner reads settings itself
rather than being handed them — but "is this justified" is a judgement call
the guidelines leave to the reviewer, and a bundled Python backend making
outbound network calls on the user's behalf, with an optional third-party API
key stored in GSettings, is exactly the shape of thing the "unless absolutely
necessary" clause exists to gate. The `description` already says so plainly
(above); still worth having ready for the upload notes is *why* this can't
reasonably be GJS — GJS has no equivalent of Python's standard library for
this (a threaded fetch pool, `urllib`; `GdkPixbuf` is available to GJS too,
but the scanning and enrichment logic itself would have to be rewritten
wholesale), and a same-language rewrite under `lib/` would run the network
waits and the folder walk on the compositor's own thread, which `CLAUDE.md`'s
own performance rules ("nothing stats per item", "a long synchronous block is
a dropped frame for the whole desktop") rule out as firmly as the review
guideline does.

Two smaller points under the same heading:

- **`Util.spawn`** (`lib/app.js`) launches the section's configured player
  command (`vlc --fullscreen --play-and-exit --qt-continue=0` by default) to
  open a picked file. The command comes from the user's own GSettings value,
  is parsed with `GLib.shell_parse_argv` inside a `try`/`catch` that reports a
  parse failure rather than swallowing it, and is only spawned once
  `GLib.find_program_in_path` confirms the program exists — otherwise it
  falls back to `Gio.AppInfo.launch_default_for_uri_async`. Disclosed in the
  README and `description` ("a pick opens in VLC, mpv or whichever player you
  choose"); worth naming again in the upload notes alongside the backend.
- **No telemetry, no clipboard access, no privileged subprocess** anywhere in
  `lib/`, `prefs.js` or `backend/` — nothing calls `pkexec`, nothing touches
  `St.Clipboard` or `Gtk.Clipboard`, and nothing phones anywhere but the three
  metadata sources above, each opt-in per section (`<prefix>-online`) and
  each only touched from a Rescan press.

### Extensions must be functional: worth a note, not a risk

The extension does nothing until its button is pressed or a section is
enabled and pointed at a folder — there is no default folder for either TV
Shows or Films, on purpose (a shared Videos folder can't serve both), so a
reviewer who installs it and does nothing else will see an empty library
until they configure one. The `description` already covers this ("Nothing
shows until you add your folders...").

### Extensions must not be AI-generated: know the code

The rule is that the developer must be able to "justify and explain the code
they submit." Spot-checking the patterns Best Practices calls out:

- **Optional chaining on guaranteed APIs.** What remains (`this._browser?.disable()`,
  `this._dashToPanel?.disconnectObject?.(this)`, `this._monitor?.disconnectObject(this)`)
  is consistently on paths that are genuinely optional — a browser that may
  not have been built yet, Dash to Panel not being installed, a controller
  monitor that may never have started — not defensive noise around a
  guaranteed shell API. `private-api.md` explains the private-API instances
  of this pattern in more depth.
- **try/catch that only swallows.** The catches read in `lib/app.js`,
  `lib/playback.js`, `lib/tracking.js` and `prefs.js` each report a real
  failure (`console.warn`/`console.error`, or a UI state change such as the
  Rescan button's "Failed — see logs") rather than discarding the exception.

The comments throughout — this file's own sourcing from `CLAUDE.md` is a
good example — consistently explain *why*, which is what the guideline wants,
though their length and density (the root `CLAUDE.md` alone runs to several
thousand words) is unusual enough that a reviewer skimming for AI tells may
notice it either way.

### metadata.json must be well-formed: meets

See [metadata.json](#metadatajson) above.

### Session modes: meets

No `session-modes` key, so `user` only, satisfying "MUST be dropped if you
are only using `user` mode." A screen lock disables the extension and
unlocking re-enables it; the shipped `extension.js` re-imports the same
`./lib/app.js` URL either way (GJS caches modules by URL for the process's
life), so this is inherently cheap with nothing to rebuild.

### GSettings schemas: meets

The ID `org.gnome.shell.extensions.video-library` and path
`/org/gnome/shell/extensions/video-library/` use the required bases, the
file is named `<schema-id>.gschema.xml`, the XML ships while the compiled
form does not (above), and the schema declares no `gettext-domain`.

### Licensing: meets

GNOME Shell is GPL-2.0-or-later, and "derived works like extensions MUST be
distributed under compatible terms." `LICENSE` (GPL-2.0-or-later) sits at the
repository root and `cmd_pack` copies it into the pack stage and names it to
the packer with `--extra-source=LICENSE`, so it ships without needing to live
under `src/` itself.

### Copyrights and trademarks: no issue found

"Video Library" is not, as far as this review found, a name in current
commercial or trademarked use in this space (unlike this extension's sibling,
Wallpaper Engine, which shares a name with a well-known Steam application).
No copyrighted third-party content — icons, artwork, code — appears to be
bundled; the one shipped icon (`icons/library-symbolic.svg`) is original.

### Wikipedia and TVmaze attribution: open question

TVmaze's and Wikipedia's content is used under CC BY-SA, and both `metadata.json`'s
`description` and the README carry a blanket credit line. What they don't
have is per-item attribution in the UI itself: `lib/detailView.js` shows a
synopsis TVmaze or Wikipedia supplied with no indication, next to it, of
which source it came from. Wikipedia's own reuse terms generally expect
attribution "where you use the content," and a blanket mention in the
extension's description may or may not satisfy that for a synopsis lifted
per-item into the detail pane. Worth deciding before upload whether a small
per-item credit belongs in `detailView.js` next to the synopsis (e.g.
"Synopsis: Wikipedia") when that source is the one that answered, and if so,
whether TMDB and TVmaze need the same treatment for consistency.

### Don't include unnecessary files: meets, verified by tooling

`check_pack` (above, under [Building the zip](#building-the-zip)) diffs the
zip's actual contents against the exact expected file list on every `make
pack`, so a stray file shipping silently is now a build failure rather than
something to catch by reading `unzip -l` by hand.

### Use a linter: meets

`eslint.config.mjs` configures gjs.guide's shared ESLint rules; `make lint`
(`npm run lint` → `eslint .`) currently reports zero errors.

## Private API

What the extension reaches into beyond public GNOME Shell API, what each path
is for, and what breaks if a future GNOME shell changes it, is covered in
[private-api.md](private-api.md) rather than here.

## Before uploading

What's actually left open:

1. **Decide how to answer the Python backend question**, if asked in review
   — see [Scripts, subprocesses and network access](#scripts-subprocesses-and-network-access-the-reviews-centre-of-gravity-still-open).
2. **Decide on per-item Wikipedia/TVmaze attribution** in the detail view —
   see [Wikipedia and TVmaze attribution](#wikipedia-and-tvmaze-attribution-open-question).
3. **Test on GNOME 48 and 49** before claiming them in `shell-version` —
   they're currently audited against the shell's sources only, not booted
   (`docs/compatibility.md`).

## Uploading

- **Web:** log in at https://extensions.gnome.org/upload/, choose
  `dist/video-library@jackicus.shell-extension.zip`, and accept the terms.
- **Command line** (gnome-extensions 49 and later):
  `gnome-extensions upload --accept-tos dist/<uuid>.shell-extension.zip`. It
  prompts for the EGO username and password; `--user`, `--password` and
  `--password-file` exist for CI, with the same caution gjs.guide gives about
  a password ending up in a command line, a log or the environment.

Each upload is reviewed before publication, and review comments land on the
extension's EGO page. EGO assigns and increments `version` itself.
