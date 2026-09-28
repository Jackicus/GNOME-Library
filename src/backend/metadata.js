// Online metadata and artwork, cached under ~/.cache/video-library.
//
// Sources, an ordered list per section in the preferences:
//
//   TV shows   tvmaze (keyless) | tmdb (needs a key) | wikipedia (keyless)
//   Films      tmdb (needs a key) | wikipedia (keyless)
//
// The list is tried in order until one of them comes back with the artwork,
// so a section can name several and a title TMDB has never heard of still gets
// a poster from Wikipedia. A source whose credential is not set skips itself
// rather than failing, which is why TMDB can sit in every default list unkeyed.
//
// TMDB is the richest: poster, backdrop, tagline, runtime, genres and a
// rating. TVmaze covers TV well without a key. Wikipedia gives a poster and
// the lead paragraph for almost anything.
//
// A source entry is a name, optionally with a credential slot — "tmdb" is the
// same as "tmdb@1", "tmdb@2" is a second TMDB key to fall back to. Credentials
// arrive from the preferences (the `credentials` setting, read by
// scanLibrary.js) or, for a standalone run, from the environment
// (VIDEO_LIBRARY_TMDB_KEY). Neither is ever argv, so they do not show up in
// `ps`.
//
// Everything degrades to "no metadata" on failure: the UI draws a placeholder
// tile from the title when poster_path is null, so nothing is ever generated
// on disk for a lookup that failed.
//
// Every artwork path handed back is a file inside the cache, scaled to the
// size the desktop draws it at. Both halves of that matter: St decodes an image
// at its full resolution on the compositor thread and keeps the decoded copy,
// so a 2830x4000 poster costs tens of megabytes to draw a 320px tile, and a
// path outside the cache is a path into the media folder — which may be a
// network mount where a single read stalls the whole desktop for seconds.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

import {
    decode, exists, extension, join, modified, names, readJson, remove, removeTree, rename, writeJson,
} from './files.js';
import {unescapeHtml} from './html.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

// Where the extension looks: GLib's answer is the extension's own, so the two
// cannot disagree about XDG_CACHE_HOME.
export const CACHE_DIR = join(GLib.get_user_cache_dir(), 'video-library');
const POSTER_CACHE_DIR = join(CACHE_DIR, 'posters');
const BACKDROP_CACHE_DIR = join(CACHE_DIR, 'backdrops');
const METADATA_CACHE_DIR = join(CACHE_DIR, 'metadata');
// One file for every cached record. A cache can still have one small file per
// item instead, from the first release; those are read once when the index
// has no record for an item, so upgrading re-reads each exactly once and
// never refetches.
const METADATA_INDEX = join(METADATA_CACHE_DIR, 'index.json');
// The index is rewritten this often as well as at the end, so a scan that is
// interrupted loses at most this many freshly fetched records (never artwork,
// which is on disk the moment it lands).
const INDEX_FLUSH_EVERY = 25;
// A title no source had artwork for is not asked about again for this long:
// a home video would otherwise cost a request per source on every scan.
const MISS_RETRY_SECONDS = 7 * 24 * 3600;
// Transport failures in a row (no route, a firewall dropping packets, a
// timeout each) before the rest of the run is taken offline; one success in
// between starts the count over.
const OFFLINE_AFTER_FAILURES = 6;
const USER_AGENT = 'VideoLibrary/2.0';
// Lookups in flight at once. Small deliberately: every provider here is free,
// and Wikipedia answers bursts with 429 (fetch backs off and retries, but the
// polite thing is not to provoke it).
export const ENRICH_WORKERS = 6;

// The largest each kind of artwork is kept at. St decodes an image whole and
// keeps it, so every pixel past what is drawn is memory the compositor holds
// for nothing.
//   poster    768 tall: the detail hero (detailView.js HERO_MAX_HEIGHT, 560)
//             at scale 1, or a grid cover up to 384 at scale 2. A bigger
//             cover — mediaGrid.js gridFor sets no ceiling, and one row of four
//             on a large screen passes it — is drawn scaled up from this
//             rather than every poster paying for a larger decode.
//   backdrop  the detail pane's own backing, dimmed under a veil
const POSTER_BOX = [512, 768];
const BACKDROP_BOX = [960, 540];
const ART_CACHES = [
    [POSTER_CACHE_DIR, POSTER_BOX],
    [BACKDROP_CACHE_DIR, BACKDROP_BOX],
];
// Remembers the caps the cache was last swept to; see fitCachedArt.
const ART_FIT_STAMP = join(CACHE_DIR, 'art-fit.json');

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const TMDB_POSTER_SIZE = 'w780';
const TMDB_BACKDROP_SIZE = 'w1280';

