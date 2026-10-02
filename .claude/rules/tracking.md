---
paths:
  - "src/lib/tracking.js"
  - "src/lib/playback.js"
  - "src/lib/detailView.js"
  - "src/lib/widgets.js"
---

# Watched marks, playback and Continue

## Marks (`lib/tracking.js`, setting `tracking`)

- Two files of one format: `~/.local/share/library@jackicus/watched.json`, every mark made
  on this machine keyed by absolute path, and `<folder>/.library-watched.json` at
  the top of each folder in `<prefix>-folders`, keyed by the path inside it so another
  machine mounting it elsewhere reads them.
- `local` uses the first alone. `source` also folds each folder's file in (later `at`
  wins; an unmark is kept as `watched: false` so it beats an older mark) and writes each
  folder its share back: on enable, on a folder change, when a rescan lands and on
  every tick. `none` touches neither. `source` to `local` deletes the folder files;
  going back rewrites them.
- The local file is never trimmed. A folder file is written only after it has been
  read, so another machine's marks are never overwritten unseen. The scanner skips
  dot-files and the file sits beside the item folders, so no `scan_sig` moves with it.
- The toggle is the index disc of a detail row (`widgets.js` `createRow` `watched`), for
  sections with `watched: true` in `SECTIONS`. The tracker emits `changed` for every
  flip, which is how a row already built shows a mark it did not make.

## Playback is followed, not driven (`lib/playback.js`)

- The watcher follows any MPRIS player on the session bus with a file under a watched
  folder open, however it was opened. Past `watched-threshold` percent the file is
  marked; short of it, where it stopped is kept in the same entry as `position`, so it
  travels in the folder file too.
- A Play from the library seeks there less `resume-rewind` once the player has the file
  (`resumeNext`, `SetPosition` over MPRIS), which is why the default VLC command turns
  VLC's own `--qt-continue` off.
- MPRIS never announces the position and a closed player cannot be asked, so the
  watcher keeps the last reading and its monotonic time and reckons forward while
  playing: the 30 s poll only corrects drift and catches the threshold; a pause, seek,
  file change, the player going, or a disable each settle the position. Nothing is
  written while a file plays.
- Player controls are a separate extension (Media Controls), not this one.

## Continue (`detailView.js` `_syncPlay`, `Tracker.continueFrom`)

The pane's primary button is the file touched last if it was left partway or unticked,
else the first unwatched episode after it in the numbered seasons (Extras are not part
of the run). With nothing touched, or everything after it watched, it is the scan's own
`playLabel` ("Play S01E01"). It follows `changed`, which a kept position emits too.
