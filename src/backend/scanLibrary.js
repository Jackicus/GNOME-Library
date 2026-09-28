// Index the media library and write the library.json Video Library reads.
//
// Each section is scanned only when a folder is given for it, and the result
// is merged into the existing library.json so a rescan of one section keeps
// the other. A section can have several folders — repeat its flag — and they
// are walked in order into one list.
//
//     gjs -m scanLibrary.js --tv-path "$HOME/Videos/TV Shows" --films-path ~/Videos/Films
//     gjs -m scanLibrary.js --films-path ~/Videos/Films --offline
//     gjs -m scanLibrary.js --films-path ~/Videos/Films --source film=tmdb,wikipedia
//     gjs -m scanLibrary.js --from-settings
//     gjs -m scanLibrary.js --from-settings --only films
//
// `--from-settings` fills all of that in from GSettings instead, optionally
// narrowed with `--only`, so the Rescan buttons in the preferences and
// ./scripts/dev.sh both just run this rather than each rebuilding the same
// command line.
//
// It runs in a process of its own rather than inside the preferences: the
// folder walk — synchronous, and seconds long on a share that has to be woken
// first — never holds up the preferences window, and a scan finishes even
// when that window is closed halfway through. It needs nothing but GJS and
// the libraries GNOME Shell itself runs on — GLib, Gio, Soup and GdkPixbuf —
// and imports nothing from the shell.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SECTIONS, libraryPath} from '../lib/library.js';
import {scanFilms, scanTv} from './mediaScanner.js';
import {
    CACHE_DIR, ENRICH_WORKERS, PROVIDERS, MetadataService, fitCachedArt, localiseArt,
    pathKey, pruneArt, sourceId,
} from './metadata.js';
import {join, readJson, writeJson} from './files.js';

const LIBRARY_VERSION = 2;
const DBUS_NAME_FLAG_DO_NOT_QUEUE = 4;
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 1;
const SCHEMA = 'org.gnome.shell.extensions.video-library';
// This file's own folder. It is never run from the staged copy of lib/ the
// dev entry point makes, so import.meta.url is where it really is.
const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
// The schemas ship one folder up, so they are found from the installed
// copy as readily as from the repo.
const SCHEMA_DIR = join(GLib.path_get_dirname(HERE), 'schemas');
// The library the extension reads. A run with --out somewhere else writes a
// library of its own, but shares this machine's one artwork cache.
const LIBRARY_PATH = libraryPath();

// A section is a page in the preferences; a kind is what metadata.js calls the
// items on it. They differ for films.
const SECTION_KINDS = {tv: 'tv', films: 'film'};
const SCANNERS = {
    tv: (path, previous, exclude) => scanTv(path, previous, exclude.films ?? []),
    films: (path, previous, exclude) => scanFilms(path, exclude.tv ?? [], previous),
};

const USAGE = `usage: gjs -m scanLibrary.js [-h] [--tv-path FOLDER] [--films-path FOLDER]
                        [--source KIND=A,B] [--offline] [--from-settings]
                        [--only SECTION] [--force] [--out OUT]

Scan media folders and cache metadata.

options:
  -h, --help          show this help message and exit
  --tv-path FOLDER    A TV shows folder (repeatable)
  --films-path FOLDER A films folder (repeatable)
  --source KIND=A,B   Sources for one kind, in the order they are tried (tv,
                      film). Repeatable. Keys come from the preferences or the
                      environment, never from here.
  --offline           Skip online metadata and artwork
  --from-settings     Take the folders, sources, keys and online switches from
                      the preferences
  --only SECTION      With --from-settings, scan just this section (repeatable)
  --force             Re-read every folder instead of reusing the entries of
                      unchanged ones
  --out OUT`;

// A mistake on the command line, which ends the run with the usage and the
// complaint on stderr, and status 2.
class UsageError extends Error {}

function parseArgs(argv) {
    const args = {
        tv_path: null, films_path: null, source: [], offline: false,
        from_settings: false, only: null, force: false, out: LIBRARY_PATH,
    };
    const valued = {
        '--tv-path': value => (args.tv_path ??= []).push(value),
        '--films-path': value => (args.films_path ??= []).push(value),
        '--source': value => args.source.push(value),
        '--only': value => {
            if (!SECTIONS.some(s => s.key === value)) {
                const choices = SECTIONS.map(s => `'${s.key}'`).join(', ');
                throw new UsageError(`argument --only: invalid choice: '${value}' (choose from ${choices})`);
            }
            (args.only ??= []).push(value);
        },
        '--out': value => {
            args.out = value;
        },
    };
    const flags = {'--offline': 'offline', '--from-settings': 'from_settings', '--force': 'force'};
    for (let i = 0; i < argv.length; i++) {
        const [name, inline] = argv[i].startsWith('--') && argv[i].includes('=')
            ? [argv[i].slice(0, argv[i].indexOf('=')), argv[i].slice(argv[i].indexOf('=') + 1)]
            : [argv[i], null];
        if (name === '-h' || name === '--help') {
            print(USAGE);
            System.exit(0);
        } else if (name in flags && inline === null) {
            args[flags[name]] = true;
        } else if (name in valued) {
            const value = inline ?? argv[++i];
            if (value === undefined)
                throw new UsageError(`argument ${name}: expected one argument`);
            valued[name](value);
        } else {
            throw new UsageError(`unrecognized arguments: ${argv.slice(i).join(' ')}`);
        }
    }
    return args;
}

