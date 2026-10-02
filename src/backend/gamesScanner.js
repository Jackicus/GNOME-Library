// Installed games come from the launchers' own bookkeeping, not a folder walk:
// Steam's library files and PCSX2's ini (backend/CLAUDE.md).

import GLib from 'gi://GLib';

import {extension, join, stem} from './files.js';
import {cacheLocalArt, pathKey} from './metadata.js';
import {list, realpath, sizeMb, sortNatural} from './mediaScanner.js';

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.heic', '.avif', '.tiff', '.bmp']);

// ~/.steam/steam is usually a link to one of the others: roots are compared resolved.
const STEAM_ROOTS = [
    '~/.steam/steam',
    '~/.steam/debian-installation',
    '~/.local/share/Steam',
    '~/.var/app/com.valvesoftware.Steam/.local/share/Steam',
    '~/.var/app/com.valvesoftware.Steam/data/Steam',
];
// Registered like games, played by nobody.
const NON_GAMES = ['steamworks common redistributables', 'steam linux runtime', 'proton', 'steamvr',
    'steam controller configs'];

const PCSX2_CONFIG_ROOTS = ['~/.config/PCSX2', '~/.var/app/net.pcsx2.PCSX2/config/PCSX2', '~/.config/pcsx2', '~/.PCSX2'];
const PCSX2_EXECUTABLES = [
    '~/.local/share/flatpak/exports/bin/net.pcsx2.PCSX2',
    '/var/lib/flatpak/exports/bin/net.pcsx2.PCSX2',
    '/usr/bin/pcsx2-qt',
    '/usr/bin/pcsx2',
    '/usr/games/pcsx2-qt',
    '/usr/games/pcsx2',
    '/usr/local/bin/pcsx2-qt',
    '/usr/local/bin/pcsx2',
    '/snap/bin/pcsx2',
];
const PCSX2_APPIMAGE_DIRS = ['~/Applications', '~/.local/bin', '~/bin', '~/Downloads'];
// A .bin is a game only when no .cue names it: otherwise it is the cue's track data.
const PS2_EXTENSIONS = new Set(['.iso', '.chd', '.cso', '.zso', '.cue', '.elf', '.gz', '.mdf', '.nrg', '.bin']);
const PS2_MAX_DEPTH = 5;
const PS2_MAX_FILES = 2000;
// "SLUS-20062", "SCES_502.10": what PCSX2 names a cover after.
const SERIAL = /\b(S[A-Z]{3}[-_]?\d{3}\.?\d{2})\b/i;

function expandUser(path) {
    return path === '~' || path.startsWith('~/') ? GLib.get_home_dir() + path.slice(1) : path;
}

function isDir(path) {
    return GLib.file_test(path, GLib.FileTest.IS_DIR);
}

function isFile(path) {
    return GLib.file_test(path, GLib.FileTest.IS_REGULAR);
}

function executable(path) {
    return GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE);
}

function readText(path) {
    try {
        return new TextDecoder('utf-8').decode(GLib.file_get_contents(path)[1]);
    } catch {
        return null;
    }
}

function names(path) {
    return list(path, true)?.map(e => e.name) ?? [];
}

function intOrNull(value) {
    const text = String(value ?? '').trim();
    return /^[+-]?\d+$/.test(text) ? parseInt(text, 10) : null;
}

function mb(bytes) {
    return Number((bytes / (1024 * 1024)).toFixed(1));
}

function existingRoots(candidates) {
    const roots = [];
    for (const raw of candidates) {
        if (!raw)
            continue;
        const path = realpath(expandUser(raw));
        if (!roots.includes(path) && isDir(path))
            roots.push(path);
    }
    return roots;
}

const VDF_TOKEN = /"((?:[^"\\]|\\.)*)"|([{}])/g;

function unescapeVdf(text) {
    return text.replaceAll('\\\\', '\\').replaceAll('\\"', '"');
}

// Valve's key/value files, tolerantly: the client writes them, and only a few
// known keys are read. A repeated key keeps its first value, as Steam does.
export function parseVdf(text) {
    const root = {};
    const stack = [root];
    let pending = null;
    for (const [, string, brace] of (text ?? '').matchAll(VDF_TOKEN)) {
        const top = stack.at(-1);
        if (brace === '{') {
            let child = {};
            if (pending !== null) {
                if (!Object.hasOwn(top, pending))
                    top[pending] = child;
                child = top[pending];
                pending = null;
            }
            stack.push(typeof child === 'object' ? child : {});
        } else if (brace === '}') {
            if (stack.length > 1)
                stack.pop();
            pending = null;
        } else if (pending === null) {
            pending = unescapeVdf(string);
        } else {
            if (!Object.hasOwn(top, pending))
                top[pending] = unescapeVdf(string);
            pending = null;
        }
    }
    return root;
}

