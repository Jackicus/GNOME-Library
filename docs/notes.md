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
