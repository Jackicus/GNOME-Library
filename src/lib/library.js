// Reads the scanner's library.json into the items the views draw.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export const SECTIONS = [
    {
        key: 'tv',
        prefix: 'tv-shows',
        title: 'TV Shows',
        icon: 'tv-symbolic',
        aspect: 1.5,
        watched: true,
        emptyHint: 'Add a folder with one subfolder per show in Settings.',
    },
    {
        key: 'films',
        prefix: 'films',
        title: 'Films',
        icon: 'video-x-generic-symbolic',
        aspect: 1.5,
        watched: true,
        emptyHint: 'Add a folder with one subfolder or file per film in Settings.',
    },
];

// The button's title and icon; -symbolic, so St recolours it.
export const LIBRARY = {
    title: 'Videos',
    icon: 'icons/library-symbolic.svg',
};

export function sectionByKey(key) {
    return SECTIONS.find(s => s.key === key) ?? SECTIONS[0];
}

export function openCommandKey(section) {
    return `${section.prefix}-open-command`;
}

// player-command is superseded by the per-section open commands.
export function migrateOpenCommand(settings) {
    const legacy = settings.get_string('player-command');
    if (!legacy)
        return;
    for (const key of ['tv-shows-open-command', 'films-open-command']) {
        // Unset, not empty: an empty command is a choice.
        if (settings.get_user_value(key) === null)
            settings.set_string(key, legacy);
    }
    settings.set_string('player-command', '');
}

function cacheDir() {
    return GLib.build_filenamev([GLib.get_user_cache_dir(), 'video-library']);
}

export function libraryPath() {
    return GLib.build_filenamev([cacheDir(), 'library.json']);
}

export function readSections() {
    const nothing = {sections: {}, generated: null};
    const path = libraryPath();
    if (!GLib.file_test(path, GLib.FileTest.EXISTS))
        return nothing;
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        if (!ok)
            return nothing;
        const raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
        return {sections: raw?.sections ?? {}, generated: raw?.generated ?? null};
    } catch (e) {
        console.error(`[Video Library] Failed to read ${path}: ${e}`);
        return nothing;
    }
}

export function loadLibrary() {
    const empty = Object.fromEntries(SECTIONS.map(s => [s.key, []]));
    const {sections} = readSections();
    const art = artworkIndex();
    const out = {...empty};
    for (const section of SECTIONS) {
        const items = sections[section.key];
        if (Array.isArray(items))
            out[section.key] = items.map(item => normalize(item, section.key, art)).filter(Boolean);
    }
    return out;
}

// Every artwork path is the scanner's, in the cache: its two folders are listed
// once rather than stat a poster each, and a path elsewhere counts as missing.
const ART_DIRS = ['posters', 'backdrops'];

