# Backend

The scanner: `scanLibrary.js` (the settings, `--only` and `--force`, the lock, the
merge and the write), `mediaScanner.js` (the folders), `gamesScanner.js` (Steam's
and PCSX2's files), `metadata.js` (the sources and the artwork cache), `files.js`
(the file helpers they use) and `html.js` (TVmaze's markup). `gjs -m src/backend/scanLibrary.js --help` lists
its flags, and `make check` runs exactly that; `make scan` is a real scan, online
with the user's keys, so it is not a test. The root `CLAUDE.md` has where its
settings and credentials come from.

## How a scan runs

- **One writer at a time.** `library.json` is written atomically under a lock, so
  two rescans cannot each write the other's sections back as they were. Sections
  are merged, so rescanning one keeps the others.
- **Enrichment runs six items at a time** (`ENRICH_WORKERS`): concurrent requests
  on the one main loop, with artwork scaled on GdkPixbuf's worker threads.
- **Sources are tried in order** until one comes back with the artwork; TMDB also
  yields a backdrop, tagline, runtime and rating. Each cache entry records the
  source that wrote it, so a title one of a section's sources already answered is
  not fetched again, and dropping that source refetches on the next scan.
- **Folders.** Every folder of a section is walked into one list (a name found in
  two folders gets a `~2` id). A section switched on and named in the run but with no folder
  is written out empty, so removing its last folder clears it. A folder out of
  reach (a share offline, a drive unplugged, a failed mount), or a show or film
  folder unreadable this time, keeps what the last scan found, artwork included.
  Each section's folders are kept out of the other's walk whichever a run scans: a
  TV folder inside the films folder is not a film when the Films page rescans alone.
- **The artwork cache.** The scanner scales on the way in, copies a cover image
  found beside the media (`mediaScanner.js` `COVER_NAMES`) in with the rest, and prunes the cache on each
  scan.
- **Games are the launchers' bookkeeping, not a folder walk.** `gamesScanner.js`
  reads `steamapps/libraryfolders.vdf` for every library root, one
  `appmanifest_<appid>.acf` per title, `userdata/*/config/localconfig.vdf` for
  playtime, and `PCSX2.ini` for the disc folders and the covers folder. Both roots
  are auto-detected from `~`; a machine without Steam, or with PCSX2 never launched,
  yields an empty list. Proton, the runtimes and the redistributables are skipped.
  Every scan reads them all again: a manifest is one small file. A game carries its
  own `launch` argv; a disc with no PCSX2 found has none, and no Play button.
- **A game's source is its platform's**, whatever the order of `games-sources`: a
  Steam app is Steam's keyless store record and CDN art (for what the client's
  `appcache/librarycache` lacks), a PS2 disc is IGDB's (PCSX2's own cover first).
  The order only decides which IGDB slot is tried first.
- **`metadata/index.json`** holds every cached record.
- **A credential is one slotted value.** `credential()` returns a slot's fields
  (`tmdb@1` has one, `igdb@1` two: Twitch's client id and secret, tab-separated);
  TMDB and IGDB are the sources that need one. Where they come
  from is the root `CLAUDE.md`'s. Never print one.

## Gotchas

- **Wikipedia and Steam's store rate-limit bursts** (HTTP 429). `fetch` retries
  with backoff; an item that still fails is simply retried on the next scan.
- **IGDB is asked with a POST** (Apicalypse: the query is the body) and a bearer
  token minted once per slot per run from the client id and secret; a slot whose
  token is refused is skipped for the rest of the scan.
- **`gamesScanner.js` is a port of Games Library's `games_scanner.py`** and was
  checked against it on the same Steam and PCSX2 fixtures: the same items, field
  for field. Its id rules (`steam_<appid>`, `ps2_<path hash>`) are the cache's keys.
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
- **An id is the cache's key, so how one is made does not change.** `slug`
  keeps letters and numbers of every script — JavaScript's `\w` and `\b` are
  ASCII-only, which is why it spells out `\p{L}\p{N}_` — and a scan reuses a
  folder's file list only while its `scan_sig` (folder count, newest mtime
  to the millisecond, the path) reads the same; only `--force` re-reads the
  lot. The path is in it because the reused list is of absolute paths: a drive
  renamed under an untouched tree must read as changed. Change either and every
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
  (`io.github.jackicus.Library.Scan.c<hash>`): asking for it is
  refused while another scan holds it, and the bus frees it the moment that
  scan's process ends, however it ends, so there is no lock file to go
  stale; a sandboxed app cannot take a name outside its own. A second scan
  waits for the first; a scan with no session bus at all goes ahead
  unlocked.
- **A name that is not UTF-8 is skipped, not fatal.** GJS cannot turn one
  into a string, so it cannot be opened either; `list` drops just that entry
  and says so. Letting the error through would lose the whole folder — at a
  section's root, the whole section and its artwork.
