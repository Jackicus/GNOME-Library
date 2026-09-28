# Backend

API-key handling rules live in the root `CLAUDE.md` and apply here.

The scanner: `scanLibrary.js` (the command line, the settings, the lock, the
merge and the write), `mediaScanner.js` (the folders), `metadata.js` (the
sources and the artwork cache), `files.js` (the file helpers both use) and
`html.js` (TVmaze's markup). Run it by hand with
`gjs -m src/backend/scanLibrary.js --help`, or `make scan`.

## Gotchas

- **Wikipedia rate-limits bursts** (HTTP 429). `fetch` retries with backoff;
  a film that still fails is simply retried on the next scan.
- **A credential is one slotted value.** `credential()` returns a single
  string per slot (`tmdb@1`, `tmdb@2`, …); TMDB is the only provider that
  needs one, and what a second slot is for is in the root `CLAUDE.md`.
- **A title no source had artwork for is not asked about again for a week.**
  `_save` stamps the record with `tried` and the sources that *answered* (a
  source that could not be asked — the network down, a key TMDB refused — is
  left out, and asked next time); `_missed` skips the online loop while the
  same sources are listed and the week has not passed. A source added since
  asks again at once. Without this a home video cost a request per source on
  every scan, forever.
- **A network that cannot be reached takes the rest of the run offline.**
  `fetch` counts transport failures in a row (not HTTP answers) and after
  `OFFLINE_AFTER_FAILURES` refuses to ask; one success starts the count over.
  A thousand-item first scan behind a firewall dropping packets took a quarter
  of an hour to fail otherwise, at a timeout per request.
- **The cached record is read for every listed source, usable or not.** A
  TMDB key blanked in the preferences must not throw away what TMDB fetched
  while it was set; only the online loop is filtered by `_usable`.
- **An install upgrading from a release with music, photos or games cleans
  its cache up on its first scan since, not before.** `_loadIndex` drops any
  `album_`/`game_`-prefixed record from the metadata index on load, and
  `pruneArt` removes a leftover `thumbs/` folder under the cache. Both are
  one-shot sweeps: once a machine has scanned since upgrading, there is
  nothing left to drop, so don't mistake either for dead code.
- **An id is the cache's key, so how one is made does not change.** `slug`
  keeps letters and numbers of every script — JavaScript's `\w` and `\b` are
  ASCII-only, which is why it spells out `\p{L}\p{N}_` — and a scan reuses a
  folder's file list only while its `scan_sig` (folder count, newest mtime
  to the millisecond, the path) reads the same. Change either and every
  poster, backdrop and record is looked for under a new name, or every
  folder is walked again.
- **Ask Gio for `standard::name,standard::type` and nothing else, with
  `NOFOLLOW_SYMLINKS`, when listing.** Then the type comes out of readdir's
  `d_type` and no name is stat'ed; any other attribute is a stat per name,
  which on a share is a round trip each. A link is followed with one
  `query_info` of its own.
- **GdkPixbuf's synchronous calls stop every request.** Scaling is most of
  what a first scan does between requests, and on the main loop it held the
  other five lookups in flight up behind it — two seconds of a five-second
  first scan, measured. `get_file_info_async`, `new_from_stream_*_async` and
  `save_to_streamv_async` run on a worker thread.
- **The lock is a session-bus name**, one per cache folder
  (`org.gnome.shell.extensions.VideoLibrary.Scan.c<hash>`): asking for it is
  refused while another scan holds it, and the bus frees it the moment that
  scan's process ends, however it ends, so there is no lock file to go
  stale; a sandboxed app cannot take a name outside its own. A second scan
  waits for the first; a scan with no session bus at all goes ahead
  unlocked.
- **A name that is not UTF-8 is skipped, not fatal.** GJS cannot turn one
  into a string, so it cannot be opened either; `list` drops just that entry
  and says so. Letting the error through would lose the whole folder — at a
  section's root, the whole section and its artwork.
