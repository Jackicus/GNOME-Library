# Video Library

Shared rules for every extension come from the GNOME-EXTENSIONS kit: `../CLAUDE.md` and `../.claude/rules/` (loaded with this file), and the `gnome-ext:*` skills. `.claude/kit.sh` pulls the kit at session start, or, with no kit beside this repository, fetches it and prints its rules into the session.

A GNOME Shell extension (UUID `video-library@jackicus`) that shows a video library,
TV shows and films, opened from one button beside Show Apps: in the overview, in a
pop-up panel, on the wallpaper or on a workspace of its own, as a setting says.
`metadata.json` claims GNOME Shell 50 only; the code is also audited (not booted)
against 48 and 49's sources (`docs/compatibility.md`). The name is the same
throughout: `metadata.json`'s `name`, the UUID, the schema
`org.gnome.shell.extensions.video-library`, the cache and data folders, the
`[Video Library]` log prefix and the `VideoLibrary*` GObject class names.

A sibling, **Games Library** (`games-library@jackicus`, `GNOME-Games-Library`), is
the same idea for games and runs alongside this one: see the last section.

## Layout

- `src/` ships, with one exception: `make install` and `make pack` leave out the
  `CLAUDE.md` notes under it (`src/backend/CLAUDE.md`, the scanner's).
- `src/lib/library.js`: `SECTIONS` (TV Shows and Films, in that order) is a
  section's whole identity, its key, `<prefix>-` settings, title and icon. Nothing
  restates it: `prefs.js` imports it and adds only its pages, and the scanner takes
  its folders from the settings. A third section is an entry there plus its schema
  keys. `LIBRARY` is the button's own title ("Videos") and icon, read only by
  `libraryButton.js`.
- `src/backend/`: the scanner (below, and `src/backend/CLAUDE.md`).
- `docs/`: `private-api.md` (every reach into shell internals, with what breaks),
  `compatibility.md` (what was checked where), `publishing.md` (the
  extensions.gnome.org zip and the review guidelines), `screenshots/` (the README's).
- `scripts/`: `dev.sh`, `nested.sh` and `nested_driver.py`; `dev-extension.js` (the
  entry point `make link` installs); `demo_library.py` (the made-up library behind
  `nested.sh start --clean --demo`); `stallwatch.py` (`make stalls`, logging to
  `dist/stalls.log`); `vpad.py` (a virtual game controller).

Runtime data is `~/.cache/video-library/` (`GLib.get_user_cache_dir()` on both sides,
which is how `--demo` points the extension and the scanner at a cache of its own):
`library.json`, `posters/`, `backdrops/`, `metadata/index.json`. The shell side never
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
   from `lib/library.js`. It reads the preferences itself under `--from-settings`
   (`--only <section>` narrows it), so the prefs' Rescan buttons and `make scan`
   both just run it. Each section has an ordered list of folders
   (`<prefix>-folders`) and of sources (`<prefix>-sources`: TV tries TVmaze, TMDB,
   Wikipedia; films TMDB, Wikipedia), and its own `<prefix>-online` switch.
   Neither section has a default folder, so both are off until pointed at one.
2. **Credentials** are slots in one `credentials` setting (`a{ss}`): a source entry
   `tmdb@2` is a second TMDB key to fall back on, and the slot TV and films name is
   the same key. An empty slot makes its source skip itself. The scanner reads them
   out of GSettings; only a standalone run falls back to `$VIDEO_LIBRARY_TMDB_KEY`
   for slot 1. Each key row's Import button reads `~/Documents/keys/<SERVICE>/`, the
   user's key drop shared with other projects.
3. `extension.js` builds a `VideoLibraryApp` (`lib/app.js`) and enables it. The app
   reads `library.json` and builds whichever places the two "opens in" settings name.
4. **Watched marks and playback** (`lib/tracking.js`, `lib/playback.js`): the
   extension plays nothing. A pick runs the section's `<prefix>-open-command` (VLC by
   default); the watcher follows any MPRIS player with a file from a watched folder
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

- **What the shell has, Video Library uses**: the app grid, `AppViewItem` and
  `overview-tile`, `icon-button` and `button`, `global.focus_manager`, the dash's
  `DashItemContainer`, `AppFolderDialog` for both pop-ups. Ours is only the tab bar,
  the detail pane and its rows.
- **Motion** is `anim.js` alone: 120 ms (hover, leaving), 200 ms ease-out-quad (the
  rest), and 260 ms for the hero flight, the one duration past the kit's 250. A
  workspace change is the shell's slide, with no reveal of ours behind it.
- **One radius.** `corner-radius` (default 18) is the only one; `shape.js` scales it
  for artwork, hero, pane and badge, and every rounded surface sets it inline. The
  stylesheet's `border-radius` values are fallbacks matching the default; pills stay
  `9999px`. The exception is `paneInner`, the pop-up pane inside the folder's frame:
  the outer radius less `PANE_INSET`, so the curves are concentric.
- **One set of style settings for every view**: `columns` (4–10), `rows` (1–3),
  `corner-radius`, `detail-size` (80–120 %, read only by `panel.js` `_budget()`),
  `grid-align`. No view keeps a copy, and a change rebuilds what is built.
  `.claude/rules/layout.md` has how the grid and the pane size themselves.
- **The neutrals are the dark palette's** (`#222226`, `#fafafb`) on purpose: the
  surface sits on the wallpaper. A light variant would be one class synced from
  `Main.getStyleVariant()` and about 17 rules; not worth doing until asked.
- **Placeholders are drawn**, an accent-tinted tile in `widgets.js`, so nothing stale
  is cached and an accent change shows at once.
- **Nothing builds an actor per thing owned** (`lazyList.js` fills the detail lists
  as they scroll), **nothing is built on a frame that is animating** (the pane puts
  up its artwork first and its second column on the next idle; the group list waits
  for the opening move, `detailView.js` `_fillList`, a timer), and **nothing stats
  per item**.

## Traps of its own

- **The shares idle out, and one can be offline.** `/media/LENOVO` and `/media/HP-AIO`
  are systemd automounts with a 60 s idle timeout; an offline one blocks every toucher
  for the connect timeout (11 s, measured). In `prefs.js` that is how long the window
  takes to open; in `lib/` the whole desktop stands still. Only the cache folder, which
  is local, is read synchronously. A stale `~/.local/share/recently-used.xbel` entry on
  an offline share stalls every Recent listing (`gvfsd-recent` stats each).
- **`backend/scanLibrary.js` takes its folder from `import.meta.url`**, the one
  exception to the kit's rule: it is never staged, running straight from the
  extension directory in a process of its own.
- **Private shell API** is listed in `docs/private-api.md`, with what breaks when each
  piece moves; a new reach goes there in the same pull request. If rendering breaks
  after an upgrade, look at `_backgroundGroup`; a held workspace collapsing, at
  `_keepAliveId` (`app.js` `_holdWorkspaces`/`_keepOnly`); an empty overview preview
  or a bare-wallpaper slide, at `overviewPreview.js`'s paths; a missing button, at
  Dash to Panel's `panels` and `_updateGroupedElements`.
- **The 48 floor is the theme's.** No shell class or private field reached is known to
  differ from 48 to 50 (`docs/compatibility.md` says what was confirmed where);
  `-st-accent-color` (47+) and `St.BoxLayout({orientation})` (48+, twelve sites) are
  what stop it going lower. Not worth lowering.
- **`St.Icon.icon_size` is logical**, so `widgets.js` `createArtwork` divides a size
  worked out in physical px by the scale factor.
- **Measuring something just built**: `anim.js` `allocateNow()` lays out an actor
  shown this frame (a clone flight measures NaN otherwise) and `ensureStyleDeep()`
  styles a whole subtree; nothing is measured before them.

## Checking and landing

`make check` is everything that runs without a shell, and what CI runs: `make lint`
(ESLint), then `./scripts/dev.sh check`: the schema under
`glib-compile-schemas --strict --dry-run`, the scanner's imports (`gjs -m
src/backend/scanLibrary.js --help`) and a byte-compile of `scripts/*.py`. The
scanner needs Soup 3, which `.github/ci-packages` adds to CI.

Seeing a change is the nested shell: the `gnome-ext:nested-shell` skill, then this
repository's `drive-extension` skill (where things are, what is never pressed, the
`--demo` library the screenshots are taken of). **Never press Play, Continue or an
episode** (it launches the user's player on their real media, and the tracker
writes their real watched marks) **or Rescan** (an online scan with the user's real
keys) in a nested shell, and never run `make scan` to test, unless the task asks.

## Coexisting with Games Library

The two run enabled at once and subclass the same shell classes, so nothing here may
assume it is the only extension reaching into the shell:

- every registered GObject class is `VideoLibrary*`, never the bare shell name;
  stylesheet classes are `ml-`; the folder look's class is `video-library-panel-blur`
  (`panel.js` `BLUR`), Games Library's `games-library-panel-blur`;
- both wrap Dash to Panel's `_updateGroupedElements` (`libraryButton.js`
  `_attachToPanel`) and the overview layout's `_getAppDisplayBoxForState`
  (`mediaMenu.js` `_foldWorkspaces`) chain-safely, as the kit's rule has it. A wrap
  left in the other's chain goes inert, and the slot the menu measures for its next
  view is asked of the shell's own method (the prototype's), not the wrap beneath,
  which the other may have grown for a view of its own;
- in the `menu` library, our button pressed while Games Library's view fills the
  app-grid slot closes the overview and reopens it onto ours rather than drawing over
  it, and Games Library does the same in reverse (`mediaMenu.js` `open()`, `_next`),
  the one place either reads what the other put there;
- the Home action's default bindings differ (`keys-home`, `pad-home` in each
  schema), so out of the box a remote's or controller's Home drives only one.
