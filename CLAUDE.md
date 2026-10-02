# Library

Shared rules for every extension come from the GNOME-EXTENSIONS kit: `../CLAUDE.md` and `../.claude/rules/` (loaded with this file), and the `gnome-ext:*` skills. `.claude/kit.sh` pulls the kit at session start, or, with no kit beside this repository, fetches it and prints its rules into the session.

A GNOME Shell extension (UUID `library@jackicus`) that shows a library of TV shows,
films and games, opened from one button beside Show Apps: in the overview, in a
pop-up panel, on the wallpaper or on a workspace of its own, as a setting says.
`metadata.json` claims GNOME Shell 50 only, and the code is written for 50 alone, with
no fallback for an older shell; 51 breaks it (`docs/compatibility.md`). The name is the same
throughout: `metadata.json`'s `name`, the UUID, the schema
`org.gnome.shell.extensions.library`, the cache and data folders, the
`[Library]` log prefix and the `Library*` GObject class names.

## Layout

- `src/` ships as far as `./scripts/ext.conf`'s `EXT_SHIP` says: the entry points,
  stylesheet and schema, `lib/` and `backend/`'s JS and `icons/`' SVG, never the
  `CLAUDE.md` notes under it (`src/backend/CLAUDE.md`, the scanner's).
- `src/lib/library.js`: `SECTIONS` (TV Shows, Films and Games, in that order) is a
  section's whole identity, its key, `<prefix>-` settings, title and icon. Nothing
  restates it: `prefs.js` imports it and adds only its pages, and the scanner takes
  its folders from the settings. A third section is an entry there plus its schema
  keys. `LIBRARY` is the button's own title ("Library") and icon, read only by
  `libraryButton.js`.
- `src/backend/`: the scanner (below, and `src/backend/CLAUDE.md`).
- `docs/`: `private-api.md` (every reach into shell internals, with what breaks),
  `compatibility.md` (what was checked where), `publishing.md` (the
  extensions.gnome.org zip and the review guidelines), `notes.md` (design reasoning
  the code keeps to a line), `screenshots/` (the README's).
- `scripts/`: the kit's `dev.sh`, `nested.sh`, `nested_driver.py`, `kit.mk` and
  `dev-extension.js` (the entry point `make link` installs, staging `lib/` under
  `$XDG_RUNTIME_DIR/library/shell-<pid>/lib-<checksum>`), changed only in the
  kit; this extension's own `ext.conf`, `dev.d/library.sh` (`scan`, `prune`,
  `stalls`, the `scanner` check, the cache and library `status` lines) and
  `nested.d/library.sh` (the made-up library under `start --stand-in`);
  `demo_library.py` (that library); `stallwatch.py` (`make stalls`, logging to
  `dist/stalls.log`); `vpad.py` (a virtual game controller); `import_settings.py`
  (`./scripts/dev.sh import-settings`: the owner's one-off carry of Video Library's and
  Games Library's settings, cache and watched marks into Library's, never shipped).

Runtime data is `~/.cache/library@jackicus/` (`GLib.get_user_cache_dir()` on both sides,
which is how `start --stand-in` points the extension and the scanner at a cache of
its own): `library.json`, `posters/`, `backdrops/`, `metadata/index.json`. The shell side never
scrapes; it reads the `library.json` the scanner wrote, and a file monitor on it
rebuilds what is built when a rescan lands. **Every artwork path in it is a file in
that cache, already scaled down** (`metadata.js` `POSTER_BOX` 512×768, `BACKDROP_BOX`
960×540), because St decodes a background image at full size on the compositor thread
and keeps it. The JS treats a path outside the cache as missing, and `library.js`
lists the two artwork folders once per load rather than stat a poster each.

## How it fits together

1. **The scanner**, `backend/scanLibrary.js` over `mediaScanner.js` (the folders)
   and `metadata.js` (the sources and the artwork cache), runs as `gjs -m` in a
   process of its own, never in the shell or the preferences: its folder walk is
   synchronous, and a share that has idled out takes seconds to answer. It needs
   only Gio, Soup 3 and GdkPixbuf, and imports only `SECTIONS` and `libraryPath`
   from `lib/library.js`. It reads the preferences itself, its only input
   (`--only <section>` narrows it, `--force` re-reads every folder), so the prefs'
   Rescan buttons and `make scan` both just run it. Each section has an ordered list of folders
   (`<prefix>-folders`) and of sources (`<prefix>-sources`: TV tries TVmaze, TMDB,
   Wikipedia; films TMDB, Wikipedia), and its own `<prefix>-online` switch.
   Neither video section has a default folder, so both are off until pointed at one.
   **Games** (`launchers`) has no folders: `gamesScanner.js` reads Steam's and PCSX2's
   own files, auto-detected (`games-steam-path`, `games-pcsx2-path` override), and a
   game's source follows its platform (Steam's store for Steam, IGDB for a PS2 disc).