function vdfGet(node, ...path) {
    for (const key of path) {
        if (!node || typeof node !== 'object')
            return null;
        const found = Object.keys(node).find(k => k.toLowerCase() === key.toLowerCase());
        if (found === undefined)
            return null;
        node = node[found];
    }
    return node;
}

function steamLibraries(root) {
    const libraries = [root];
    const folders = vdfGet(parseVdf(readText(join(root, 'steamapps/libraryfolders.vdf'))), 'libraryfolders') ?? {};
    for (const entry of Object.values(folders)) {
        if (!entry || typeof entry !== 'object' || !entry.path)
            continue;
        const path = realpath(entry.path);
        if (isDir(join(path, 'steamapps')) && !libraries.includes(path))
            libraries.push(path);
    }
    return libraries;
}

// Per Steam account; on a shared machine the largest across accounts is this install's.
function steamPlaytimes(root) {
    const out = {};
    const userdata = join(root, 'userdata');
    for (const account of names(userdata)) {
        const apps = vdfGet(parseVdf(readText(join(userdata, `${account}/config/localconfig.vdf`))),
            'UserLocalConfigStore', 'Software', 'Valve', 'Steam', 'apps');
        if (!apps || typeof apps !== 'object')
            continue;
        for (const [appid, values] of Object.entries(apps)) {
            if (!values || typeof values !== 'object')
                continue;
            const minutes = intOrNull(values.Playtime || values.playtime);
            const played = intOrNull(values.LastPlayed || values.lastplayed);
            out[appid] ??= {playtime_minutes: null, last_played: null};
            const record = out[appid];
            if (minutes !== null && (record.playtime_minutes || 0) < minutes)
                record.playtime_minutes = minutes;
            if (played !== null && (record.last_played || 0) < played)
                record.last_played = played;
        }
    }
    return out;
}

// The client caches lazily, in either of two layouts; what it lacks the store CDN has.
async function steamLocalArt(root, appid) {
    const cache = join(root, 'appcache/librarycache');
    const found = ['library_600x900', 'library_hero'].map(name => [
        join(cache, `${appid}/${name}.jpg`),
        join(cache, `${appid}/${name}.png`),
        join(cache, `${appid}_${name}.jpg`),
        join(cache, `${appid}_${name}.png`),
    ].find(isFile) ?? null);
    return [await cacheLocalArt(found[0]), await cacheLocalArt(found[1], 'backdrop')];
}

async function steamGame(steamapps, manifest, root, playtimes) {
    const state = vdfGet(parseVdf(readText(join(steamapps, manifest))), 'AppState');
    if (!state || typeof state !== 'object')
        return null;
    const appid = String(state.appid || '').trim();
    const title = (state.name || '').trim();
    const installdir = (state.installdir || '').trim();
    if (!appid || !title || !installdir || NON_GAMES.some(n => title.toLowerCase().includes(n)))
        return null;
    const folder = join(steamapps, `common/${installdir}`);
    if (!isDir(folder))
        return null;   // a manifest left behind by an uninstall

    const [poster, backdrop] = await steamLocalArt(root, appid);
    const played = playtimes[appid] ?? {};
    const size = intOrNull(state.SizeOnDisk) || 0;
    return {
        id: `steam_${appid}`,
        kind: 'game',
        title,
        platform: 'steam',
        year: null,
        folder_path: folder,
        // steam:// keeps the client's launch options, compatibility tool and overlay.
        launch: ['xdg-open', `steam://rungameid/${appid}`],
        poster_path: poster,
        backdrop_path: backdrop,
        summary: null,
        genres: [],
        rating: null,
        playtime_minutes: played.playtime_minutes ?? null,
        last_played: played.last_played ?? null,
        app_id: appid,
        steam_root: root,
        size_mb: size ? mb(size) : 0,
    };
}

