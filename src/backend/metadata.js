// Every artwork path handed back is a scaled file inside the cache: St decodes
// an image whole on the compositor thread (CLAUDE.md, docs/notes.md).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GdkPixbuf from 'gi://GdkPixbuf';
import Soup from 'gi://Soup?version=3.0';

import {
    decode, exists, extension, join, modified, names, readJson, remove, rename, writeJson,
} from './files.js';
import {unescapeHtml} from './html.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

export const CACHE_DIR = join(GLib.get_user_cache_dir(), 'library@jackicus');
const POSTER_CACHE_DIR = join(CACHE_DIR, 'posters');
const BACKDROP_CACHE_DIR = join(CACHE_DIR, 'backdrops');
const METADATA_CACHE_DIR = join(CACHE_DIR, 'metadata');
const METADATA_INDEX = join(METADATA_CACHE_DIR, 'index.json');
// An interrupted scan loses at most this many fetched records.
const INDEX_FLUSH_EVERY = 25;
const MISS_RETRY_SECONDS = 7 * 24 * 3600;
const OFFLINE_AFTER_FAILURES = 6;
const USER_AGENT = 'GNOME-Library/1.0 (https://github.com/Jackicus/GNOME-Library)';
export const ENRICH_WORKERS = 6;

// Why these sizes: docs/notes.md.
const POSTER_BOX = [512, 768];
const BACKDROP_BOX = [960, 540];
const ART_CACHES = [
    [POSTER_CACHE_DIR, POSTER_BOX],
    [BACKDROP_CACHE_DIR, BACKDROP_BOX],
];

const TMDB_API = 'https://api.themoviedb.org/3';
const TMDB_IMAGE = 'https://image.tmdb.org/t/p';
const TMDB_POSTER_SIZE = 'w780';
const TMDB_BACKDROP_SIZE = 'w1280';

// Valve's store record and library art, keyless and sessionless.
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com/steam/apps';
const STEAM_STORE_API = 'https://store.steampowered.com/api/appdetails';
// IGDB is Twitch's: a client id and secret buy an app token, sent as a bearer.
const IGDB_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const IGDB_API = 'https://api.igdb.com/v4';
const IGDB_IMAGE = 'https://images.igdb.com/igdb/image/upload';
const IGDB_PS2_PLATFORM = 8;

const PROVIDERS = {
    tv: ['tvmaze', 'tmdb', 'wikipedia'],
    film: ['tmdb', 'wikipedia'],
    game: ['steam', 'igdb'],
};
// How many tab-separated fields a source's credential holds; none means keyless.
const CREDENTIAL_FIELDS = {tmdb: 1, igdb: 2};
const CACHED_FIELDS = ['summary', 'genres', 'rating', 'runtime', 'year', 'tagline', 'seasons'];

function sourceId(entry) {
    return entry.split('@')[0];
}

// "tmdb" is "tmdb@1"; a source without a credential never carries a slot.
function normaliseEntry(entry) {
    const name = sourceId(entry);
    if (!CREDENTIAL_FIELDS[name])
        return name;
    return entry.includes('@') ? entry : `${name}@1`;
}

const LOOKUPS = {
    'tv:tvmaze': (svc, item) => svc._tvmaze(item),
    'tv:tmdb': (svc, item, entry) => svc._tmdb(item, 'tv', entry),
    'tv:wikipedia': (svc, item) => svc._wikipedia(item, 'tv'),
    'film:tmdb': (svc, item, entry) => svc._tmdb(item, 'movie', entry),
    'film:wikipedia': (svc, item) => svc._wikipedia(item, 'film'),
    'game:steam': (svc, item) => svc._steam(item),
    'game:igdb': (svc, item, entry) => svc._igdb(item, entry),
};

function now() {
    return GLib.get_real_time() / 1e6;
}

function ensureCacheDirs() {
    for (const directory of [POSTER_CACHE_DIR, BACKDROP_CACHE_DIR, METADATA_CACHE_DIR])
        GLib.mkdir_with_parents(directory, 0o755);
}

export function pathKey(path) {
    return GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, path, -1).slice(0, 20);
}

// Asynchronous, so scaling runs on a worker thread (backend/CLAUDE.md).
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

