// An item whose folder still carries last scan's signature reuses its file
// list: stat'ing every file is the bulk of a rescan (backend/CLAUDE.md).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {extension, join, modified, stem} from './files.js';
import {cacheLocalArt} from './metadata.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.m4v', '.mov', '.wmv']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.avif', '.tiff', '.bmp']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);
const COVER_NAMES = ['cover', 'folder', 'front', 'poster', 'artwork'];

const YEAR = /\s*[([](\p{Nd}{4})[)\]]\s*$/u;
const NOT_WORD = /[^\p{L}\p{N}_]/gu;
const DIGIT_RUNS = /(\p{Nd}+)/u;

// Letters of every script stay: folded to ASCII, two non-Latin titles would
// share an id and swap posters.
function slug(name) {
    return name.toLowerCase().replace(NOT_WORD, '_');
}

function digitsValue(digits) {
    return [...digits].reduce((n, digit) => n * 10 + GLib.unichar_digit_value(digit), 0);
}

function splitYear(name) {
    const m = YEAR.exec(name);
    if (!m)
        return [name.trim(), null];
    return [name.slice(0, m.index).trim(), digitsValue(m[1])];
}

// "Episode 2" before "Episode 10".
function naturalKey(text) {
    return text.split(DIGIT_RUNS).map((part, i) => i % 2
        ? [...part].map(d => GLib.unichar_digit_value(d)).join('').replace(/^0+(?=\d)/, '')
        : part.toLowerCase());
}

function compareKeys(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        // Odd parts are numbers without leading zeros: the longer is larger.
        const x = a[i];
        const y = b[i];
        const order = i % 2 && x.length !== y.length ? x.length - y.length : (x > y) - (x < y);
        if (order)
            return order;
    }
    return a.length - b.length;
}

function sortNatural(items, keys) {
    return items
        .map(item => ({item, key: [keys(item)].flat().map(naturalKey)}))
        .sort((a, b) => {
            for (let i = 0; i < a.key.length; i++) {
                const order = compareKeys(a.key[i], b.key[i]);
                if (order)
                    return order;
            }
            return 0;
        })
        .map(({item}) => item);
}

// A refused stat returns an info without the attribute, not an error.
function sizeMb(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::size', Gio.FileQueryInfoFlags.NONE, null);
        return info.has_attribute('standard::size')
            ? Number((info.get_size() / (1024 * 1024)).toFixed(1))
            : 0;
    } catch {
        return 0;
    }
}

function followedType(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('standard::type', Gio.FileQueryInfoFlags.NONE, null);
        return info.has_attribute('standard::type') ? info.get_file_type() : Gio.FileType.UNKNOWN;
    } catch {
        return Gio.FileType.UNKNOWN;
    }
}

// Name and type only, so the type comes from readdir with no stat per name.
// A name that is not UTF-8 is skipped rather than losing the folder.
function list(path, quiet = false) {
    let entries = null;
    let unreadable = 0;
    try {
        const enumerator = Gio.File.new_for_path(path).enumerate_children(
            'standard::name,standard::type', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        try {
            entries = [];
            for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null)) {
                let name;
                try {
                    name = info.get_name();
                } catch {
                    unreadable++;
                    continue;
                }
                let type = info.get_file_type();
                const link = type === Gio.FileType.SYMBOLIC_LINK;
                if (link)
                    type = followedType(join(path, name));
                entries.push({
                    name, link,
                    dir: type === Gio.FileType.DIRECTORY,
                    file: type === Gio.FileType.REGULAR,
                });
            }
        } finally {
            enumerator.close(null);
        }
    } catch (e) {
        if (!quiet)
            print(`Cannot read ${path}: ${e.message}`);
        return null;
    }
    if (unreadable)
        print(`${path}: skipping ${unreadable} name(s) that are not UTF-8`);
    return entries;
}

// A share written from a Mac has a ._Episode.mkv beside every Episode.mkv.
function visible(entries) {
    return entries.filter(e => !e.name.startsWith('.'));
}