2. **Credentials** are slots in one `credentials` setting (`a{ss}`): a source entry
   `tmdb@2` is a second TMDB key to fall back on, and the slot TV and films name is
   the same key; IGDB's client id and secret are tab-separated in one slot (`igdb@1`).
   An empty slot makes its source skip itself. The scanner reads them
   out of GSettings, falling back to `$LIBRARY_TMDB_KEY` for an
   empty slot 1. Each key row's Import button reads `~/Documents/keys/<SERVICE>/`, the
   user's key drop shared with other projects.
3. `extension.js` builds a `LibraryApp` (`lib/app.js`) and enables it. The app
   reads `library.json` and builds whichever places the two "opens in" settings name.
4. **Watched marks and playback** (`lib/tracking.js`, `lib/playback.js`): the
   extension plays nothing. A pick runs the section's `<prefix>-open-command` (VLC by
   default), a game its own command line (`launch`: `xdg-open steam://rungameid/…` or
   PCSX2 with the disc), closing what was up first; the watcher follows any MPRIS player with a file from a watched folder
   open, marks it past `watched-threshold`, keeps where it stopped, and the detail
   pane's Continue button resumes there. `.claude/rules/tracking.md`.

## Where it opens

`library-opens-in` (the grid) and `detail-opens-in` (a picked item's pane) are read
**independently**, over the same four places: `desktop`, `workspaces` (the
**surface**, drawn on the wallpaper by `app.js` on `Main.layoutManager._backgroundGroup`),
`menu` (the overview's app-grid slot, `mediaMenu.js`; for the pane, a pop-up like an
app folder's, `detailDialog.js`) and `modal` (a folder-style panel over the desktop,
`libraryWindow.js`; for the pane, the same pop-up hosted in `uiGroup` always). The one
thing that follows from the pair is `app.js` `_detailInPlace()`: grid and pane on one
workspace, so a pick flies the artwork into the grid's place. The surface is built
only when either setting is a surface place. The one button (`libraryButton.js`, a
`Dash.ShowAppsIcon` subclass, in the dash or Dash to Panel's panel), `library-shortcut`
and the Home action are the only ways in. `.claude/rules/places.md` has how each place
behaves.

**The library grid is the shell's own app grid** (`mediaGrid.js`, a subclass of the
`BaseAppView` that `AppDisplay` is built on): pages, swipe, dots and paging come with
it. A tile is an `AppViewItem` around a `BaseIcon` styled `overview-tile`; ours is
only the poster shape, cells the theme's gap apart, and pages built only within reach
of the one showing. **The keyboard is St's** focus groups, and remotes and
controllers are the keyboard too: `.claude/rules/keyboard.md`.

## Design rules

- **What the shell has, Library uses**: the app grid, `AppViewItem` and
  `overview-tile`, `icon-button` and `button`, `global.focus_manager`, the dash's
  `DashItemContainer`, and for both pop-ups `AppFolderDialog`'s shape and
  `app-folder-dialog` style (`panel.js` `MediaPanel` is a copy, not a subclass). Ours
  is only the tab bar, the detail pane and its rows.
- **Motion** is `anim.js` alone: 120 ms (hover, leaving), 200 ms ease-out-quad (the
  rest), and 260 ms for the hero flight, the one duration past the kit's 250. A
  workspace change is the shell's slide, with no reveal of ours behind it.
- **One radius.** `corner-radius` (default 18) is the only one; `shape.js` scales it
  for artwork, hero, pane and badge, and every rounded surface sets it inline. The
  stylesheet's `border-radius` values are fallbacks matching the default; pills stay
  `9999px`. The exception is `paneInner`, the pop-up pane inside the folder's frame:
  the outer radius less `PANE_INSET`, so the curves are concentric.
- **One set of style settings for every view**: `columns` (4–10), `rows` (1–3),
  `corner-radius`, `detail-size` (80–120 %, the pop-up pane's share of the work
  area, applied in `panel.js` `_budget()`), `grid-align`. No view keeps a copy, and
  a change rebuilds what is built.
  `.claude/rules/layout.md` has how the grid and the pane size themselves.
- **The neutrals are the dark palette's** (`#222226`, `#fafafb`) on purpose: the
  surface sits on the wallpaper. A light variant would be a class synced from
  `Main.getStyleVariant()`; not worth doing until asked.
- **Placeholders are drawn**, an accent-tinted tile in `widgets.js`, so nothing stale
  is cached and an accent change shows at once.
- **Nothing builds an actor per thing owned** (`lazyList.js` fills the detail lists
  as they scroll), **nothing is built on a frame that is animating** (the pane puts
  up its artwork first and its second column on the next idle; the group list waits
  for the opening move, `detailView.js` `_fillList`, a timer), and **nothing stats
  per item**.

## Traps of its own

- **A library folder can be a share that has idled out or is offline.** On the main
  desktop the library is on systemd-automounted network shares (60 s idle timeout); an
  offline one blocks whatever touches it for the connect timeout (11 s, measured
  there). In `prefs.js` that is how long the window takes to open; in `lib/` the whole
  desktop stands still. Only the cache folder, which is local, is read synchronously. A
  stale `~/.local/share/recently-used.xbel` entry on an offline share stalls every
  Recent listing (`gvfsd-recent` stats each).
- **`backend/scanLibrary.js` takes its folder from `import.meta.url`**, the one
  exception to the kit's rule: it is never staged, running straight from the
  extension directory in a process of its own.
- **Private shell API** is listed in `docs/private-api.md`, with what breaks when each
  piece moves (a symptom after an upgrade is looked up in its table); a new reach goes
  there in the same pull request.
- **Measuring something just built**: `anim.js` `allocateNow()` lays out an actor
  shown this frame (a clone flight measures NaN otherwise) and `ensureStyleDeep()`
  styles a whole subtree; nothing is measured before them.

## Checking and landing

`make check` is everything that runs without a shell, and what CI runs: `make lint`
(ESLint), then `./scripts/dev.sh check`: the schema under
`glib-compile-schemas --strict --dry-run`, then `scanner` (`EXT_CHECKS`): the
scanner's imports (`gjs -m src/backend/scanLibrary.js --help`, in a scratch home) and
a byte-compile of `scripts/*.py`. The scanner needs Soup 3, which `.github/ci-packages`
adds to CI. It ends with `size` against `EXT_BUDGET_LINES` (8200: the size after the first
simplify pass, rounded up to the next hundred; the owner's call on features comes next).

Seeing a change is the nested shell: the `gnome-ext:nested-shell` skill, then this
repository's `drive-extension` skill (where things are, the `--stand-in` library the
screenshots are taken of). The nested shell's settings are always its own, but a start
without `--stand-in` reads the user's real cache and watched marks. Unless the task
asks, **never press Play, Continue, an episode or film row, a watched disc or Rescan,
and never run `make scan`**: they reach the user's real player and media, watched marks
and API keys (the skill says how).
`/reload`, `/logs`, `/status` and `/preview` use the nested shell, the real session only
read and labelled so; `make reload` is the user's own session, theirs to run, and `/scan`
is the real scan, run only when the user types it.

## Running next to other extensions

Docks, Dash to Panel, Blur my Shell and Wallpaper FX reach the same places, so
nothing here assumes it is the only extension in the shell: every registered
GObject class is `Library*`, stylesheet classes are `ml-`, the pop-up's blur effect
is `library-panel-blur` (`panel.js` `BLUR`), and the three wraps (Dash to Panel's
`_updateGroupedElements`, the overview layout's `_getAppDisplayBoxForState`, the
workspace slide's `_prepareWorkspaceSwitch`) are chain-safe
(`docs/private-api.md`, "Chain-safe wraps").