export const PROVIDERS = {
    tv: ['tvmaze', 'tmdb', 'wikipedia'],
    film: ['tmdb', 'wikipedia'],
};
// The list each kind falls back to when nothing was passed in — a standalone
// run with no preferences to read. It matches the schema's defaults.
const DEFAULT_SOURCES = {
    tv: ['tvmaze', 'tmdb@1', 'wikipedia'],
    film: ['tmdb@1', 'wikipedia'],
};
// Sources that need a credential at all — only TMDB does. A source not listed
// here never carries a slot.
const CREDENTIAL_NEEDED = new Set(['tmdb']);
// What wrote a cache entry that predates the "provider" field.
const LEGACY_PROVIDER = {tv: 'tvmaze', film: 'wikipedia'};
const CACHED_FIELDS = ['summary', 'genres', 'rating', 'runtime', 'year', 'tagline', 'seasons'];

// "tmdb@2" is TMDB with its second key.
export function sourceId(entry) {
    return entry.split('@')[0];
}

// A list entry with its credential slot spelled out: "tmdb" and "tmdb@1" are
// the same first TMDB key, and a source that takes no credential never
// carries a slot. Done once, on the way in, so everything below looks a
// credential up by the entry itself.
function normaliseEntry(entry) {
    const name = sourceId(entry);
    if (!CREDENTIAL_NEEDED.has(name))
        return name;
    return entry.includes('@') ? entry : `${name}@1`;
}

// (kind, source) -> the call that asks it.
const LOOKUPS = {
    'tv:tvmaze': (svc, item) => svc._tvmaze(item),
    'tv:tmdb': (svc, item, entry) => svc._tmdb(item, 'tv', entry),
    'tv:wikipedia': (svc, item) => svc._wikipedia(item, 'tv'),
    'film:tmdb': (svc, item, entry) => svc._tmdb(item, 'movie', entry),
    'film:wikipedia': (svc, item) => svc._wikipedia(item, 'film'),
};

function now() {
    return GLib.get_real_time() / 1e6;
}

export function ensureCacheDirs() {
    for (const directory of [POSTER_CACHE_DIR, BACKDROP_CACHE_DIR, METADATA_CACHE_DIR])
        GLib.mkdir_with_parents(directory, 0o755);
}

// A short stable name for a path, for files in the cache named after one.
export function pathKey(path) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, path, -1).slice(0, 20);
}