// --------------------------------------------------------------------------
// Reading the preferences
// --------------------------------------------------------------------------
// The extension's settings, from the schemas beside it when they have been
// compiled there and the system's otherwise; null if they cannot be found.
function openSettings() {
    let source = Gio.SettingsSchemaSource.get_default();
    if (GLib.file_test(join(SCHEMA_DIR, 'gschemas.compiled'), GLib.FileTest.EXISTS))
        source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR, source, false);
    const schema = source?.lookup(SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

// The folders a section is pointed at, in order, as the preferences see them:
// <prefix>-folders, or while that is empty the single <prefix>-path earlier
// releases kept.
function sectionFolders(settings, prefix) {
    const folders = settings.get_strv(`${prefix}-folders`).filter(Boolean);
    if (!folders.length) {
        const legacy = settings.get_string(`${prefix}-path`);
        if (legacy)
            folders.push(legacy);
    }
    return folders;
}

// Fill the command line in from the preferences. This is the only place that
// knows how a setting becomes a scanner flag, so the preferences and dev.sh
// cannot drift from it or from each other.
function applySettings(args) {
    const settings = openSettings();
    if (!settings) {
        throw new UsageError(
            '--from-settings could not read the Video Library settings. Compile the ' +
            `schemas (${SCHEMA_DIR}) or pass the folders explicitly.`);
    }

    const only = new Set(args.only ?? SECTIONS.map(s => s.key));
    for (const {key, prefix} of SECTIONS) {
        const folders = sectionFolders(settings, prefix);
        // Every section's folders are kept out of the other's walk whether
        // or not it is being scanned now, so a TV folder inside the films
        // folder is not read as one film when films are scanned alone.
        args.exclude[key] = folders;
        if (!only.has(key) || !settings.get_boolean(`${prefix}-enabled`))
            continue;
        // An empty list, not nothing: a section switched on and pointed at no
        // folder is written out empty, so removing a section's last folder
        // takes its items off the desktop at the next scan.
        args[`${key}_path`] = folders;
        if (!folders.length)
            print(`${key}: no folder set, clearing it`);
    }

    // A section left out of --only keeps whatever its items already had.
    for (const key of only) {
        const {prefix} = SECTIONS.find(s => s.key === key);
        const kind = SECTION_KINDS[key];
        if (!(kind in args.sources))
            args.sources[kind] = settings.get_strv(`${prefix}-sources`);
        if (!settings.get_boolean(`${prefix}-online`))
            args.offlineKinds.add(kind);
    }

    // Read here rather than taken from the environment, so neither the
    // preferences nor dev.sh has to hand the scanner a key.
    args.credentials = settings.get_value('credentials').deep_unpack();
}

// --------------------------------------------------------------------------
// The lock
// --------------------------------------------------------------------------
// Every scan reads the whole library.json, replaces the sections it was asked
// for and writes all of them back, so two at once would each write the
// other's sections back as they were — easily done, since the preferences
// offer a Rescan button per section and one for the lot — and both share the
// record index and the artwork cache besides.
//
// The lock is a name on the session bus, one per cache: asking for it is
// refused while another scan holds it, and the bus lets it go the moment that
// scan's process ends, however it ends, so nothing is left behind to go
// stale. The bus is the user's own, and a sandboxed app cannot take a name
// outside its own, so nothing else can hold it. Without a session bus at all
// — a scan run over ssh — the scan goes ahead unlocked.
async function holdLock() {
    let bus;
    try {
        bus = Gio.DBus.session;
    } catch (e) {
        print(`No session bus (${e.message}); scanning without a lock.`);
        return;
    }
    const name = `org.gnome.shell.extensions.VideoLibrary.Scan.c${pathKey(CACHE_DIR)}`;
    for (let waiting = false; ; waiting = true) {
        const [reply] = bus.call_sync(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'RequestName',
            new GLib.Variant('(su)', [name, DBUS_NAME_FLAG_DO_NOT_QUEUE]), new GLib.VariantType('(u)'),
            Gio.DBusCallFlags.NONE, -1, null).deep_unpack();
        if (reply === DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER)
            return;
        if (!waiting)
            print('Another scan is already running; waiting for it to finish...');
        // eslint-disable-next-line no-await-in-loop -- polling is the waiting
        await new Promise(resolve => {
            GLib.timeout_add(GLib.PRIORITY_DEFAULT, 500, () => {
                resolve();
                return GLib.SOURCE_REMOVE;
            });
        });
    }
}

// --------------------------------------------------------------------------
// Scanning
// --------------------------------------------------------------------------
// version 1 was a bare list of TV shows.
function loadExisting(path) {
    const data = readJson(path);
    if (Array.isArray(data))
        return {tv: data};
    if (!data || typeof data !== 'object')
        return {};
    const sections = data.sections ?? {};
    return sections && typeof sections === 'object' ? sections : {};
}

// Fill in metadata and artwork for `items`, several at a time. A section
// that is not going online has nothing to wait for, so it is done in turn.
async function enrichAll(meta, items) {
    const one = async item => {
        try {
            await meta.enrich(item);
        } catch (e) { // one bad item must never abort the scan
            print(`Metadata failed for '${item.title}': ${e.message}`);
        }
    };
    let next = 0;
    const worker = async () => {
        while (next < items.length)
            // eslint-disable-next-line no-await-in-loop -- a worker takes one item at a time
            await one(items[next++]);
    };
    const workers = items.length < 2 || !meta.onlineFor(items[0].kind) ? 1 : ENRICH_WORKERS;
    await Promise.all(Array.from({length: workers}, worker));
}

// Make every id distinct, in place: a section walked from several folders can
// hold the same name twice, and the second gets a numbered suffix.
function uniqueIds(items) {
    const seen = new Set();
    for (const item of items) {
        let candidate = item.id;
        for (let n = 2; seen.has(candidate); n++)
            candidate = `${item.id}~${n}`;
        item.id = candidate;
        seen.add(candidate);
    }
}

function unchanged(items, previous) {
    return items.filter(item => item.scan_sig && previous.get(item.id)?.scan_sig === item.scan_sig).length;
}

// The home folder for ~ and ~/... (not ~user).
function expandUser(path) {
    if (path === '~' || path.startsWith('~/'))
        return GLib.get_home_dir() + path.slice(1);
    return path;
}

// --source KIND=A,B: the sources for one kind, in the order they are tried.
function parseSources(specs) {
    const sources = {};
    for (const spec of specs) {
        const at = spec.indexOf('=');
        const kind = (at < 0 ? spec : spec.slice(0, at)).trim();
        const listed = at < 0 ? '' : spec.slice(at + 1);
        if (!(kind in PROVIDERS)) {
            throw new UsageError(
                `--source: unknown kind '${kind}'; expected one of ${Object.keys(PROVIDERS).join(', ')}`);
        }
        const entries = listed.split(',').map(e => e.trim()).filter(Boolean);
        const unknown = entries.filter(e => !PROVIDERS[kind].includes(sourceId(e)));
        if (unknown.length)
            throw new UsageError(`--source ${kind}: ${unknown.join(', ')} cannot answer for ${kind}`);
        sources[kind] = entries;
    }
    return sources;
}

// A section's items as they were, by id, for a rescan to reuse; none under
// --force, which re-reads every folder.
function previousItems(items, force) {
    const previous = new Map();
    if (force || !Array.isArray(items))
        return previous;
    for (const item of items) {
        if (item && typeof item === 'object' && item.id)
            previous.set(item.id, item);
    }
    return previous;
}

// Whether `folder` is `root` or somewhere under it.
function within(folder, root) {
    const trim = path => String(path ?? '').replace(/\/+$/, '');
    const [inner, outer] = [trim(folder), trim(root)];
    return inner === outer || inner.startsWith(`${outer}/`);
}

// Scan one section's folders into `sections[key]` and say what was found in
// `scanned[key]`.
//
// A folder out of reach — a share that is offline, a drive not plugged in, a
// mount that fails — is not an empty one: what the last scan found in it is
// kept, artwork and all, rather than dropped and pruned, to be fetched all
// over again when it comes back. Only a folder that is reached and found
// empty, or taken out of the list, loses what it had.
async function scanSection(key, paths, {sections, scanned, meta, exclude, force}) {
    const t0 = GLib.get_monotonic_time();
    const last = Array.isArray(sections[key]) ? sections[key] : [];
    const previous = previousItems(last, force);
    const items = [];
    const missing = [];
    for (const path of paths) {
        let found = null;
        if (GLib.file_test(path, GLib.FileTest.IS_DIR))
            // eslint-disable-next-line no-await-in-loop -- a folder at a time, in the order they are listed
            found = await SCANNERS[key](path, previous, exclude);
        else
            print(`${key}: ${path} is not a folder, skipping it`);
        if (found) {
            items.push(...found);
            continue;
        }
        missing.push(path);
        const kept = last.filter(item => within(item?.folder_path, path));
        if (kept.length)
            print(`${key}: keeping what the last scan found in ${path} (${kept.length})`);
        items.push(...kept);
    }
    uniqueIds(items);
    await enrichAll(meta, items);

    sections[key] = items;
    scanned[key] = {paths, count: items.length};
    if (missing.length)
        scanned[key].missing = missing;
    const reused = unchanged(items, previous);
    const note = reused ? `, ${reused} unchanged` : '';
    const where = paths.join(', ') || 'no folder';
    const took = ((GLib.get_monotonic_time() - t0) / 1e6).toFixed(1);
    print(`${key}: ${items.length} items from ${where} (${took}s${note})`);
}

async function main(argv) {
    const args = parseArgs(argv);
    args.sources = parseSources(args.source);
    args.offlineKinds = new Set();
    args.credentials = {};
    // section -> its folders, kept out of the other section's walk.
    args.exclude = {};
    if (args.from_settings)
        applySettings(args);
    else if (args.only)
        throw new UsageError('--only is only meaningful with --from-settings');

    // A section's folders, expanded once; null for a section this run leaves
    // as it is, [] for one it clears.
    const expand = folders => folders ? folders.map(expandUser) : null;
    const requested = Object.fromEntries(SECTIONS.map(({key}) => [key, expand(args[`${key}_path`])]));
    if (Object.values(requested).every(v => v === null)) {
        if (args.from_settings)
            throw new UsageError('nothing to scan: no section is switched on. Set one in the preferences.');
        throw new UsageError('give at least one of --tv-path, --films-path, --from-settings');
    }
    const exclude = {};
    for (const [key, folders] of Object.entries(args.exclude))
        exclude[key] = expand(folders) ?? [];
    for (const [key, folders] of Object.entries(requested)) {
        if (folders?.length)
            exclude[key] = [...new Set([...(exclude[key] ?? []), ...folders])];
    }

    GLib.mkdir_with_parents(GLib.path_get_dirname(args.out), 0o755);
    await holdLock();
    // Under the lock, since it reads the record index another scan may be
    // writing. Keys come from the preferences, or from the environment
    // (VIDEO_LIBRARY_TMDB_KEY) for a standalone run. Never argv.
    const meta = new MetadataService({
        online: !args.offline,
        sources: args.sources,
        credentials: args.credentials,
        offlineKinds: args.offlineKinds,
    });
    // Every artwork path the shell is given has to be a file in the cache,
    // no larger than the desktop draws it.
    const fitted = await fitCachedArt();
    const run = {sections: loadExisting(args.out), scanned: {}, meta, exclude, force: args.force};
    for (const [key, paths] of Object.entries(requested)) {
        if (paths !== null)
            // eslint-disable-next-line no-await-in-loop -- one section at a time
            await scanSection(key, paths, run);
    }

    meta.flush();
    // Only what this run knows about: a section an older library.json
    // still has is dropped rather than carried forward.
    const written = Object.fromEntries(SECTIONS.map(({key}) => [key, run.sections[key] ?? []]));
    const moved = await localiseArt(written);
    const library = {
        version: LIBRARY_VERSION,
        generated: GLib.get_real_time() / 1e6,
        sections: written,
        scanned: run.scanned,
    };
    writeJson(args.out, library, 1);
    print(`Wrote ${args.out}`);
    // Pruned after the write and against every section at once, and only
    // for the real library: a run written elsewhere was merged onto that
    // file's sections, and pruning against it would delete the artwork
    // the extension is still pointing at.
    let dropped = 0;
    if (Gio.File.new_for_path(args.out).equal(Gio.File.new_for_path(LIBRARY_PATH)))
        dropped = pruneArt(library.sections);
    if (fitted || moved || dropped)
        print(`Artwork cache: ${fitted} scaled down, ${moved} copied in, ${dropped} removed`);
    return 0;
}

let status = 1;
const loop = new GLib.MainLoop(null, false);
main(System.programArgs).then(code => {
    status = code;
}, e => {
    if (e instanceof UsageError) {
        printerr(USAGE.split('\n\n')[0]);
        printerr(`scanLibrary.js: error: ${e.message}`);
        status = 2;
    } else {
        printerr(e.stack ? `${e}\n${e.stack}` : `${e}`);
    }
}).finally(() => loop.quit());
loop.run();
System.exit(status);