function listNames(path) {
    const names = new Set();
    let children;
    try {
        children = Gio.File.new_for_path(path).enumerate_children(
            'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    } catch {
        return names;   // the folder is not there yet: nothing is cached
    }
    let info;
    while ((info = children.next_file(null)) !== null)
        names.add(info.get_name());
    children.close(null);
    return names;
}

function artworkIndex() {
    const root = cacheDir();
    const index = new Map();
    for (const name of ART_DIRS) {
        const dir = GLib.build_filenamev([root, name]);
        index.set(dir, listNames(dir));
    }
    return index;
}

function exists(path, art) {
    if (!path)
        return false;
    const cut = path.lastIndexOf('/');
    return art.get(path.slice(0, cut))?.has(path.slice(cut + 1)) ?? false;
}

function plural(n, word) {
    return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function normalize(item, sectionKey, art) {
    if (!item || !item.title)
        return null;
    const base = {
        id: item.id ?? item.title,
        kind: sectionKey,
        title: item.title,
        year: item.year ?? null,
        rating: item.rating ?? null,
        tags: Array.isArray(item.genres) ? item.genres.slice(0, 3) : [],
        summary: item.summary ?? null,
        art: exists(item.poster_path, art) ? item.poster_path : null,
        backdrop: exists(item.backdrop_path, art) ? item.backdrop_path : null,
        tagline: item.tagline ?? null,
        folder: item.folder_path ?? null,
    };
    switch (sectionKey) {
    case 'tv': return normalizeShow(item, base);
    case 'films': return normalizeFilm(item, base);
    default: return null;
    }
}

// "Season 3" -> 3, null for named groups such as "Extras" or "OVA".
function seasonNumberOf(name) {
    const m = String(name).match(/(\d+)/);
    return m ? parseInt(m[1], 10) : null;
}

const EPISODE_TAG = /S(\d+)\s*E(\d+)/i;

// "Harbour Lights - S01E01 - The Pilot" -> "The Pilot", or the input if nothing is left.
function episodeTitle(raw) {
    const stripped = raw
        .replace(/^\[[^\]]*\]\s*/, '')
        .replace(/^.*?S\d+\s*E\d+\s*[-–—.:]?\s*/i, '')
        .trim();
    return stripped || raw;
}

// The subfolder, or for an episode beside the season folders, its SxxEyy's season.
function groupOf(ep) {
    const group = ep.group;
    if (typeof group === 'string' && group) {
        if (!/^season\b/i.test(group))
            return group;
        const n = seasonNumberOf(group);
        if (n !== null)
            return `Season ${n}`;
    } else if (group === undefined) {
        // An older library.json named the subfolder in the title: "[Extras] OP01".
        const title = ep.title || '';
        if (title.startsWith('[') && title.includes(']'))
            return title.slice(1, title.indexOf(']')).trim();
    }
    const m = (ep.filename || '').match(/S(\d+)/i);
    return m ? `Season ${parseInt(m[1], 10)}` : 'Season 1';
}

function normalizeShow(show, base) {
    const episodes = Array.isArray(show.episodes) ? show.episodes : [];
    const bySeason = new Map();

    for (const ep of episodes) {
        const season = groupOf(ep);
        if (!bySeason.has(season))
            bySeason.set(season, []);
        bySeason.get(season).push(ep);
    }

    // Numbered seasons in order, then named groups alphabetically.
    const names = [...bySeason.keys()].sort((a, b) => {
        const na = seasonNumberOf(a), nb = seasonNumberOf(b);
        if (na !== null && nb !== null) return na - nb;
        if (na !== null) return -1;
        if (nb !== null) return 1;
        return a.localeCompare(b);
    });

    const groups = names.map(name => ({
        name,
        // Numbered seasons are the run Continue walks; Extras are not.
        season: seasonNumberOf(name) !== null,
        entries: bySeason.get(name).map((ep, i) => {
            const tag = (ep.filename || '').match(EPISODE_TAG);
            return {
                index: tag ? parseInt(tag[2], 10) : i + 1,
                title: episodeTitle(ep.title || ep.filename || ''),
                subtitle: null,
                code: tag ? `S${tag[1].padStart(2, '0')}E${tag[2].padStart(2, '0')}` : null,
                path: ep.path,
                badges: ep.has_subtitles ? ['SUB'] : [],
                size: ep.size_mb ? `${ep.size_mb} MB` : null,
            };
        }),
    }));

    const first = groups[0]?.entries[0] ?? null;
    return {
        ...base,
        countLabel: plural(episodes.length, 'episode'),
        groups,
        groupLabel: groups.length === 1 ? null : `${groups.length} seasons`,
        playPath: first?.path ?? null,
        playLabel: first?.code ? `Play ${first.code}` : 'Play',
    };
}

function normalizeFilm(film, base) {
    const files = Array.isArray(film.files) ? film.files : [];
    const entries = files.map((f, i) => ({
        index: i + 1,
        title: f.title || f.filename,
        subtitle: f.group ?? null,
        path: f.path,
        badges: f.has_subtitles ? ['SUB'] : [],
        size: f.size_mb ? `${f.size_mb} MB` : null,
    }));
    const runtime = film.runtime ? `${film.runtime} min` : null;
    return {
        ...base,
        countLabel: runtime ?? (files.length > 1 ? plural(files.length, 'file') : null),
        groups: [{name: files.length > 1 ? 'Files' : 'File', entries}],
        groupLabel: null,
        playPath: film.main_path ?? files[0]?.path ?? null,
        playLabel: 'Play',
    };
}
