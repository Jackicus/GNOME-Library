// A process of its own: the folder walk is synchronous, and a scan outlives
// the preferences window that started it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SECTIONS, libraryPath} from '../lib/library.js';
import {scanFilms, scanTv} from './mediaScanner.js';
import {
    CACHE_DIR, ENRICH_WORKERS, MetadataService, localiseArt, pathKey, pruneArt,
} from './metadata.js';
import {join, readJson, writeJson} from './files.js';

const LIBRARY_VERSION = 2;
const DBUS_NAME_FLAG_DO_NOT_QUEUE = 4;
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 1;
const SCHEMA = 'org.gnome.shell.extensions.library';
// Never run from the staged lib/, so import.meta.url is where it really is.
const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const SCHEMA_DIR = join(GLib.path_get_dirname(HERE), 'schemas');
const LIBRARY_PATH = libraryPath();

const SECTION_KINDS = {tv: 'tv', films: 'film'};
const SCANNERS = {tv: scanTv, films: scanFilms};

const USAGE = `usage: gjs -m scanLibrary.js [-h] [--only SECTION] [--force]

Scan the folders the preferences list, cache their metadata and artwork, and
write library.json.

options:
  -h, --help          show this help message and exit
  --only SECTION      Scan just this section (repeatable)
  --force             Re-read every folder instead of reusing the entries of
                      unchanged ones`;

class UsageError extends Error {}

function parseArgs(argv) {
    const args = {only: null, force: false};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '-h' || arg === '--help') {
            print(USAGE);
            System.exit(0);
        } else if (arg === '--force') {
            args.force = true;
        } else if (arg === '--only' && i + 1 < argv.length) {
            const value = argv[++i];
            if (!SECTIONS.some(s => s.key === value)) {
                const choices = SECTIONS.map(s => `'${s.key}'`).join(', ');
                throw new UsageError(`argument --only: invalid choice: '${value}' (choose from ${choices})`);
            }
            (args.only ??= []).push(value);
        } else {
            throw new UsageError(`unrecognized arguments: ${argv.slice(i).join(' ')}`);
        }
    }
    return args;
}

function openSettings() {
    let source = Gio.SettingsSchemaSource.get_default();
    if (GLib.file_test(join(SCHEMA_DIR, 'gschemas.compiled'), GLib.FileTest.EXISTS))
        source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR, source, false);
    const schema = source?.lookup(SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

// A session-bus name, freed however the scan ends (backend/CLAUDE.md).
async function holdLock() {
    let bus;
    try {
        bus = Gio.DBus.session;
    } catch (e) {
        print(`No session bus (${e.message}); scanning without a lock.`);
        return;
    }
    const name = `io.github.jackicus.Library.Scan.c${pathKey(CACHE_DIR)}`;
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

function loadExisting(path) {
    const data = readJson(path);
    if (!data || typeof data !== 'object')
        return {};
    const sections = data.sections ?? {};
    return sections && typeof sections === 'object' ? sections : {};
}

async function enrichAll(meta, items) {
    const one = async item => {
        try {
            await meta.enrich(item);
        } catch (e) {
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

// Several folders can hold the same name twice.
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

function expandUser(path) {
    if (path === '~' || path.startsWith('~/'))
        return GLib.get_home_dir() + path.slice(1);
    return path;
}

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

function within(folder, root) {
    const trim = path => String(path ?? '').replace(/\/+$/, '');
    const [inner, outer] = [trim(folder), trim(root)];
    return inner === outer || inner.startsWith(`${outer}/`);
}

// A folder out of reach keeps what the last scan found in it, artwork and all.
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
            found = await SCANNERS[key](path, previous, exclude[key]);
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
    const settings = openSettings();
    if (!settings)
        throw new UsageError(`could not read the Library settings. Compile the schemas (${SCHEMA_DIR}).`);

    // null leaves a section as it is, [] clears it.
    const only = new Set(args.only ?? SECTIONS.map(s => s.key));
    const requested = {};
    const folders = {};
    const sources = {};
    const offlineKinds = new Set();
    for (const {key, prefix} of SECTIONS) {
        folders[key] = settings.get_strv(`${prefix}-folders`).filter(Boolean).map(expandUser);
        if (!only.has(key))
            continue;
        sources[SECTION_KINDS[key]] = settings.get_strv(`${prefix}-sources`);
        if (!settings.get_boolean(`${prefix}-online`))
            offlineKinds.add(SECTION_KINDS[key]);
        if (!settings.get_boolean(`${prefix}-enabled`))
            continue;
        requested[key] = folders[key];
        if (!folders[key].length)
            print(`${key}: no folder set, clearing it`);
    }
    if (!Object.keys(requested).length)
        throw new UsageError('nothing to scan: no section is switched on. Set one in the preferences.');
    // Each section's folders are kept out of the others' walks, scanned this run or not.
    const exclude = Object.fromEntries(SECTIONS.map(({key}) => [key,
        SECTIONS.filter(other => other.key !== key).flatMap(other => folders[other.key])]));

    GLib.mkdir_with_parents(GLib.path_get_dirname(LIBRARY_PATH), 0o755);
    await holdLock();
    // Under the lock: it reads the record index another scan may be writing.
    const meta = new MetadataService({
        sources,
        credentials: settings.get_value('credentials').deep_unpack(),
        offlineKinds,
    });
    const run = {sections: loadExisting(LIBRARY_PATH), scanned: {}, meta, exclude, force: args.force};
    for (const [key, paths] of Object.entries(requested))
        // eslint-disable-next-line no-await-in-loop -- one section at a time
        await scanSection(key, paths, run);

    meta.flush();
    const written = Object.fromEntries(SECTIONS.map(({key}) => [key, run.sections[key] ?? []]));
    const moved = await localiseArt(written);
    const library = {
        version: LIBRARY_VERSION,
        generated: GLib.get_real_time() / 1e6,
        sections: written,
        scanned: run.scanned,
    };
    writeJson(LIBRARY_PATH, library, 1);
    print(`Wrote ${LIBRARY_PATH}`);
    const dropped = pruneArt(library.sections);
    if (moved || dropped)
        print(`Artwork cache: ${moved} copied in, ${dropped} removed`);
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