// --------------------------------------------------------------------------
// Scaling
// --------------------------------------------------------------------------
// GdkPixbuf's asynchronous calls, which read, decode and encode on a worker
// thread. Scaling is most of what a first scan does between requests, and on
// the main loop it would hold every lookup in flight up behind it; this way
// several images are scaled at once while the requests carry on.
function pixbufCall(start, finish) {
    return new Promise((resolve, reject) => {
        start((_source, result) => {
            try {
                resolve(finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

// [width, height] from the file's header, without decoding it.
async function imageSize(path) {
    try {
        const [format, width, height] = await pixbufCall(
            done => GdkPixbuf.Pixbuf.get_file_info_async(path, null, done),
            result => GdkPixbuf.Pixbuf.get_file_info_finish(result));
        return format ? [width, height] : null;
    } catch {
        return null;
    }
}

// The image at `path`, decoded no larger than `side` square, or whole.
async function load(path, side = null) {
    const stream = Gio.File.new_for_path(path).read(null);
    try {
        return await pixbufCall(
            done => side
                ? GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, side, side, true, null, done)
                : GdkPixbuf.Pixbuf.new_from_stream_async(stream, null, done),
            result => GdkPixbuf.Pixbuf.new_from_stream_finish(result));
    } finally {
        stream.close(null);
    }
}

async function save(pixbuf, path, type, keys, values) {
    const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null);
    try {
        await pixbufCall(
            done => pixbuf.save_to_streamv_async(stream, type, keys, values, null, done),
            result => GdkPixbuf.Pixbuf.save_to_stream_finish(result));
    } finally {
        stream.close(null);
    }
}

// Write `src` into `dest`, or over itself, no larger than `box`.
//
// Aspect is kept and a small image is never blown up: the point is to stop
// the shell decoding artwork at a resolution it will not draw, not to make
// anything sharper. JPEG is written at quality 88; anything carrying an alpha
// channel is written as PNG, so a transparent cover does not gain a black
// backing — and with a `dest` it takes the .png name to match, which is why
// the path written is returned rather than assumed. The file is put in place
// with a rename, since the shell may be reading the old one.
//
// Null when it is not an image that can be read, which is the caller's cue
// that there is no artwork rather than an invitation to use the original.
async function fitImage(src, box, dest = null) {
    const size = await imageSize(src);
    if (!size)
        return null;
    const scale = Math.min(1, box[0] / size[0], box[1] / size[1]);
    if (!dest && scale === 1)
        return src; // already within the box: leave the file untouched
    let out = dest ?? src;
    const tmp = `${out}.tmp`;
    try {
        // Loaded no larger than the box's long side either way, so a 90-degree
        // orientation still has its long side whole, then oriented and fitted
        // to the box as it now stands.
        let pixbuf = await load(src, scale < 1 ? Math.min(Math.max(...box), Math.max(...size)) : null);
        pixbuf = pixbuf.apply_embedded_orientation() ?? pixbuf;
        const fit = Math.min(1, box[0] / pixbuf.get_width(), box[1] / pixbuf.get_height());
        if (fit < 1) {
            pixbuf = pixbuf.scale_simple(
                Math.max(1, Math.round(pixbuf.get_width() * fit)),
                Math.max(1, Math.round(pixbuf.get_height() * fit)),
                GdkPixbuf.InterpType.BILINEAR);
        }
        if (pixbuf.get_has_alpha()) {
            // A file rewritten in place keeps the name library.json points at.
            if (dest)
                out = `${out.slice(0, out.length - extension(out).length)}.png`;
            await save(pixbuf, tmp, 'png', [], []);
        } else {
            await save(pixbuf, tmp, 'jpeg', ['quality'], ['88']);
        }
        rename(tmp, out);
        return out;
    } catch (e) {
        print(`Could not scale ${src}: ${e.message}`);
        remove(tmp);
        return null;
    }
}

// The copy already written for `dest`, under either extension.
function cachedCopy(dest) {
    const png = `${dest.slice(0, dest.length - extension(dest).length)}.png`;
    return [dest, png].find(exists) ?? null;
}

// A scaled copy, inside the cache, of artwork that lives outside it.
//
// A cover.jpg beside the media: handing that path to the shell puts a read of
// the media folder on the compositor thread, and that folder may be an
// automount where one read blocks for ten seconds. The copy is named after the
// source path and its mtime, so it is written once and rewritten only when the
// file behind it changes. Getting that mtime is itself a stat of the media
// folder, which is fine out here — the scanner has just walked it.
export async function cacheLocalArt(path, kind = 'poster') {
    if (!path)
        return null;
    const [directory, box] = kind === 'backdrop'
        ? [BACKDROP_CACHE_DIR, BACKDROP_BOX]
        : [POSTER_CACHE_DIR, POSTER_BOX];
    const time = modified(path);
    if (time === null)
        return null;
    const dest = join(directory, `local_${pathKey(path)}_${Math.trunc(time)}.jpg`);
    return cachedCopy(dest) ?? await fitImage(path, box, dest);
}

// Bring every artwork path in the library inside the cache.
//
// A section that was not rescanned, or an item reused from the previous scan
// on its folder signature, can still carry a path outside the cache — and the
// shell must be handed a cache path or nothing at all. Copies already made are
// reused, so for a library that is already right this is a string comparison
// or two per item.
export async function localiseArt(sections) {
    const outside = [];
    for (const items of Object.values(sections)) {
        for (const item of Array.isArray(items) ? items : []) {
            for (const [field, kind] of [['poster_path', 'poster'], ['backdrop_path', 'backdrop']]) {
                const path = item?.[field];
                if (path && !path.startsWith(CACHE_DIR))
                    outside.push([item, field, kind]);
            }
        }
    }
    for (const [item, field, kind] of outside)
        // eslint-disable-next-line no-await-in-loop -- rare, and one at a time is plenty
        item[field] = await cacheLocalArt(item[field], kind);
    return outside.length;
}

// Shrink cached artwork still sitting at full resolution.
//
// Everything written from here on is fitted as it is written, so this is only
// for what is already on disk — and reading one file's dimensions costs about
// as much as opening it, which is too much to pay per poster on every scan. So
// the caps are stamped beside the cache and the sweep is skipped until they
// change. Nothing is refetched: the files are rewritten from themselves.
export async function fitCachedArt() {
    const caps = Object.fromEntries(ART_CACHES.map(([dir, box]) => [GLib.path_get_basename(dir), box]));
    if (JSON.stringify(readJson(ART_FIT_STAMP)) === JSON.stringify(caps))
        return 0;
    let fitted = 0;
    for (const [directory, box] of ART_CACHES) {
        for (const name of names(directory).sort()) {
            const path = join(directory, name);
            /* eslint-disable no-await-in-loop -- a sweep that runs once per change of the caps */
            const size = await imageSize(path);
            if (size && (size[0] > box[0] || size[1] > box[1]) && await fitImage(path, box))
                fitted++;
            /* eslint-enable no-await-in-loop */
        }
    }
    try {
        writeJson(ART_FIT_STAMP, caps);
    } catch {
        // the sweep simply runs again next time
    }
    return fitted;
}

// Delete cached artwork nothing in the library points at any more.
//
// Posters and backdrops are orphaned by items that were renamed or deleted.
// `sections` must be the whole merged library — pruning against one section's
// items would throw away all the others — so this belongs under the scan
// lock, beside the write.
export function pruneArt(sections) {
    const keep = new Set();
    for (const items of Object.values(sections)) {
        for (const item of items ?? []) {
            for (const path of [item.poster_path, item.backdrop_path]) {
                if (path)
                    keep.add(path);
            }
        }
    }
    let removed = 0;
    for (const [directory] of ART_CACHES) {
        for (const name of names(directory)) {
            const path = join(directory, name);
            if (!keep.has(path) && GLib.file_test(path, GLib.FileTest.IS_REGULAR) && remove(path))
                removed++;
        }
    }
    // A thumbnail cache from an older layout, swept away once.
    const thumbs = join(CACHE_DIR, 'thumbs');
    if (GLib.file_test(thumbs, GLib.FileTest.IS_DIR) && !GLib.file_test(thumbs, GLib.FileTest.IS_SYMLINK))
        removeTree(thumbs);
    return removed;
}

// --------------------------------------------------------------------------
// The network
// --------------------------------------------------------------------------
// An answer that was not a success. Unlike a failure to reach the server at
// all, it is not counted towards going offline.
class HttpError extends Error {
    constructor(status, reason) {
        super(`HTTP Error ${status}: ${reason}`);
        this.status = status;
    }
}

// One session per timeout: six seconds for a lookup, ten for an image.
const sessions = new Map();
function session(timeout) {
    if (!sessions.has(timeout)) {
        sessions.set(timeout, new Soup.Session({
            user_agent: USER_AGENT,
            timeout,
            max_conns_per_host: ENRICH_WORKERS,
        }));
    }
    return sessions.get(timeout);
}

function sleep(ms) {
    return new Promise(resolve => {
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            resolve();
            return GLib.SOURCE_REMOVE;
        });
    });
}

// Transport failures seen in a row; see OFFLINE_AFTER_FAILURES.
let failures = 0;

// GET with a polite retry: Wikipedia answers bursts with 429.
//
// A failure to reach the server at all (as against an answer) is counted, and
// after enough of them in a row the rest of the run is refused here rather
// than paid for at a timeout per item: a thousand-item scan with the network
// down would take a quarter of an hour to fail otherwise.
async function fetch(url, timeout) {
    if (failures >= OFFLINE_AFTER_FAILURES)
        throw new Error('the network is unreachable, not asking');
    for (let attempt = 0; ; attempt++) {
        const message = Soup.Message.new('GET', url);
        if (!message)
            throw new Error('not a URL Soup can parse');
        let bytes;
        try {
            // eslint-disable-next-line no-await-in-loop -- a retry waits for the answer before it
            bytes = await session(timeout).send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        } catch (e) {
            failures++;
            if (failures === OFFLINE_AFTER_FAILURES) {
                print(`No answer from the network ${OFFLINE_AFTER_FAILURES} times running; ` +
                    'finishing this scan offline.');
            }
            throw e;
        }
        // status_code, not get_status(): the latter is an enum, and one with no
        // member for 429 — reading it throws rather than returning the number.
        const status = message.status_code;
        if (status >= 200 && status < 300) {
            failures = 0;
            return bytes.toArray();
        }
        if (status !== 429 || attempt === 3)
            throw new HttpError(status, message.get_reason_phrase());
        // eslint-disable-next-line no-await-in-loop -- backing off is the point
        await sleep(1500 * (attempt + 1));
    }
}

async function getJson(url, timeout = 6) {
    return JSON.parse(decode(await fetch(url, timeout)));
}

function query(params) {
    return Object.entries(params)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

// Fetch artwork and leave it no larger than the desktop will draw it.
//
// Providers are asked for the smallest file that still covers `box` where
// they offer a choice, but several only publish the full-resolution original,
// so the shrink after the download is the guarantee rather than the fallback.
// It is fitted under a temporary name and then put in place in one move: the
// shell may be drawing the old file, and a body that is not an image at all
// (an error page) must not become the poster, or it would be kept — it exists
// — and drawn as nothing, not even the placeholder.
class NotAnImage extends Error {}

async function download(url, dest, box, timeout = 10) {
    const data = await fetch(url, timeout);
    const tmp = `${dest}.download`;
    GLib.file_set_contents(tmp, data);
    if (await fitImage(tmp, box) === null) {
        remove(tmp);
        throw new NotAnImage('not an image that can be scaled');
    }
    rename(tmp, dest);
    return dest;
}

// Nothing there to speak of.
function blank(value) {
    return value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
}

// Set a fact a source found; nothing found leaves what is there.
function fill(item, field, value) {
    if (!blank(value))
        item[field] = value;
}

// Tags out, entities decoded — TVmaze hands back both (`<p>`, `&quot;`).
function stripHtml(text) {
    return unescapeHtml((text || '').replace(/<[^>]+>/g, '')).trim() || null;
}

// "X is a 2017 American superhero film", up to its full stop.
const LEAD_IN = /^[^.]*\bis an? (\d{4} )?[^.]*\.\s*/;
// What a cache name may hold of an id: every letter and number of any script,
// and the `~n` a repeated name gets. Stripping either would put two titles,
// or two copies of one name, on the same cache entry.
const UNSAFE = /[^\p{L}\p{N}_~]/gu;

// A folder name as a search term.
//
// TV: 'Boruto Kai' -> 'Boruto'; 'Frieren - Beyond Journeys End' -> 'Frieren'
// (fan-edit suffixes and subtitles confuse TVmaze).
// Films: 'Spider-Man - Homecoming (2017)' -> 'Spider-Man: Homecoming'.
function cleanQuery(title, kind = 'tv') {
    let q = title.replace(/\s*[([]\p{Nd}{4}[)\]]/gu, '');
    if (kind === 'tv') {
        q = q.replace(/\bKai\b/gi, '');
        q = q.replace(/ReZERO/gi, 'Re:Zero');
        q = q.split(' - ')[0];
    } else {
        q = q.replaceAll(' - ', ': ');
    }
    return q.trim();
}

function describe(error) {
    return error?.message ?? String(error);
}

export class MetadataService {
    constructor({online = true, sources = {}, credentials = {}, offlineKinds = []} = {}) {
        this.online = online;
        // Sections whose own switch is off. They still get whatever is already
        // cached; they just never reach for the network.
        this._offlineKinds = new Set(offlineKinds);
        this.sources = {};
        for (const [kind, entries] of Object.entries(DEFAULT_SOURCES))
            this.sources[kind] = entries.map(normaliseEntry);
        for (const [kind, entries] of Object.entries(sources)) {
            if (kind in this.sources && entries) {
                this.sources[kind] = entries
                    .filter(e => PROVIDERS[kind].includes(sourceId(e)))
                    .map(normaliseEntry);
            }
        }
        this._credentials = {...credentials};
        // Slot 1 falls back to the environment, which is how a standalone run
        // (no preferences to read) is given a key.
        this._envCredentials = {tmdb: (GLib.getenv('VIDEO_LIBRARY_TMDB_KEY') ?? '').trim()};
        this._warned = new Set(); // source names already complained about
        this._refused = new Set(); // entries whose key the source rejected
        this._unflushed = 0;
        ensureCacheDirs();
        this._index = this._loadIndex();
    }

    // -- sources ---------------------------------------------------------
    // One source entry's credential (its API key), or "" if it has none.
    credential(entry) {
        let raw = this._credentials[entry];
        if (!raw && entry.endsWith('@1'))
            raw = this._envCredentials[sourceId(entry)];
        return (raw || '').trim();
    }

    // Whether this entry can run at all. A source whose credential is missing
    // skips itself, which is what lets TMDB sit unkeyed in every default list
    // rather than being an error.
    _usable(entry) {
        if (!CREDENTIAL_NEEDED.has(sourceId(entry)))
            return true;
        if (this._refused.has(entry))
            return false;
        if (this.credential(entry))
            return true;
        const name = sourceId(entry);
        if (!this._warned.has(name)) {
            this._warned.add(name);
            print(`${name}: no credential set, skipping it wherever it is listed.`);
        }
        return false;
    }

    // Give an entry up for the rest of the run — its key was rejected — and
    // say so once, rather than a failure line per item.
    _refuse(entry, why) {
        if (this._refused.has(entry))
            return;
        this._refused.add(entry);
        print(`${entry}: ${why}; skipping it for the rest of this scan.`);
    }

    // Whether this kind may go online at all: the run's --offline flag and
    // then the section's own switch.
    onlineFor(kind) {
        return this.online && !this._offlineKinds.has(kind);
    }

    // -- cache helpers ---------------------------------------------------
    _loadIndex() {
        const data = readJson(METADATA_INDEX);
        if (!data || typeof data !== 'object' || Array.isArray(data))
            return Object.create(null);
        // `album_`/`game_` records predate this build's sections; dropped
        // rather than carried forward forever unread. The next flush writes
        // the index back without them.
        const kept = Object.create(null); // keyed by id, which may be any name
        for (const [key, record] of Object.entries(data)) {
            if (key.startsWith('album_') || key.startsWith('game_'))
                this._unflushed++;
            else
                kept[key] = record;
        }
        return kept;
    }

    // An item's cache key and artwork files. TV shows keep the bare id, so
    // posters already on disk are not fetched twice under a new name.
    _paths(item) {
        const prefix = item.kind === 'tv' ? '' : `${item.kind}_`;
        const safe = `${prefix}${item.id}`.replace(UNSAFE, '');
        return [safe, join(POSTER_CACHE_DIR, `${safe}.jpg`), join(BACKDROP_CACHE_DIR, `${safe}.jpg`)];
    }

    // The cached record for `key`, from the index or — once, when a cache
    // still has one — from that item's own file. A show called "Index" has
    // the index's own name, and no file of its own.
    _record(key) {
        if (Object.hasOwn(this._index, key) || key === 'index')
            return this._index[key] ?? null;
        const data = readJson(join(METADATA_CACHE_DIR, `${key}.json`));
        if (!data || typeof data !== 'object' || Array.isArray(data))
            return null;
        this._index[key] ??= data;
        // Dirty, so the fold-in is written out even by a run that fetches
        // nothing; otherwise every scan would keep reading the old files.
        this._unflushed++;
        return data;
    }

    _applyCached(item, provider, data, posterFile, backdropFile) {
        if (data === null || data === undefined)
            return false;
        // Older caches lack these; a changed provider means fetch afresh.
        const cachedBy = data.provider || LEGACY_PROVIDER[item.kind];
        if (!Object.hasOwn(data, 'year') || cachedBy !== provider)
            return false;
        for (const field of CACHED_FIELDS) {
            if (data[field] !== null && data[field] !== undefined && blank(item[field]))
                item[field] = data[field];
        }
        if (!item.poster_path) {
            if (!exists(posterFile))
                return false; // text was cached but the artwork never arrived: retry
            item.poster_path = posterFile;
        }
        if (exists(backdropFile))
            item.backdrop_path = backdropFile;
        item.provider = cachedBy;
        return true;
    }

    // Record what the sources came back with — or, with `provider` null, that
    // none of them had anything, keeping whatever facts an earlier run
    // cached. When nothing was found, or no artwork arrived, the time and the
    // sources that were `asked` and answered go in too, so the same question
    // is not put to the same sources again for a while (_missed) — a title
    // with a cover of its own and no match online included. A source that
    // could not be asked — the network down, a key refused — is not among
    // them, and is asked next time.
    _save(item, provider, key, asked, previous) {
        let record = {};
        if (provider) {
            for (const field of CACHED_FIELDS)
                record[field] = item[field] ?? null;
            record.genres = item.genres?.length ? item.genres : [];
            record.provider = provider;
        } else {
            for (const [k, v] of Object.entries(previous ?? {})) {
                if (k !== 'tried' && k !== 'sources')
                    record[k] = v;
            }
        }
        if (!provider || !item.poster_path) {
            record.tried = now();
            record.sources = [...asked].sort();
        }
        this._index[key] = record;
        this._unflushed++;
        if (this._unflushed >= INDEX_FLUSH_EVERY)
            this.flush();
    }

    // Whether the same sources were asked for this lately and had no artwork.
    // A source added since, or the window passed, asks again.
    _missed(record, sources) {
        const tried = record?.tried;
        const answered = record?.sources ?? [];
        return Boolean(tried) && now() - tried < MISS_RETRY_SECONDS &&
            sources.every(s => answered.includes(s));
    }

    // Write the record index out. Atomic, so a scan killed mid-write leaves
    // the previous index rather than a truncated one.
    flush() {
        if (!this._unflushed)
            return;
        this._unflushed = 0;
        try {
            writeJson(METADATA_INDEX, this._index, 1);
        } catch (e) {
            print(`Could not write the metadata index: ${e.message}`);
        }
    }

    // -- public ----------------------------------------------------------
    // Fill summary, genres, rating and artwork in place, from the cache or
    // online.
    //
    // The section's sources are tried in order until one comes back with the
    // artwork. A source that knows the facts but has no poster leaves the next
    // one to try for one — it has already written what it knew into the item,
    // and whatever answers last overwrites it — so a list is worth arranging
    // richest-first.
    async enrich(item) {
        const kind = item.kind;
        const listed = this.sources[kind] ?? [];
        if (!listed.length)
            return;
        const [key, posterFile, backdropFile] = this._paths(item);
        const record = this._record(key);
        // A cached record was written by one source; any entry naming that
        // source is still the answer, wherever it now sits in the order — and
        // whether or not it could be asked again now: a key blanked in the
        // preferences must not throw away what it fetched.
        for (const entry of listed) {
            if (this._applyCached(item, sourceId(entry), record, posterFile, backdropFile))
                return;
        }
        if (!this.onlineFor(kind))
            return;
        const entries = listed.filter(e => this._usable(e));
        if (!entries.length || this._missed(record, entries.map(sourceId)))
            return;

        let answered = null;
        const asked = []; // the sources that answered at all, with a result or without
        for (const entry of entries) {
            const name = sourceId(entry);
            const lookup = LOOKUPS[`${kind}:${name}`];
            if (!lookup)
                continue;
            let art;
            try {
                // eslint-disable-next-line no-await-in-loop -- a source is only asked if the one before had no artwork
                art = await lookup(this, item, entry);
            } catch (e) {
                print(`${name} lookup failed for '${item.title}': ${describe(e)}`);
                continue;
            }
            asked.push(name);
            if (!art)
                continue; // nothing found here; the next source gets its turn
            answered = name;
            // eslint-disable-next-line no-await-in-loop -- whether it arrives decides the next source
            const cut = await this._download(item, typeof art === 'string' ? {poster: art} : art,
                posterFile, backdropFile);
            // A poster that did not arrive — a timeout, a dropped connection,
            // a 429 — was never really answered, so it is asked for again
            // next scan rather than put off for a week.
            if (cut)
                asked.pop();
            if (item.poster_path)
                break;
        }

        if (answered)
            item.provider = answered;
        this._save(item, answered, key, asked, record);
    }

    // The artwork a source pointed at, whichever of it the item still lacks;
    // whether the poster was cut off on the way rather than found wanting.
    async _download(item, art, posterFile, backdropFile) {
        let cut = false;
        if (art.poster && !item.poster_path) {
            try {
                item.poster_path = await download(art.poster, posterFile, POSTER_BOX);
            } catch (e) {
                cut = !(e instanceof NotAnImage);
                print(`Artwork download failed for '${item.title}': ${describe(e)}`);
            }
        }
        if (art.backdrop && !item.backdrop_path) {
            try {
                item.backdrop_path = await download(art.backdrop, backdropFile, BACKDROP_BOX);
            } catch (e) {
                print(`Backdrop download failed for '${item.title}': ${describe(e)}`);
            }
        }
        return cut;
    }

    // -- providers -------------------------------------------------------
    async _tvmaze(show) {
        const q = encodeURIComponent(cleanQuery(show.title, 'tv'));
        const results = await getJson(`https://api.tvmaze.com/search/shows?q=${q}`);
        if (!results?.length)
            return null;
        const data = results[0].show ?? {};
        // Facts go in only where this source has them: a source asked after
        // one that answered is asked for the poster the first had none of, and
        // must not blank what the first knew.
        fill(show, 'summary', stripHtml(data.summary));
        fill(show, 'genres', data.genres);
        fill(show, 'rating', data.rating?.average);
        const premiered = (data.premiered || '').slice(0, 4);
        if (!show.year && /^[0-9]+$/.test(premiered))
            show.year = Number(premiered);
        return data.image?.original || data.image?.medium;
    }

    // Poster, backdrop, synopsis, tagline, genres, runtime and rating from The
    // Movie Database. `media` is "movie" or "tv"; `entry` names the key slot,
    // so a list holding "tmdb@1" and "tmdb@2" asks twice with two keys.
    async _tmdb(item, media, entry) {
        const apiKey = this.credential(entry);
        const params = {
            api_key: apiKey,
            query: cleanQuery(item.title, media === 'movie' ? 'film' : 'tv'),
            include_adult: 'false',
        };
        const year = item.year;
        if (year)
            params[media === 'movie' ? 'year' : 'first_air_date_year'] = String(year);

        const search = async () =>
            (await getJson(`${TMDB_API}/search/${media}?${query(params)}`)).results || [];

        let results;
        try {
            results = await search();
            if (!results.length && year) { // the folder's year may be off by one
                delete params.year;
                delete params.first_air_date_year;
                results = await search();
            }
        } catch (e) {
            // Given up for the run, and said once rather than per title; it
            // still counts as a failure here, not as "TMDB had nothing".
            if (e instanceof HttpError && e.status === 401)
                this._refuse(entry, 'TMDB rejected this key');
            throw e;
        }
        if (!results.length)
            return null;

        const best = results[0];
        const details = await getJson(`${TMDB_API}/${media}/${best.id}?${query({api_key: apiKey})}`);
        fillTmdb(item, media, details, best);
        const poster = details.poster_path || best.poster_path;
        const backdrop = details.backdrop_path || best.backdrop_path;
        return {
            poster: poster ? `${TMDB_IMAGE}/${TMDB_POSTER_SIZE}${poster}` : null,
            backdrop: backdrop ? `${TMDB_IMAGE}/${TMDB_BACKDROP_SIZE}${backdrop}` : null,
        };
    }

    // Poster and lead paragraph from the Wikipedia article.
    async _wikipedia(film, kind = 'film') {
        const title = cleanQuery(film.title, kind);
        const year = film.year;
        const noun = kind === 'film' ? 'film' : 'TV series';
        const terms = year ? `${title} ${year} ${noun}` : `${title} ${noun}`;
        const data = await getJson(
            'https://en.wikipedia.org/w/api.php?action=query&list=search' +
            `&srsearch=${encodeURIComponent(terms)}&srlimit=5&format=json`);
        const hits = data.query?.search ?? [];
        if (!hits.length)
            return null;

        // Prefer an article whose snippet or title mentions the year; else the
        // top hit.
        let best = hits[0];
        if (year) {
            best = hits.find(h => (h.snippet ?? '').includes(String(year)) ||
                (h.title ?? '').includes(String(year))) ?? best;
        }

        const page = encodeURIComponent(best.title.replaceAll(' ', '_'));
        const summary = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`);
        let extract = summary.extract;
        // Drop the "X is a 2017 American superhero film" / "X is a Japanese
        // anime television series" lead-in; the tile already shows the title.
        if (extract)
            extract = extract.replace(LEAD_IN, '') || extract;
        fill(film, 'summary', extract);
        const m = /\b(\d{4})\b/.exec(summary.description || '');
        if (!film.year && m)
            film.year = Number(m[1]);
        return (summary.originalimage || summary.thumbnail)?.source;
    }
}

// The facts in a TMDB details answer, wherever it has them.
function fillTmdb(item, media, details, best) {
    fill(item, 'summary', details.overview || best.overview);
    fill(item, 'tagline', details.tagline);
    fill(item, 'genres', (details.genres || []).filter(g => g.name).map(g => g.name));
    const vote = details.vote_average;
    fill(item, 'rating', vote ? Number(vote.toFixed(1)) : null);
    let date;
    if (media === 'movie') {
        fill(item, 'runtime', details.runtime);
        date = details.release_date || '';
    } else {
        fill(item, 'runtime', details.episode_run_time?.[0]);
        fill(item, 'seasons', details.number_of_seasons);
        date = details.first_air_date || '';
    }
    if (!item.year && /^[0-9]{4}/.test(date))
        item.year = Number(date.slice(0, 4));
}
