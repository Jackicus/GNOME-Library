// Walks media folders and turns them into plain objects for library.json. One
// scanner per section; they know nothing about the network, and metadata.js
// enriches what they return.
//
// Every scanner takes the section's previous items keyed by id. Walking a
// folder and stat'ing each file in it is the bulk of a rescan, and almost
// nothing has changed between one scan and the next, so an item whose folder
// still carries the signature recorded last time reuses the file list it
// already had. The metadata fields are never carried over from the last
// scan, so a change of sources takes effect at the next one.
//
// Each item's folder is walked once: the signature, the file list and the
// cover all come out of the same walk.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {extension, join, modified, stem} from './files.js';
import {cacheLocalArt} from './metadata.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mkv', '.avi', '.webm', '.m4v', '.mov', '.wmv']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.avif', '.tiff', '.bmp']);
const SUBTITLE_EXTENSIONS = new Set(['.srt', '.vtt', '.ass', '.ssa', '.sub']);
const COVER_NAMES = ['cover', 'folder', 'front', 'album', 'poster', 'artwork'];

// "Title (2016)" or "Title [2016]", the year in the digits of any script.
const YEAR = /\s*[([](\p{Nd}{4})[)\]]\s*$/u;
const NOT_WORD = /[^\p{L}\p{N}_]/gu;
const DIGIT_RUNS = /(\p{Nd}+)/u;

// A folder name as an id. Letters and digits of any script stay: folding them
// all down to ASCII would turn two titles in, say, Japanese and Cyrillic into
// the same run of underscores, told apart only by their place in the list, so
// the cached record and poster of one would skid onto the other's title as
// the list changes. Punctuation and spaces go.
function slug(name) {
    return name.toLowerCase().replace(NOT_WORD, '_');
}

// A run of digits as the number it spells, in whichever script it is written.
function digitsValue(digits) {
    return [...digits].reduce((n, digit) => n * 10 + GLib.unichar_digit_value(digit), 0);
}

// 'Doctor Strange (2016)' -> ['Doctor Strange', 2016].
function splitYear(name) {
    const m = YEAR.exec(name);
    if (!m)
        return [name.trim(), null];
    return [name.slice(0, m.index).trim(), digitsValue(m[1])];
}

// --------------------------------------------------------------------------
// Natural order: case aside, and each run of digits compared as the number it
// is, so "Episode 2" comes before "Episode 10".
// --------------------------------------------------------------------------
function naturalKey(text) {
    return text.split(DIGIT_RUNS).map((part, i) => i % 2
        ? [...part].map(d => GLib.unichar_digit_value(d)).join('').replace(/^0+(?=\d)/, '')
        : part.toLowerCase());
}

function compareKeys(a, b) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
        // Text and numbers alternate; a number without its leading zeros
        // compares by length first.
        const x = a[i];
        const y = b[i];
        const order = i % 2 && x.length !== y.length ? x.length - y.length : (x > y) - (x < y);
        if (order)
            return order;
    }
    return a.length - b.length;
}

// `items` in natural order of what `keys` gives each: one string, or several
// compared in turn. Equal ones keep the order they came in.
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

// --------------------------------------------------------------------------
// The filesystem
// --------------------------------------------------------------------------
// A stat that is refused comes back as an info without the attribute rather
// than as an error, hence the has_attribute before each read.
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

// A folder's entries: each name, whether it is a link, and whether it is a
// folder or a file once a link is followed. Asking for the name and type
// alone is what lets Gio take the type from the listing itself rather than
// stat every name — on a share, a round trip each — so only a link, or a
// filesystem that does not say, costs a stat. Null when the folder cannot be
// read, whole.
//
// A name that is not UTF-8 — a share written from an old system in Latin-1 —
// cannot be held in a JavaScript string, and so cannot be opened from here
// either. It is skipped, and said so, rather than taking its folder with it.
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