// Never scaled up. An image with alpha is saved as PNG (no black backing), so
// the path written is returned. Null when it is not a readable image.
async function fitImage(src, box, dest = null) {
    const size = await imageSize(src);
    if (!size)
        return null;
    const scale = Math.min(1, box[0] / size[0], box[1] / size[1]);
    if (!dest && scale === 1)
        return src;
    let out = dest ?? src;
    const tmp = `${out}.tmp`;
    try {
        // Loaded at the box's long side, so a 90-degree orientation still fits.
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

function cachedCopy(dest) {
    const png = `${dest.slice(0, dest.length - extension(dest).length)}.png`;
    return [dest, png].find(exists) ?? null;
}

// Named after the source path and mtime, so it is rewritten only when that changes.
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

// A section not rescanned, or a reused item, can still carry a path outside the cache.
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

// `sections` must be the whole merged library, under the scan lock.
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
    return removed;
}

// Not counted towards going offline, unlike a failure to reach the server.
class HttpError extends Error {
    constructor(status, reason) {
        super(`HTTP Error ${status}: ${reason}`);
        this.status = status;
    }
}

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

let failures = 0;

// Retries a 429 (Wikipedia, Steam's store); goes offline after failures in a row
// (backend/CLAUDE.md). A body makes it a POST, which is how IGDB is asked.
async function fetch(url, timeout, {body = null, headers = {}} = {}) {
    if (failures >= OFFLINE_AFTER_FAILURES)
        throw new Error('the network is unreachable, not asking');
    for (let attempt = 0; ; attempt++) {
        const message = Soup.Message.new(body === null ? 'GET' : 'POST', url);
        if (body !== null)
            message.set_request_body_from_bytes('text/plain', new GLib.Bytes(new TextEncoder().encode(body)));
        for (const [name, value] of Object.entries(headers))
            message.request_headers.append(name, value);
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
        // Not get_status(): its enum has no 429, so reading it throws.
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

async function getJson(url, timeout = 6, request = {}) {
    return JSON.parse(decode(await fetch(url, timeout, request)));
}

function query(params) {
    return Object.entries(params)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&');
}

// An error page must not become the poster: it would be kept and drawn as nothing.
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

function blank(value) {
    return value === null || value === undefined || value === '' || (Array.isArray(value) && !value.length);
}

function fill(item, field, value) {
    if (!blank(value))
        item[field] = value;
}

function stripHtml(text) {
    return unescapeHtml((text || '').replace(/<[^>]+>/g, '')).trim() || null;
}

const LEAD_IN = /^[^.]*\bis an? (\d{4} )?[^.]*\.\s*/;
// Keeps every script and the `~n` of a repeated name, or two titles share an entry.
const UNSAFE = /[^\p{L}\p{N}_~]/gu;

// Subtitles confuse TVmaze; 'Spider-Man - Homecoming' is 'Spider-Man: Homecoming'.
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
    constructor({sources, credentials, offlineKinds}) {
        this._offlineKinds = offlineKinds;
        this.sources = {};
        for (const [kind, entries] of Object.entries(sources)) {
            this.sources[kind] = entries
                .filter(e => PROVIDERS[kind].includes(sourceId(e)))
                .map(normaliseEntry);
        }
        this._credentials = {...credentials};
        // For an empty slot 1.
        this._envCredentials = {tmdb: (GLib.getenv('LIBRARY_TMDB_KEY') ?? '').trim()};
        this._igdbTokens = new Map();
        this._warned = new Set();
        this._refused = new Set();
        this._unflushed = 0;
        ensureCacheDirs();
        this._index = this._loadIndex();
    }

    // One string per field: IGDB's client id and secret are tab-separated in one slot.
    credential(entry) {
        let raw = this._credentials[entry];
        if (!raw && entry.endsWith('@1'))
            raw = this._envCredentials[sourceId(entry)];
        const parts = (raw || '').split('\t');
        return Array.from({length: CREDENTIAL_FIELDS[sourceId(entry)] ?? 0}, (_, i) => (parts[i] ?? '').trim());
    }

    // A missing credential skips the source, so TMDB or IGDB can sit unkeyed in a list.
    _usable(entry) {
        if (!CREDENTIAL_FIELDS[sourceId(entry)])
            return true;
        if (this._refused.has(entry))
            return false;
        if (this.credential(entry).every(Boolean))
            return true;
        const name = sourceId(entry);
        if (!this._warned.has(name)) {
            this._warned.add(name);
            print(`${name}: no credential set, skipping it wherever it is listed.`);
        }
        return false;
    }

    _refuse(entry, why) {
        if (this._refused.has(entry))
            return;
        this._refused.add(entry);
        print(`${entry}: ${why}; skipping it for the rest of this scan.`);
    }

    onlineFor(kind) {
        return !this._offlineKinds.has(kind);
    }

    _loadIndex() {
        const data = readJson(METADATA_INDEX);
        if (!data || typeof data !== 'object' || Array.isArray(data))
            return Object.create(null);
        return Object.assign(Object.create(null), data);
    }

    // TV shows keep the bare id, so posters on disk keep their names.
    _paths(item) {
        const prefix = item.kind === 'tv' ? '' : `${item.kind}_`;
        const safe = `${prefix}${item.id}`.replace(UNSAFE, '');
        return [safe, join(POSTER_CACHE_DIR, `${safe}.jpg`), join(BACKDROP_CACHE_DIR, `${safe}.jpg`)];
    }

    _applyCached(item, provider, data, posterFile, backdropFile) {
        if (data === null || data === undefined)
            return false;
        if (!Object.hasOwn(data, 'year') || data.provider !== provider)
            return false;
        for (const field of CACHED_FIELDS) {
            if (data[field] !== null && data[field] !== undefined && blank(item[field]))
                item[field] = data[field];
        }
        if (!item.poster_path) {
            if (!exists(posterFile))
                return false;
            item.poster_path = posterFile;
        }
        if (exists(backdropFile))
            item.backdrop_path = backdropFile;
        item.provider = provider;
        return true;
    }

    // With no artwork, the time and the sources that answered go in, for _missed.
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

    _missed(record, sources) {
        const tried = record?.tried;
        const answered = record?.sources ?? [];
        return Boolean(tried) && now() - tried < MISS_RETRY_SECONDS &&
            sources.every(s => answered.includes(s));
    }

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

    // Sources are tried in order until one has the artwork; each fills in the facts it knows.
    async enrich(item) {
        const kind = item.kind;
        let listed = this.sources[kind] ?? [];
        // A game's source is its platform's: only Steam knows a Steam app, only IGDB a disc.
        if (kind === 'game')
            listed = listed.filter(e => sourceId(e) === (item.platform === 'steam' ? 'steam' : 'igdb'));
        if (!listed.length)
            return;
        const [key, posterFile, backdropFile] = this._paths(item);
        const record = this._index[key] ?? null;
        // Usable or not: a key blanked in the preferences keeps what it fetched.
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
        const asked = [];
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
                continue;
            answered = name;
            // eslint-disable-next-line no-await-in-loop -- whether it arrives decides the next source
            const cut = await this._download(item, typeof art === 'string' ? {poster: art} : art,
                posterFile, backdropFile);
            // A poster cut off on the way is asked for next scan, not in a week.
            if (cut)
                asked.pop();
            if (item.poster_path)
                break;
        }

        if (answered)
            item.provider = answered;
        this._save(item, answered, key, asked, record);
    }

    // True when the poster was cut off on the way rather than not an image.
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

    async _tvmaze(show) {
        const q = encodeURIComponent(cleanQuery(show.title, 'tv'));
        const results = await getJson(`https://api.tvmaze.com/search/shows?q=${q}`);
        if (!results?.length)
            return null;
        const data = results[0].show ?? {};
        // fill() never blanks what an earlier source knew.
        fill(show, 'summary', stripHtml(data.summary));
        fill(show, 'genres', data.genres);
        fill(show, 'rating', data.rating?.average);
        const premiered = (data.premiered || '').slice(0, 4);
        if (!show.year && /^[0-9]+$/.test(premiered))
            show.year = Number(premiered);
        return data.image?.original || data.image?.medium;
    }

    // `entry` names the key slot: "tmdb@1" and "tmdb@2" ask with two keys.
    async _tmdb(item, media, entry) {
        const [apiKey] = this.credential(entry);
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
            if (!results.length && year) {
                delete params.year;
                delete params.first_air_date_year;
                results = await search();
            }
        } catch (e) {
            // Still a failure, not "TMDB had nothing".
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

        let best = hits[0];
        if (year) {
            best = hits.find(h => (h.snippet ?? '').includes(String(year)) ||
                (h.title ?? '').includes(String(year))) ?? best;
        }

        const page = encodeURIComponent(best.title.replaceAll(' ', '_'));
        const summary = await getJson(`https://en.wikipedia.org/api/rest_v1/page/summary/${page}`);
        let extract = summary.extract;
        // "X is a 2017 American film." repeats the title.
        if (extract)
            extract = extract.replace(LEAD_IN, '') || extract;
        fill(film, 'summary', extract);
        const m = /\b(\d{4})\b/.exec(summary.description || '');
        if (!film.year && m)
            film.year = Number(m[1]);
        return (summary.originalimage || summary.thumbnail)?.source;
    }

    // The store's record, and the CDN's art for what the client had not cached.
    async _steam(item) {
        const appid = String(item.app_id ?? '').trim();
        if (!appid)
            return null;
        let data = null;
        try {
            const record = (await getJson(`${STEAM_STORE_API}?${query({appids: appid, l: 'english'})}`, 8))[appid];
            data = record?.success ? record.data : null;
        } catch (e) {
            print(`Steam store lookup failed for '${item.title}': ${describe(e)}`);
        }
        if (data) {
            fill(item, 'summary', stripHtml(data.short_description || data.about_the_game));
            fill(item, 'genres', (data.genres ?? []).map(g => g.description).filter(Boolean));
            const score = data.metacritic?.score;
            fill(item, 'rating', score ? Math.round(score) / 10 : null);
            const year = /\b(\d{4})\b/.exec(data.release_date?.date ?? '');
            if (!item.year && year)
                item.year = Number(year[1]);
        }
        const art = {};
        if (!item.poster_path)
            art.poster = `${STEAM_CDN}/${appid}/library_600x900.jpg`;
        if (!item.backdrop_path)
            art.backdrop = `${STEAM_CDN}/${appid}/library_hero.jpg`;
        return data || Object.keys(art).length ? art : null;
    }

    // One token per slot per run, minted once however many discs ask at once.
    _igdbToken(entry) {
        if (!this._igdbTokens.has(entry)) {
            const [id, secret] = this.credential(entry);
            const url = `${IGDB_TOKEN_URL}?${query({client_id: id, client_secret: secret, grant_type: 'client_credentials'})}`;
            this._igdbTokens.set(entry, getJson(url, 10, {body: ''}).then(answer => answer.access_token ?? null, e => {
                print(`IGDB authentication failed: ${describe(e)}`);
                return null;
            }));
        }
        return this._igdbTokens.get(entry);
    }

    // Pinned to the PS2, so a remake on another console cannot outrank the disc.
    async _igdb(item, entry) {
        const token = await this._igdbToken(entry);
        if (!token) {
            this._refuse(entry, 'IGDB gave no token for this client id and secret');
            return null;
        }
        const search = cleanQuery(item.title, 'game').replaceAll('"', '');
        const results = await getJson(`${IGDB_API}/games`, 10, {
            body: `search "${search}"; fields name,summary,storyline,first_release_date,total_rating,` +
                'genres.name,cover.image_id,artworks.image_id,screenshots.image_id; ' +
                `where platforms = (${IGDB_PS2_PLATFORM}); limit 5;`,
            headers: {
                'Client-ID': this.credential(entry)[0],
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/json',
            },
        });
        const best = results?.[0];
        if (!best)
            return null;
        fill(item, 'summary', best.summary || best.storyline);
        fill(item, 'genres', (best.genres ?? []).map(g => g.name).filter(Boolean));
        fill(item, 'rating', best.total_rating ? Math.round(best.total_rating) / 10 : null);
        if (!item.year && best.first_release_date)
            item.year = new Date(best.first_release_date * 1000).getUTCFullYear();
        const cover = best.cover?.image_id;
        const wide = [...best.artworks ?? [], ...best.screenshots ?? []].find(w => w.image_id)?.image_id;
        return {
            poster: cover ? `${IGDB_IMAGE}/t_cover_big/${cover}.jpg` : null,
            backdrop: wide ? `${IGDB_IMAGE}/t_1080p/${wide}.jpg` : null,
        };
    }
}

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
