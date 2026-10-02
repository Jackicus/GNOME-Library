// The two files and the `tracking` modes: .claude/rules/tracking.md. An entry is
// {watched, at, position?} in seconds; the later `at` wins a merge.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {SECTIONS} from './library.js';

const FOLDER_FILE = '.library-watched.json';
const VERSION = 1;

function localPath() {
    return GLib.build_filenamev([GLib.get_user_data_dir(), 'library-menu@jackicus', 'watched.json']);
}

function parse(bytes) {
    const raw = JSON.parse(new TextDecoder('utf-8').decode(bytes));
    const entries = raw?.entries;
    return entries && typeof entries === 'object' ? entries : {};
}

// Sorted, so unchanged marks serialize the same and need no write.
function serialize(entries) {
    const sorted = {};
    for (const key of Object.keys(entries).sort())
        sorted[key] = entries[key];
    return JSON.stringify({version: VERSION, entries: sorted}, null, 1);
}

const now = () => Math.floor(Date.now() / 1000);

const newer = (a, b) => !b || (a?.at ?? 0) > (b.at ?? 0);

function isNotFound(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND);
}

export class Tracker extends Signals.EventEmitter {
    constructor(settings) {
        super();
        this._settings = settings;
        this._entries = {};
        this._mode = 'none';
        this._cancellable = null;
        this._written = new Map();
        this._writing = new Set();
        this._again = new Set();
        this._savingLocal = false;
        this._saveAgain = false;
        // Cached: asked for on every reading of a playing file's position.
        this._folderList = null;
    }

    static tracks(section) {
        return !!section?.watched;
    }

    get enabled() {
        return this._mode !== 'none';
    }

    enable() {
        this._cancellable = new Gio.Cancellable();
        this._loadLocal();
        this._mode = this._settings.get_string('tracking');
        this._settings.connectObject('changed::tracking', () => this._onModeChanged(), this);
        for (const section of SECTIONS.filter(Tracker.tracks)) {
            this._settings.connectObject(`changed::${section.prefix}-folders`, () => {
                this._folderList = null;
                this.sync();
            }, this);
        }
        this.sync();
    }

    // A write in flight is let finish (see `_writeFolder`).
    disable() {
        this._settings.disconnectObject(this);
        this._cancellable?.cancel();
        this._cancellable = null;
        this._folderList = null;
        this._written.clear();
        this._writing.clear();
        this._again.clear();
    }

    isWatched(path) {
        return this.enabled && typeof path === 'string' && !!this._entries[path]?.watched;
    }

    setWatched(path, watched) {
        if (!this.enabled || typeof path !== 'string')
            return;
        this._entries[path] = {watched, at: now()};
        this._commit(path);
        this.emit('changed', path, watched);
    }

    covers(path) {
        return this.enabled && typeof path === 'string' && !!this._folderOf(path);
    }

    positionOf(path) {
        return this.enabled ? this._entries[path]?.position ?? 0 : 0;
    }

    // Leaves `watched` alone: a second look stopped halfway does not unmark.
    setPosition(path, position) {
        if (!this.enabled || typeof path !== 'string')
            return;
        const previous = this._entries[path];
        position = Math.max(0, Math.floor(position));
        if ((previous?.position ?? 0) === position)
            return;
        const entry = {watched: previous?.watched ?? false, at: now()};
        if (position)
            entry.position = position;
        this._entries[path] = entry;
        this._commit(path);
        this.emit('changed', path, entry.watched);
    }

    continueFrom(order, others = []) {
        if (!this.enabled)
            return null;
        let last = null;
        for (const path of [...order, ...others]) {
            const entry = this._entries[path];
            if (entry && (!last || entry.at > this._entries[last].at))
                last = path;
        }
        if (!last)
            return null;
        const entry = this._entries[last];
        if (entry.position || !entry.watched)
            return last;
        for (let i = order.indexOf(last) + 1; i < order.length; i++) {
            if (!this._entries[order[i]]?.watched)
                return order[i];
        }
        return null;
    }

    _commit(path) {
        this._saveLocal();
        const folder = this._mode === 'source' ? this._folderOf(path) : null;
        if (folder)
            this._writeFolder(folder);
    }

    sync() {
        if (this._mode !== 'source')
            return;
        for (const folder of this._folders())
            this._readFolder(folder);
    }

    _onModeChanged() {
        const previous = this._mode;
        this._mode = this._settings.get_string('tracking');
        if (this._mode === 'source')
            this.sync();
        else if (previous === 'source' && this._mode === 'local')
            this._removeFolderFiles();
    }

    _folders() {
        if (this._folderList)
            return this._folderList;
        const folders = new Set();
        for (const section of SECTIONS.filter(Tracker.tracks)) {
            const listed = this._settings.get_strv(`${section.prefix}-folders`);
            for (const folder of listed) {
                let trimmed = folder.replace(/\/+$/, '');
                if (trimmed === '~' || trimmed.startsWith('~/'))
                    trimmed = GLib.get_home_dir() + trimmed.slice(1);
                if (trimmed)
                    folders.add(trimmed);
            }
        }
        this._folderList = [...folders];
        return this._folderList;
    }