// Dot-files are nobody's media: a share written to from a Mac carries a
// ._Episode.mkv beside every Episode.mkv.
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

// A path with every link on the way resolved, and whatever does not exist
// kept as written.
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
                // gone since it was tested: kept as written
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

// The other section's folders, resolved, and a test of whether one of
// `root`'s entries is one of them — the films folder inside the TV folder, or
// the other way about, which would otherwise be read as a show or a film. An
// entry that is not a link resolves to the resolved root plus its name, so
// only a link costs a lookup of its own.
function exclusions(root, exclude) {
    const skip = new Set(exclude.filter(Boolean).map(realpath));
    if (!skip.size)
        return () => false;
    const resolvedRoot = realpath(root);
    return entry => skip.has(entry.link ? realpath(join(root, entry.name)) : join(resolvedRoot, entry.name));
}

// Everything the scan wants of an item's folder, in one walk: how many
// folders there are and the newest of their mtimes (the signature), each
// folder's files (the file list) and the top folder's own listing (the
// cover). Hidden folders are left out, and a link to a folder is listed but
// not followed; a folder that cannot be read is not counted.
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

// A string that changes when what is in the folder changes. A directory's
// mtime moves whenever a name is added, removed or renamed inside it, so the
// newest mtime across the folder and its subfolders stands in for "something
// appeared or went away in here". The one edit it cannot see is a file
// rewritten in place under the same name, which leaves a stale size behind
// until --force re-reads everything.
//
// The folder's own path is part of it. What is reused on a match is the file
// list, and every entry in it is an absolute path — so a tree that moved
// unchanged (a drive renamed, a share remounted somewhere else) has to read as
// changed, or every file in it is looked for where it used to be.
function signature(folder, tree) {
    return `${tree.seen}:${tree.newest.toFixed(3)}:${folder}`;
}

// The previous item from `folder`, kept as it was when the folder cannot be
// read this time — a share dropping out mid-scan — rather than letting it,
// and its artwork, go until the next scan finds it again.
function unread(previous, id, folder) {
    const entry = previous?.get(id);
    return entry?.folder_path === folder ? entry : null;
}

// The cached `field` of a previous item whose folder has not changed.
function reusable(previous, id, sig, field) {
    if (!previous?.size || !sig)
        return null;
    const entry = previous.get(id);
    if (!entry || entry.scan_sig !== sig)
        return null;
    return entry[field] ?? null;
}

// A cover image kept beside the media (cover.jpg, folder.png, ...), as the
// scaled copy of it in the artwork cache: the shell reads artwork on the
// compositor thread and must never be sent into a media folder to do it.
async function findLocalCover(folder, entries) {
    for (const name of filesWithExt(entries ?? [], IMAGE_EXTENSIONS)) {
        const lower = stem(name).toLowerCase();
        if (COVER_NAMES.some(cover => lower.startsWith(cover)))
            return cacheLocalArt(join(folder, name));
    }
    return null;
}

// Every video under the folder, with subtitle and size info.
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
            // Its own name, or its own name and a language ("Episode.en").
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

// --------------------------------------------------------------------------
// TV shows: <root>/<Show>/[Season N/]<episode>.mkv
//
// Both scanners return null when `root` itself cannot be listed, which is
// out of reach, not empty.
// --------------------------------------------------------------------------
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
                // The display form the UI groups by: "[Extras] OP01 - ..." for
                // named subfolders; plain for season folders (grouped by
                // SxxEyy). Only ever applied to a freshly walked list: a
                // reused one carries its prefixes already.
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

// --------------------------------------------------------------------------
// Films: <root>/<Film (Year)>/<file>.mkv  or  <root>/<Film (Year)>.mkv
// --------------------------------------------------------------------------
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

    // A film that is one loose file has nothing to walk, so it is always read
    // afresh; no signature means nothing ever reuses it either. Nor has it a
    // cover of its own: one in the root would be every loose film's.
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
