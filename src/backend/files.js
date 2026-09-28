// The small file helpers both halves of the scanner use. Everything here is
// synchronous: the scanner runs in a process of its own, so a slow disk holds
// up only the scan.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function join(folder, name) {
    return GLib.build_filenamev([folder, name]);
}

// The extension, dot and all, of a name that does not start with its dot.
export function extension(name) {
    const dot = name.lastIndexOf('.');
    return dot > name.lastIndexOf('/') + 1 ? name.slice(dot) : '';
}

export function stem(name) {
    const ext = extension(name);
    return ext ? name.slice(0, -ext.length) : name;
}

export function exists(path) {
    return GLib.file_test(path, GLib.FileTest.EXISTS);
}

// A file's modification time in seconds, nanoseconds and all, following a
// link; null if it cannot be read.
const MODIFIED = 'time::modified,time::modified-usec,time::modified-nsec';

export function modified(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(MODIFIED, Gio.FileQueryInfoFlags.NONE, null);
        const nanoseconds = info.has_attribute('time::modified-nsec')
            ? info.get_attribute_uint32('time::modified-nsec')
            : info.get_attribute_uint32('time::modified-usec') * 1000;
        return info.get_attribute_uint64('time::modified') + nanoseconds * 1e-9;
    } catch {
        return null;
    }
}

// Put in place in one move: the shell may be reading the file it replaces.
export function rename(from, to) {
    Gio.File.new_for_path(from).move(Gio.File.new_for_path(to), Gio.FileCopyFlags.OVERWRITE, null, null);
}

export function remove(path) {
    try {
        Gio.File.new_for_path(path).delete(null);
        return true;
    } catch {
        return false;
    }
}

// The names in a folder, hidden ones included.
export function names(folder) {
    const found = [];
    const enumerator = Gio.File.new_for_path(folder).enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
        found.push(info.get_name());
    enumerator.close(null);
    return found;
}

// A folder and everything in it, links deleted rather than followed.
export function removeTree(path) {
    const type = Gio.File.new_for_path(path).query_file_type(Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    if (type === Gio.FileType.DIRECTORY) {
        for (const name of names(path))
            removeTree(join(path, name));
    }
    remove(path);
}

const decoder = new TextDecoder('utf-8', {fatal: true});
const encoder = new TextEncoder();

export function decode(bytes) {
    return decoder.decode(bytes);
}

// Parsed JSON, or null for a file that is missing or is not JSON.
export function readJson(path) {
    try {
        return JSON.parse(decode(GLib.file_get_contents(path)[1]));
    } catch {
        return null;
    }
}

// Written to a temporary file and renamed over the old one, so the shell's
// file monitor, and the next scan, only ever see a whole file.
export function writeJson(path, value, indent) {
    GLib.file_set_contents(path, encoder.encode(JSON.stringify(value, null, indent)));
}