async function scanSteam(explicit) {
    const games = [];
    for (const root of existingRoots(explicit ? [explicit] : STEAM_ROOTS)) {
        const playtimes = steamPlaytimes(root);
        for (const library of steamLibraries(root)) {
            const steamapps = join(library, 'steamapps');
            const manifests = sortNatural(
                names(steamapps).filter(n => n.startsWith('appmanifest_') && n.endsWith('.acf')), n => n);
            for (const manifest of manifests) {
                // eslint-disable-next-line no-await-in-loop -- one manifest at a time, as listed
                const game = await steamGame(steamapps, manifest, root, playtimes);
                if (game)
                    games.push(game);
            }
        }
        if (games.length)
            break;   // the first install with games wins
    }
    return sortNatural(games, g => g.title);
}

function pcsx2Executable() {
    for (const candidate of PCSX2_EXECUTABLES) {
        const path = expandUser(candidate);
        if (isFile(path) && executable(path))
            return path;
    }
    for (const directory of PCSX2_APPIMAGE_DIRS) {
        const folder = expandUser(directory);
        for (const name of sortNatural(names(folder), n => n)) {
            const lower = name.toLowerCase();
            if (lower.startsWith('pcsx2') && lower.endsWith('.appimage') && executable(join(folder, name)))
                return join(folder, name);
        }
    }
    return null;
}

// Repeated keys are newline-joined: [GameList] RecursivePaths is one line per folder.
export function parseIni(text) {
    const sections = {General: {}};
    let current = sections.General;
    for (let line of (text ?? '').split(/\r\n|\r|\n/)) {
        line = line.trim();
        if (!line || ';#'.includes(line[0]))
            continue;
        if (line.startsWith('[') && line.endsWith(']')) {
            const name = line.slice(1, -1).trim();
            sections[name] ??= {};
            current = sections[name];
            continue;
        }
        const cut = line.indexOf('=');
        if (cut < 0)
            continue;
        const key = line.slice(0, cut).trim();
        const value = line.slice(cut + 1).replace(/\s+[;#].*$/, '').trim();
        current[key] = Object.hasOwn(current, key) ? `${current[key]}\n${value}` : value;
    }
    return sections;
}

function caseless(object, ...wanted) {
    const key = Object.keys(object).find(k => wanted.some(w => k.toLowerCase() === w.toLowerCase()));
    return key === undefined ? null : object[key];
}

function unquote(value) {
    let bare = (value || '').trim();
    if (bare.length > 1 && bare[0] === '"' && bare.at(-1) === '"')
        bare = bare.slice(1, -1).trim();
    return bare.length > 1 ? bare.replace(/\/+$/, '') : bare;
}

// [Folders] paths resolve against the data root, one level above inis/.
function pcsx2Paths(root) {
    const ini = [join(root, 'PCSX2.ini'), join(root, 'inis/PCSX2.ini')].find(isFile);
    if (!ini)
        return [[], null];
    const sections = parseIni(readText(ini));
    let base = GLib.path_get_dirname(ini);
    if (GLib.path_get_basename(base).toLowerCase() === 'inis')
        base = GLib.path_get_dirname(base);
    const resolve = folder => GLib.path_is_absolute(folder) ? folder : join(base, folder);

    const covers = unquote(caseless(caseless(sections, 'Folders') ?? {}, 'Covers') || '');
    let coversDir = covers ? resolve(covers) : null;
    if (!coversDir || !isDir(coversDir))
        coversDir = isDir(join(base, 'covers')) ? join(base, 'covers') : null;

    const dirs = [];
    const add = folder => {
        if (folder && !dirs.includes(resolve(folder)))
            dirs.push(resolve(folder));
    };
    for (const [key, value] of Object.entries(caseless(sections, 'GameList') ?? {})) {
        if (/^(RecursivePaths|Paths|SearchDirectories|GameDirs)$/i.test(key))
            value.split(/[;|\n]/).forEach(part => add(unquote(part)));
    }
    // The older layout: [GameDir\0], [GameDir\1], each with a Path.
    for (const [name, keys] of Object.entries(sections)) {
        if (name.startsWith('GameDir') && keys.Path)
            add(unquote(keys.Path));
    }
    return [dirs, coversDir];
}

// Depth-first in name order, not into hidden folders or linked ones.
function discsUnder(folder) {
    const found = [];
    const bins = [];
    const cueStems = new Set();
    const visit = (dir, depth) => {
        const entries = list(dir, true) ?? [];
        for (const {name} of sortNatural(entries.filter(e => !e.dir && !e.name.startsWith('.')), e => e.name)) {
            const ext = extension(name).toLowerCase();
            if (!PS2_EXTENSIONS.has(ext))
                continue;
            const path = join(dir, name);
            if (ext === '.bin') {
                bins.push(path);
                continue;
            }
            if (ext === '.cue')
                cueStems.add(stem(path).toLowerCase());
            found.push(path);
        }
        if (found.length + bins.length >= PS2_MAX_FILES)
            return false;
        if (depth >= PS2_MAX_DEPTH)
            return true;
        for (const sub of sortNatural(entries.filter(e => e.dir && !e.name.startsWith('.')), e => e.name)) {
            if (!sub.link && !visit(join(dir, sub.name), depth + 1))
                return false;
        }
        return true;
    };
    visit(folder, 0);
    return [...found, ...bins.filter(b => !cueStems.has(stem(b).toLowerCase()))];
}

// Named after the game's title or its serial.
async function pcsx2Cover(coversDir, title, serial) {
    if (!coversDir || !isDir(coversDir))
        return null;
    const wanted = new Set([title, serial].filter(Boolean).map(t => t.toLowerCase()));
    const name = sortNatural(names(coversDir), n => n).find(n =>
        IMAGE_EXTENSIONS.has(extension(n).toLowerCase()) && wanted.has(stem(n).toLowerCase()));
    return name ? cacheLocalArt(join(coversDir, name)) : null;
}

// 'Shadow of the Colossus (USA) [SCUS-97472]' -> 'Shadow of the Colossus'.
function discTitle(name) {
    const title = name.replace(/\s*[([][^)\]]*[)\]]/g, ' ').replace(/[._]+/g, ' ');
    return title.replace(/\s{2,}/g, ' ').trim() || name;
}