    // The innermost, so a folder listed inside another keeps its own marks.
    _folderOf(path, folders = this._folders()) {
        let best = null;
        for (const folder of folders) {
            if (path.startsWith(`${folder}/`) && (!best || folder.length > best.length))
                best = folder;
        }
        return best;
    }

    _shareOf(folder) {
        const share = {};
        const folders = this._folders();
        for (const [path, entry] of Object.entries(this._entries)) {
            if (this._folderOf(path, folders) === folder)
                share[path.slice(folder.length + 1)] = entry;
        }
        return share;
    }

    _loadLocal() {
        this._entries = {};
        const path = localPath();
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return;
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (ok)
                this._entries = parse(bytes);
        } catch (e) {
            // Put aside, or the next mark would write an empty file over it.
            console.warn(`[Library Menu] Could not read ${path}, keeping it as ${path}.broken: ${e}`);
            GLib.rename(path, `${path}.broken`);
        }
    }

    // Async: a synchronous replace syncs the disk first. Not cancellable, so
    // what is known at a lock goes down.
    _saveLocal() {
        if (this._savingLocal) {
            this._saveAgain = true;
            return;
        }
        const path = localPath();
        GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o700);
        const file = Gio.File.new_for_path(path);
        const bytes = new GLib.Bytes(new TextEncoder().encode(serialize(this._entries)));
        this._savingLocal = true;
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null,
            (_file, result) => {
                this._savingLocal = false;
                try {
                    file.replace_contents_finish(result);
                } catch (e) {
                    console.error(`[Library Menu] Could not write ${path}: ${e.message}`);
                }
                if (this._saveAgain) {
                    this._saveAgain = false;
                    this._saveLocal();
                }
            });
    }

    _readFolder(folder) {
        const file = Gio.File.new_for_path(GLib.build_filenamev([folder, FOLDER_FILE]));
        file.load_contents_async(this._cancellable, (_file, result) => {
            let theirs = {};
            try {
                const [, bytes] = file.load_contents_finish(result);
                theirs = parse(bytes);
            } catch (e) {
                if (e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                // Missing is usual and written below; unreadable is left alone.
                if (!isNotFound(e)) {
                    console.warn(`[Library Menu] Could not read ${file.get_path()}: ${e.message}`);
                    return;
                }
            }
            if (this._mode !== 'source')
                return;
            // No file and nothing to say: recorded as the empty share, so not written.
            this._written.set(folder, serialize(theirs));

            const changed = [];
            let merged = false;
            const folders = this._folders();
            for (const [relative, entry] of Object.entries(theirs)) {
                const path = `${folder}/${relative}`;
                const previous = this._entries[path];
                if (typeof entry?.watched === 'boolean' && this._folderOf(path, folders) === folder &&
                    newer(entry, previous)) {
                    this._entries[path] = {watched: entry.watched, at: entry.at ?? 0};
                    if (typeof entry.position === 'number' && entry.position > 0)
                        this._entries[path].position = Math.floor(entry.position);
                    merged = true;
                    if (entry.watched !== !!previous?.watched)
                        changed.push(path);
                }
            }
            if (merged)
                this._saveLocal();
            for (const path of changed)
                this.emit('changed', path, this._entries[path].watched);
            this._writeFolder(folder);
        });
    }

    _writeFolder(folder) {
        if (this._writing.has(folder)) {
            this._again.add(folder);
            return;
        }
        // Never over a file not yet read: it may hold another machine's marks.
        if (!this._written.has(folder)) {
            this._readFolder(folder);
            return;
        }
        const contents = serialize(this._shareOf(folder));
        if (this._written.get(folder) === contents)
            return;

        this._writing.add(folder);
        const file = Gio.File.new_for_path(GLib.build_filenamev([folder, FOLDER_FILE]));
        const bytes = new GLib.Bytes(new TextEncoder().encode(contents));
        // Not cancellable: the last thing a lock does is keep the position, and a
        // cancelled replace leaves its temporary file beside the media.
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE,
            null, (_file, result) => {
                this._writing.delete(folder);
                try {
                    file.replace_contents_finish(result);
                    this._written.set(folder, contents);
                } catch (e) {
                    console.warn(`[Library Menu] Could not write ${file.get_path()}: ${e.message}`);
                }
                if (this._again.delete(folder) && this._mode === 'source')
                    this._writeFolder(folder);
            });
    }

    _removeFolderFiles() {
        for (const folder of this._folders()) {
            const file = Gio.File.new_for_path(GLib.build_filenamev([folder, FOLDER_FILE]));
            file.delete_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_file, result) => {
                try {
                    file.delete_finish(result);
                } catch (e) {
                    if (!isNotFound(e) && !e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`[Library Menu] Could not remove ${file.get_path()}: ${e.message}`);
                }
            });
        }
        this._written.clear();
    }
}
