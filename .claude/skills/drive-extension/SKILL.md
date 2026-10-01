---
name: drive-extension
description: Where Video Library is on the nested shell's screen and how to drive it - coordinates of the button, tabs, grid and detail pane in each place, its remote keys and virtual pad, the demo library the README's screenshots are taken of, and what must never be pressed. Use with gnome-ext:nested-shell whenever a Video Library change must be seen (layout, the tabs, Library to Detail navigation, the overview and workspace-slide clones, the preferences).
---

# Driving Video Library in a nested shell

Read the kit's `gnome-ext:nested-shell` skill first: the loop, `do` and its steps,
`--clean`, the logs and stopping are all there. This page adds only what is Video
Library's.

## Never press

CLAUDE.md's list, and why, unless the task asks for exactly that:

- **Play, Continue, or an episode or film row** runs the section's open command (VLC
  by default) on the user's real media, and the tracker then writes their real
  watched marks and positions.
- **Rescan**, or `make scan`, is an online scan with the user's real keys, writing
  `~/.cache/video-library/` (unless under `--demo`).
- **A watched disc**, or Mark watched from a key or the pad, outside `--demo`, writes
  the real `~/.local/share/video-library/watched.json` and, with `tracking` `source`,
  a `.video-library-watched.json` into the library folder itself. If a test needs it,
  put both back.

## Its own commands and fixtures

- **`start --clean --demo`**: the made-up library `scripts/demo_library.py` draws, in a
  cache of its own pointed at through `XDG_CACHE_HOME`. Use it for anything that shows
  library content, and always for `docs/screenshots/`.
- **The idle stop** is `VIDEO_LIBRARY_NESTED_IDLE=<seconds>` at `start` (default 600,
  `0` never). The nested Wayland display is `video-library-dev`; the prefs process to
  kill before reopening is the one whose environment names it.
- **`overview on` is a flag, not only a command**: it marks the overview as wanted in
  the run directory and sets `OverviewActive` only if it is not already set, so
  `do "overview on" "shot $S/x.png"` photographs an overview the extension opened (the
  button pressed from the desktop) where a bare `shot` would dismiss it. `run python3
  scripts/nested_driver.py …` carries the same environment as `do`.
- **Remote keys**: `key XF86OK`, `XF86Back`, `XF86HomePage`, `XF86ChannelUp` and the
  rest a remote sends work as `key` steps, against the `keys-*` defaults.
- **A game controller is `scripts/vpad.py`**, a virtual Xbox 360 pad on uinput driven
  through a FIFO (`tap A`, `hat down`, `stick right 1.0`, `quit`). It is a real device
  for the whole machine while it runs: `quit` it when done. Controller input is acted
  on only while a library is up and no window has the focus, so close the prefs first.
- **Places are settings**: `library-opens-in` and `detail-opens-in`, changed under
  `--clean` with `./scripts/nested.sh run timeout 5 gsettings --schemadir src/schemas
  set org.gnome.shell.extensions.video-library …` to watch a live switch.
- **The "Allow inhibiting shortcuts" prompt** (capturing `library-shortcut` in the
  prefs) writes the real permission store. If a test answers it, delete the entry
  afterwards (`PermissionStore.DeletePermission gnome shortcuts-inhibitor
  org.gnome.Shell.Extensions.desktop`) so the real session still asks.

## Reading the screen (1600×900)

Measure from a fresh screenshot if the columns, the sections, the accent or the
geometry changed; these are the defaults' positions with **Dash to Panel on** (a plain
`start`). Under `--clean` there is no Dash to Panel: the button is in the overview's
dash at about (960, 838). There is one button, beside Show Apps, tooltip "Videos", and
it is the only way in.

- **The button**: Show Apps ≈ (30, 875), the library button ≈ (90, 875).
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
- **Without `--clean`, test the look beside Dash to Panel, Blur my Shell and app
  folders** (`panel.js` `folderLook`): `--clean` has none of them.

## Screenshots for the README

`docs/screenshots/` are taken under `start --clean --demo`, never of the user's
library. Full-screen shots go in as JPEG; windows (`window FILE`, the preferences) as
PNG.