function subdirs(entries) {
    return sortNatural(visible(entries).filter(e => e.dir), e => e.name);
}

function filesWithExt(entries, extensions) {
    return sortNatural(
        visible(entries).filter(e => e.file && extensions.has(extension(e.name).toLowerCase())),
        e => e.name).map(e => e.name);
}

function realpath(path) {
    const rest = (path.startsWith('/') ? path : join(GLib.get_current_dir(), path)).split('/').reverse();
    let resolved = '';
    let hops = 0;
    while (rest.length) {
        const part = rest.pop();
        if (part === '' || part === '.')
            continue;
        if (part === '..') {
            resolved = resolved.slice(0, resolved.lastIndexOf('/'));
            continue;
        }
        const next = `${resolved}/${part}`;
        let target = null;
        if (hops < 40 && GLib.file_test(next, GLib.FileTest.IS_SYMLINK)) {
            try {
                target = GLib.file_read_link(next);
            } catch {
                // gone since it was tested
            }
        }
        if (target === null) {
            resolved = next;
            continue;
        }
        hops++;
        if (target.startsWith('/'))
            resolved = '';
        rest.push(...target.split('/').reverse());
    }
    return resolved || '/';
}

// Keeps the other section's folders (films inside the TV folder) out of the walk.
function exclusions(root, exclude) {
    const skip = new Set(exclude.filter(Boolean).map(realpath));
    if (!skip.size)
        return () => false;
    const resolvedRoot = realpath(root);
    return entry => skip.has(entry.link ? realpath(join(root, entry.name)) : join(resolvedRoot, entry.name));
}

// One walk gives the signature, the file list and the cover.
function walk(folder) {
    const tree = {seen: 0, newest: 0, top: null, dirs: []};
    const visit = (root, rel) => {
        const entries = list(root, true);
        if (!entries)
            return;
        if (!rel)
            tree.top = entries;
        tree.seen++;
        const time = modified(root);
        if (time !== null)
            tree.newest = Math.max(tree.newest, time);
        const shown = visible(entries);
        tree.dirs.push({root, rel, names: shown.filter(e => !e.dir).map(e => e.name)});
        for (const entry of shown) {
            if (entry.dir && !entry.link)
                visit(join(root, entry.name), rel ? `${rel}/${entry.name}` : entry.name);
        }
    };
    visit(folder, '');
    return tree;
}

// A file rewritten in place under the same name goes unseen until --force.
// The path is in it because the reused file list holds absolute paths.
function signature(folder, tree) {
    return `${tree.seen}:${tree.newest.toFixed(3)}:${folder}`;
}

// A folder unreadable this time keeps what the last scan found.
function unread(previous, id, folder) {
    const entry = previous?.get(id);
    return entry?.folder_path === folder ? entry : null;
}

function reusable(previous, id, sig, field) {
    if (!previous?.size || !sig)
        return null;
    const entry = previous.get(id);
    if (!entry || entry.scan_sig !== sig)
        return null;
    return entry[field] ?? null;
}

// Copied into the cache: the shell must never read from a media folder.
async function findLocalCover(folder, entries) {
    for (const name of filesWithExt(entries ?? [], IMAGE_EXTENSIONS)) {
        const lower = stem(name).toLowerCase();
        if (COVER_NAMES.some(cover => lower.startsWith(cover)))
            return cacheLocalArt(join(folder, name));
    }
    return null;
}

function videoEntries(tree) {
    const entries = [];
    for (const {root, rel, names} of tree.dirs) {
        const subStems = new Set(names
            .filter(name => SUBTITLE_EXTENSIONS.has(extension(name).toLowerCase()))
            .map(name => stem(name).toLowerCase()));
        for (const filename of names) {
            if (!VIDEO_EXTENSIONS.has(extension(filename).toLowerCase()))
                continue;
            const path = join(root, filename);
            const title = stem(filename);
            const lower = title.toLowerCase();
            // "Episode.srt" or "Episode.en.srt".
            const hasSub = subStems.has(lower) || [...subStems].some(s => s.startsWith(`${lower}.`));
            entries.push({
                filename,
                path,
                title,
                group: rel || null,
                has_subtitles: hasSub,
                size_mb: sizeMb(path),
            });
        }
    }
    return sortNatural(entries, e => [e.group ?? '', e.filename]);
}