async function ps2Game(disc, coversDir, emulator) {
    const name = stem(GLib.path_get_basename(disc));
    const match = SERIAL.exec(name);
    const serial = match ? match[1].toUpperCase().replaceAll('_', '-') : null;
    const title = discTitle(name);
    return {
        id: `ps2_${pathKey(disc)}`,
        kind: 'game',
        title,
        platform: 'ps2',
        year: null,
        folder_path: GLib.path_get_dirname(disc),
        // `--` ends PCSX2's own options, for a disc image named like a flag.
        launch: emulator ? [emulator, '-fullscreen', '--', disc] : null,
        poster_path: await pcsx2Cover(coversDir, title, serial) ?? await pcsx2Cover(coversDir, name, null),
        backdrop_path: null,
        summary: null,
        genres: [],
        rating: null,
        playtime_minutes: null,
        serial,
        disc_path: disc,
        disc_format: extension(disc).toLowerCase().slice(1),
        size_mb: sizeMb(disc),
    };
}

// Empty and quiet without PCSX2, or before its first launch writes PCSX2.ini.
async function scanPcsx2(explicit) {
    const emulator = pcsx2Executable();
    const games = [];
    const seen = new Set();
    for (const root of existingRoots(explicit ? [explicit] : PCSX2_CONFIG_ROOTS)) {
        const [dirs, coversDir] = pcsx2Paths(root);
        for (const folder of dirs.filter(isDir)) {
            for (const disc of discsUnder(folder)) {
                const real = realpath(disc);
                if (seen.has(real))
                    continue;
                seen.add(real);
                // eslint-disable-next-line no-await-in-loop -- a cover is copied in per disc
                games.push(await ps2Game(disc, coversDir, emulator));
            }
        }
        if (games.length)
            break;
    }
    return sortNatural(games, g => g.title);
}

// Steam, then PS2; either may be empty, neither may stop the other.
export async function scanGames(steamPath = '', pcsx2Path = '') {
    const games = [];
    for (const [label, scan, root] of [['Steam', scanSteam, steamPath], ['PCSX2', scanPcsx2, pcsx2Path]]) {
        let found;
        try {
            // eslint-disable-next-line no-await-in-loop -- Steam's first, as listed
            found = await scan(root);
        } catch (e) {
            print(`${label} scan failed: ${e.message}`);
            continue;
        }
        if (!found.length)
            print(`${label}: nothing found${root ? ` under ${root}` : ' (auto-detect)'}`);
        games.push(...found);
    }
    for (const game of games)
        game.id = game.id.toLowerCase().replace(/[^a-z0-9]/g, '_');
    return games;
}
