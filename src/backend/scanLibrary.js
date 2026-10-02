// A process of its own: the folder walk is synchronous, and a scan outlives
// the preferences window that started it.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import System from 'system';

import {SECTIONS, libraryPath} from '../lib/library.js';
import {scanFilms, scanTv} from './mediaScanner.js';
import {
    CACHE_DIR, ENRICH_WORKERS, PROVIDERS, MetadataService, localiseArt,
    pathKey, pruneArt, sourceId,
} from './metadata.js';
import {join, readJson, writeJson} from './files.js';

const LIBRARY_VERSION = 2;
const DBUS_NAME_FLAG_DO_NOT_QUEUE = 4;
const DBUS_REQUEST_NAME_REPLY_PRIMARY_OWNER = 1;
const SCHEMA = 'org.gnome.shell.extensions.video-library';
// Never run from the staged lib/, so import.meta.url is where it really is.
const HERE = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const SCHEMA_DIR = join(GLib.path_get_dirname(HERE), 'schemas');
const LIBRARY_PATH = libraryPath();

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

function openSettings() {
    let source = Gio.SettingsSchemaSource.get_default();
    if (GLib.file_test(join(SCHEMA_DIR, 'gschemas.compiled'), GLib.FileTest.EXISTS))
        source = Gio.SettingsSchemaSource.new_from_directory(SCHEMA_DIR, source, false);
    const schema = source?.lookup(SCHEMA, true);
    return schema ? new Gio.Settings({settings_schema: schema}) : null;
}

function sectionFolders(settings, prefix) {
    return settings.get_strv(`${prefix}-folders`).filter(Boolean);
}

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
        // Kept out of the other's walk even when this section is not scanned.
        args.exclude[key] = folders;
        if (!only.has(key) || !settings.get_boolean(`${prefix}-enabled`))
            continue;
        // An empty list, so removing a section's last folder clears it.
        args[`${key}_path`] = folders;
        if (!folders.length)
            print(`${key}: no folder set, clearing it`);
    }

    for (const key of only) {
        const {prefix} = SECTIONS.find(s => s.key === key);
        const kind = SECTION_KINDS[key];
        if (!(kind in args.sources))
            args.sources[kind] = settings.get_strv(`${prefix}-sources`);
        if (!settings.get_boolean(`${prefix}-online`))
            args.offlineKinds.add(kind);
    }

    args.credentials = settings.get_value('credentials').deep_unpack();
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
    args.exclude = {};
    if (args.from_settings)
        applySettings(args);
    else if (args.only)
        throw new UsageError('--only is only meaningful with --from-settings');

    // null leaves a section as it is, [] clears it.
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
    // Under the lock: it reads the record index another scan may be writing.
    const meta = new MetadataService({
        online: !args.offline,
        sources: args.sources,
        credentials: args.credentials,
        offlineKinds: args.offlineKinds,
    });
    const run = {sections: loadExisting(args.out), scanned: {}, meta, exclude, force: args.force};
    for (const [key, paths] of Object.entries(requested)) {
        if (paths !== null)
            // eslint-disable-next-line no-await-in-loop -- one section at a time
            await scanSection(key, paths, run);
    }

    meta.flush();
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
    // Only for the real library: a run written elsewhere was merged onto its
    // sections, and pruning against it would delete artwork still in use.
    let dropped = 0;
    if (Gio.File.new_for_path(args.out).equal(Gio.File.new_for_path(LIBRARY_PATH)))
        dropped = pruneArt(library.sections);
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
