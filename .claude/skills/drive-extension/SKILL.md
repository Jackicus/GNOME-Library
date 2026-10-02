---
name: drive-extension
description: Where Library is on the nested shell's screen and how to drive it - coordinates of the button, tabs, grid and detail pane in each place, its remote keys and virtual pad, the stand-in library the README's screenshots are taken of, and what must never be pressed. Use with gnome-ext:nested-shell whenever a Library change must be seen (layout, the tabs, Library to Detail navigation, the overview and workspace-slide clones, the preferences).
---

# Driving Library in a nested shell

Read the kit's `gnome-ext:nested-shell` skill first: the loop, `do` and its steps,
its own settings, `--clean`, `--stand-in`, the logs and stopping are all there. This
page adds only what is Library's.

## Never press

CLAUDE.md's list, and why, unless the task asks for exactly that:

- **Play, Continue, or an episode or film row** runs the section's open command (VLC
  by default) on the user's real media, and the tracker then writes their real
  watched marks and positions.
- **Rescan**, or `make scan` (`/scan`, which runs only when the user types it), is an
  online scan with the user's real keys, writing `~/.cache/library@jackicus/` (unless
  under `--stand-in`).
- **A watched disc**, or Mark watched from a key or the pad, outside `--stand-in`, writes
  the real `~/.local/share/library@jackicus/watched.json` and, with `tracking` `source`,
  a `.library-watched.json` into the library folder itself. If a test needs it,
  put both back.

## Its own commands and fixtures

- **`start --stand-in`** (or `--demo`): the made-up library `scripts/demo_library.py`
  draws, written by `./scripts/nested.d/library.sh` into the stand-in home's
  cache (`XDG_CACHE_HOME`), with fresh settings and watched marks of its own. Use it
  for anything that shows library content, and always for `docs/screenshots/`. A
  plain `start` (or `--clean`) has settings of its own too, but the user's real cache
  and watched marks. A shell already running is reused as it is, so `stop` first;
  `status` says which it is (`data:` stand-in or your own).
- **The idle stop** is `NESTED_IDLE=<seconds>` at `start` (default 600, `0` never).
  The nested Wayland display is `library-dev`; the prefs process to kill before
  reopening is the one whose environment names it.
- **`overview on` is a flag, not only a command**: it marks the overview as wanted in
  the run directory and sets `OverviewActive` only if it is not already set, so
  `do "overview on" "shot $S/x.png"` photographs an overview the extension opened (the
  button pressed from the desktop) where a bare `shot` would dismiss it. `run python3
  scripts/nested_driver.py …` carries the same environment as `do`.
- **Remote keys**: `key XF86OK`, `XF86Back`, `XF86HomePage`, `XF86ChannelUp` and the
  rest a remote sends work as `key` steps, against the `keys-*` defaults.
- **A game controller is `scripts/vpad.py`**, a virtual Xbox 360 pad on uinput driven
  through a FIFO (`tap A`, `hat down`, `stick right 1.0`, `quit`). It is a real device
  for the whole machine while it runs: `quit` it when done. Start it by its full path
  (`"$PWD/scripts/vpad.py" FIFO &` from the repository): that is the name
  `nested.sh stop` sweeps it by (`NESTED_STRAYS` in `./scripts/ext.conf`). Controller input is acted
  on only while a library is up and no window has the focus, so close the prefs first.
- **Places are settings**: `library-opens-in` and `detail-opens-in`, changed with
  `./scripts/nested.sh run timeout 5 gsettings --schemadir src/schemas set
  org.gnome.shell.extensions.library …` (the nested session's own settings) to
  watch a live switch.
- **The "Allow inhibiting shortcuts" prompt** (capturing `library-shortcut` in the
  prefs) writes the real permission store. If a test answers it, delete the entry
  afterwards (`PermissionStore.DeletePermission gnome shortcuts-inhibitor
  org.gnome.Shell.Extensions.desktop`) so the real session still asks.

## Reading the screen (1600×900)

Measure from a fresh screenshot if the columns, the sections, the accent or the
geometry changed. The nested shell enables Library alone, so the button is in
the overview's dash at about (960, 838); the rest are the defaults' positions with
**Dash to Panel on** (below, "Its own traps"). There is one button, beside Show Apps,
tooltip "Library", and it is the only way in.

- **The button** with Dash to Panel: Show Apps ≈ (30, 875), the library button
  ≈ (90, 875).
- **`desktop` / `workspaces`**: the library on the wallpaper. Header strip y ≈ 83: tabs
  centred (TV Shows ≈ x 765, Films ≈ x 846), Settings ≈ (1508, 83), Close ≈ (1553, 83).
  Grid rows from y ≈ 300, first poster ≈ (325, 300). Which mode: crop the workspace
  indicator, `shot F 0 0 140 30`. A mode change leaves the active workspace where it
  was, so after `workspaces` to `desktop` you may be on a workspace that is no longer
  ours and see bare wallpaper: press the button again, or `stop` + `start`.
- **Detail pane on the surface**: Back (48, 83); group tabs y ≈ 374 from x ≈ 372; rows
  from y ≈ 430 in ≈ 54 px steps; Play (177, 562), never pressed.
- **`menu`**: the overview opens onto the tabs (y ≈ 127, same x) over the grid, rows
  centred at y ≈ 320 and 570. With Games Library's view showing there, pressing ours
  closes the overview and reopens it onto ours.
- **`modal`**: a panel out of the button, about `210,78` to `1390,800`, tabs at y ≈ 104.
- **A pop-up detail** (`detail-opens-in` `menu` or `modal`): the shade's edge is 48 px in
  from the work area, so `click 20 450` closes it, as `key Escape` does.
- **An empty section** shows a centred placeholder with Open Settings: normal until it
  has a folder and a scan.

A workspace slide is over in 250 ms and a `shot` takes longer to fire, so a frame
caught mid-slide is luck; `wait 1` after anything that changes workspace, `wait 0.6`
after opening or closing an item.

## Its own traps

- **A keyboard walk is one unbroken run of `key` steps.** A `say` or `shot` between
  presses takes the keyboard away, and the focus watcher hands it back to the surface,
  not the tile or row that had it.
- **With the library on the surface, a window on its workspace gets no keys** (the
  prefs included). Test typing into a window with `library-opens-in` `menu` or `modal`.
- **The look beside Dash to Panel, Blur my Shell and app folders** (`panel.js`
  `folderLook`) needs them enabled in the nested session's own settings (`run timeout
  5 gsettings set org.gnome.shell enabled-extensions "['library@jackicus',
  'dash-to-panel@jderose9.github.com', 'blur-my-shell@aunetx']"`, then `stop` +
  `start`); not under `--stand-in`, whose home has none of the user's extensions.

## Screenshots for the README

`docs/screenshots/` are taken under `start --stand-in`, never of the user's
library. Full-screen shots go in as JPEG; windows (`window FILE`, the preferences) as
PNG.

Full-screen shots lose the top 32 px, the top bar with the screencast indicator and the
clock: `jpegtran -crop 1600x868+0+32 -copy none -perfect` on the JPEG, lossless because
32 is a whole number of JPEG blocks. They are 1600×868. PNGs go through
`oxipng --opt 4 --strip safe`, which drops the `tEXt` chunks the screenshot carries.
