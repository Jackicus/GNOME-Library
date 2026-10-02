# Compatibility

`metadata.json` claims GNOME Shell 50 only: the one version the extension has
been run on, and the only one the code is written for, with no fallback for an
older shell (`ClickGesture`, the exported `WINDOW_ANIMATION_TIME`,
`Adw.ShortcutLabel`, the stage context's backend). GNOME 51 breaks it
([below](#gnome-51)). This page lists what was run where, every code
path that depends on the version, and what claiming a version takes.

## What has been run, and where

- **The main desktop** (NVIDIA GeForce GTX 1080, proprietary driver 580.178.04;
  CachyOS, Wayland): GNOME Shell 50.5, mutter 50.5, GJS 1.88.1, GLib 2.88.3,
  GTK 4.22.5, libadwaita 1.9.4, libmanette 0.2.13, libsoup 3.6.6,
  gdk-pixbuf 2.44.7. In the nested shell (`./scripts/nested.sh`) with and
  without Dash to Panel and Blur my Shell, the four combinations `panel.js`
  `folderLook()` and `libraryButton.js`'s Dash to Panel branch exist for: all
  four `library-opens-in` places, the pop-up detail pane, `library-shortcut`
  and the preferences' General page. The scanner ran there on a real library
  on a local drive, online against TMDB, TVmaze and Wikipedia, and on a
  made-up library of the awkward cases (other scripts, seasons and extras,
  dot-files, links, covers with and without alpha, one section's folder inside
  the other's, the same film on two drives).
- **The HP all-in-one** (Intel UHD, Mesa; CachyOS, Wayland): GNOME Shell 50.4.
  The extension has been enabled there from `make link`, with no library
  scanned; nothing more is recorded.

Not run anywhere: GNOME 48 or 49, a virtual machine, X11 (gone in mutter 50),
a second monitor (the overview previews draw on the primary monitor only, by
design: [private-api.md](private-api.md#the-overview-previews-and-the-workspace-slide-overviewpreviewjs)).

Most of that went through `make link`, whose entry point is
`./scripts/dev-extension.js`, not the shipped `src/extension.js`; the packed
zip is tested on its own (checklist below).

## Read against the shell's sources

Every reach in [private-api.md](private-api.md) was read in `js/ui/` at the
`48.0`, `49.0`, `50.0` and `51.0` tags of `GNOME/gnome-shell`, and is there in
the same shape at all four, except as noted below. Two shapes differ by
version, and the code handles both:

- **`AppFolderDialog`'s click-away** is a `Clutter.ClickAction` at `48.0` and a
  `Clutter.ClickGesture` from `49.0`; `panel.js` `_addClickAway()` uses the gesture.
- **`group._background`** in `workspaceAnimation.js` is a plain
  `Meta.BackgroundGroup` at `48.0` and `49.0`, and a `WorkspaceBackground`
  holding one from `50.0`. `overviewPreview.js` inserts its clone above
  `group._background.get_first_child()`, which lands above the wallpaper
  either way.

Also read, and the same at all four tags: `WINDOW_ANIMATION_TIME` is 250
(module-private at 48 and 49, exported from 50, where `app.js` imports it);
`_getAppDisplayBoxForState` takes six arguments;
`Main.wm.keepWorkspaceAlive` exists; `DIALOG_SHADE_NORMAL`,
`PAGE_PREVIEW_RATIO`, `DASH_MAX_HEIGHT_RATIO` and `VERTICAL_SPACING_RATIO` are
module-private with the values restated.

## Version-sensitive code

- **`Adw.ShortcutLabel`** (`prefs.js`) is libadwaita 1.8 (GNOME 49) and
  **`Adw.ToggleGroup`** 1.7; **`St.BoxLayout({orientation})`** is 48+ and
  **`-st-accent-color`** 47+. None has a fallback.
- **libmanette** is optional on every version: `controls.js` and `prefs.js`
  `loadManette()` import `gi://Manette` dynamically and go on without it.
- **`enable()`/`disable()`**: the shipped entry point's are synchronous;
  `./scripts/dev-extension.js` has an `async enable()` (the shell awaits it)
  and a synchronous `disable()`.

## GNOME 51

Not claimed, and as written it fails to enable:

1. `st_focus_manager_navigate_from_event()` is gone (`st-focus-manager.h` at
   `51.0`). `panel.js` `vfunc_key_press_event()` calls it, so a key in either
   pop-up panel throws.

`Clutter.get_default_backend()`, gone at `51.0` too, is no longer used:
`controls.js` asks the stage's context for the backend, as the shell itself does
at `50.0` and `51.0`.

Everything else in [private-api.md](private-api.md) is there at `51.0`
(`AppDisplay` is now exported and still extends the unexported `BaseAppView`).
No `disable()` is async, which 51 now rejects.

## Checklist for a new GNOME version

1. Read gjs.guide's "Port Extensions to GNOME Shell N" for anything
   [private-api.md](private-api.md) names, and the libadwaita version it ships
   (at least 1.7).
2. Diff `js/ui/{appDisplay,dash,iconGrid,layout,overviewControls,workspace,
   workspaceAnimation,workspaceThumbnail,workspacesView,windowManager}.js`
   between the last tag read and the new one, for every expression in
   private-api.md's table.
3. Install the zip, not the link: `make uninstall`, `make pack`,
   `gnome-extensions install dist/library-menu@jackicus.shell-extension.zip`,
   log in again.
4. `./scripts/dev.sh logs '10 min ago'`: no `TypeError`, no "No button beside
   Show Apps", no "not laid out as expected".
5. Each `library-opens-in` place with `detail-opens-in` `desktop`, each
   `detail-opens-in` place with the library on `desktop`, and each place with
   itself.
6. Switch workspaces by keyboard and by touchpad with a `workspaces` library or
   pane claimed: it travels with its workspace in the slide and in the
   overview's thumbnails.
7. Lock and unlock with the library open.
8. With Dash to Panel on and off: the button beside Show Apps in both; with
   Blur my Shell on and off: the pop-up's shade follows a folder's.
9. Under `make link`, disable and enable ten times: no errors, and one
   `lib-<checksum>` directory left under
   `$XDG_RUNTIME_DIR/library/shell-<pid>/`, the shell's own.
10. With Dash to Dock or Dash to Panel enabled too, disable each in turn: the
    other's button and the folded workspace row stay.
11. Then add the version to `shell-version`.
