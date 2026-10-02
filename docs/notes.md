# Notes

Design reasoning that the code keeps to one line or none.

## Preferences

- A section's page adds to `lib/library.js`'s `SECTIONS` only what the preferences say
  about it; its Add menu (`PAGES.*.sources`) is what can be added, while the list in
  use is `<prefix>-sources`, where one source may appear twice with different keys.
- The sources and folders rows are torn down and rebuilt from their settings
  (`<prefix>-sources`, `<prefix>-folders`, `credentials`) on every change rather than
  kept in step by hand; that is also how a key edited on one section's page shows on
  the other's.
- Adding a keyed source takes the lowest slot the section is not already using, so a
  first TMDB row shares the other section's key and a second row is a second key.
  Removing the last row that names a slot removes its key.
- Shortcut capture follows GNOME Settings (`cc-keyboard-shortcut-editor.c`): Escape
  cancels, Backspace clears, a key the system already answers to is refused rather
  than taken over, and the dialog inhibits system shortcuts while it listens so a
  taken key can be named. The extension grabs whatever `library-shortcut` holds, so
  writing the setting is all the preferences do.
- Rescan runs `backend/scanLibrary.js --from-settings`, which reads folders, sources,
  keys and the online switches itself; two scans at once queue on its lock.

## Input, playback and motion

- The shell reads no game controller itself, so without `controls.js` a pad does
  nothing on the desktop; libmanette's mapping gives a known pad the kernel's
  gamepad codes, and an unmapped one (a Pico running as a gamepad) its own.
- The watcher follows players over MPRIS because every player worth naming speaks
  it (VLC, mpv with mpv-mpris, Showtime, Celluloid), so a file counts however it
  was opened.
- `anim.js` `flyClone` flies by translation and scale rather than width and
  height: a clone already paints its source scaled into its box, so the frames
  look the same and nothing is re-allocated for 260 ms.
- The section tabs take the shape of the shell's screenshot/screencast switch
  (`.screenshot-ui-shot-cast-container`), and the primary action is the theme's
  `button.default`, so hover, focus and pressed states are the theme's.

## The surface, the button and the previews

- The surface takes the clicks the wallpaper would have had, its menu included. The
  shell's `addBackgroundMenu` (`backgroundMenu.js`) was tried and dropped: its
  long-press gesture wins over a tile's click, so holding a poster opened the
  wallpaper menu rather than the item.
- The previews are attached on the overview's `showing`, not `shown`: the shell
  builds them before it animates in, so the clones are there from the first frame.
- `icons/library-symbolic.svg` is the television the TV Shows group has in Slider
  Overlay. Its `-symbolic` name makes St recolour it to the theme's foreground.

## Scanner

- **Artwork sizes** (`backend/metadata.js` `POSTER_BOX` 512×768, `BACKDROP_BOX` 960×540).
  St decodes an image whole on the compositor thread and keeps it: a 2830×4000 poster
  costs tens of megabytes to draw a 320 px tile. 768 tall covers the detail hero
  (`detailView.js` `HERO_MAX_HEIGHT`, 560) at scale 1, or a grid cover up to 384 at
  scale 2; a larger cover is drawn scaled up rather than every poster paying for a
  larger decode. The backdrop is the detail pane's dimmed backing.
- **Six lookups at once** (`ENRICH_WORKERS`): the providers are free, and Wikipedia
  answers bursts with HTTP 429.
- The GdkPixbuf and offline measurements are in `src/backend/CLAUDE.md`.