// <root>/<Show>/[Season N/]<episode>.mkv; null when root is out of reach.
export async function scanTv(root, previous = null, exclude = []) {
    const entries = list(root);
    if (!entries)
        return null;
    const skipped = exclusions(root, exclude);
    const shows = [];
    for (const entry of subdirs(entries)) {
        if (skipped(entry))
            continue;
        const folder = join(root, entry.name);
        const id = slug(entry.name);
        const tree = walk(folder);
        if (!tree.seen) {
            const kept = unread(previous, id, folder);
            if (kept)
                shows.push(kept);
            continue;
        }
        const sig = signature(folder, tree);
        let episodes = reusable(previous, id, sig, 'episodes');
        if (episodes === null) {
            episodes = videoEntries(tree);
            for (const ep of episodes) {
                // A reused list carries its prefix already.
                const group = ep.group;
                const prefix = group && !group.toLowerCase().startsWith('season') ? `[${group}] ` : '';
                ep.title = `${prefix}${ep.title}`;
            }
        }
        if (!episodes.length)
            continue;
        const [title, year] = splitYear(entry.name);
        shows.push({
            id,
            kind: 'tv',
            title,
            year,
            folder_path: folder,
            scan_sig: sig,
            episodes,
            episode_count: episodes.length,
            // eslint-disable-next-line no-await-in-loop -- a folder at a time, as it is walked
            poster_path: await findLocalCover(folder, tree.top),
            summary: null,
            genres: [],
            rating: null,
        });
    }
    return shows;
}

// <root>/<Film (Year)>/<file>.mkv or <root>/<Film (Year)>.mkv
export async function scanFilms(root, exclude = [], previous = null) {
    const entries = list(root);
    if (!entries)
        return null;
    const skipped = exclusions(root, exclude);
    const films = [];
    for (const entry of subdirs(entries)) {
        if (skipped(entry))
            continue;
        const folder = join(root, entry.name);
        const tree = walk(folder);
        if (!tree.seen) {
            const kept = unread(previous, slug(entry.name), folder);
            if (kept)
                films.push(kept);
            continue;
        }
        const sig = signature(folder, tree);
        const files = reusable(previous, slug(entry.name), sig, 'files') ?? videoEntries(tree);
        if (!files.length)
            continue;
        const [title, year] = splitYear(entry.name);
        // eslint-disable-next-line no-await-in-loop -- a folder at a time, as it is walked
        const cover = await findLocalCover(folder, tree.top);
        films.push(filmEntry(entry.name, title, year, folder, files, sig, cover));
    }

    // A loose file has no signature and no cover: one in root would be every film's.
    for (const filename of filesWithExt(entries, VIDEO_EXTENSIONS)) {
        const name = stem(filename);
        const [title, year] = splitYear(name);
        const path = join(root, filename);
        const files = [{
            filename, path, title: name, group: null,
            has_subtitles: false, size_mb: sizeMb(path),
        }];
        films.push(filmEntry(name, title, year, root, files, null, null));
    }

    return sortNatural(films, f => f.title);
}

function filmEntry(name, title, year, folder, files, sig, cover) {
    // The main feature is the largest file; extras and samples are smaller.
    let main = files[0];
    for (const file of files) {
        if (file.size_mb > main.size_mb)
            main = file;
    }
    return {
        id: slug(name),
        kind: 'film',
        title,
        year,
        folder_path: folder,
        scan_sig: sig,
        files,
        main_path: main.path,
        poster_path: cover,
        summary: null,
        genres: [],
        rating: null,
        runtime: null,
    };
}
