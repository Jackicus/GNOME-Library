// Synchronous on purpose: the scanner runs in a process of its own.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

export function join(folder, name) {
    return GLib.build_filenamev([folder, name]);
}

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

// Seconds by way of a GDateTime: Gio's unsigned attribute turns a time before
// 1970 into one far in the future.
const MODIFIED = 'time::modified,time::modified-usec,time::modified-nsec';

export function modified(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info(MODIFIED, Gio.FileQueryInfoFlags.NONE, null);
        const usec = info.get_modification_date_time()?.to_unix_usec();
        if (usec === undefined)
            return null;
        const seconds = Math.floor(usec / 1e6);
        const nanoseconds = info.has_attribute('time::modified-nsec')
            ? info.get_attribute_uint32('time::modified-nsec')
            : (usec - seconds * 1e6) * 1000;
        return seconds + nanoseconds * 1e-9;
    } catch {
        return null;
    }
}

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

export function names(folder) {
    const found = [];
    const enumerator = Gio.File.new_for_path(folder).enumerate_children(
        'standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
    for (let info = enumerator.next_file(null); info; info = enumerator.next_file(null))
        found.push(info.get_name());
    enumerator.close(null);
    return found;
}

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

export function readJson(path) {
    try {
        return JSON.parse(decode(GLib.file_get_contents(path)[1]));
    } catch {
        return null;
    }
}

// file_set_contents renames over the old file, so a reader sees a whole one.
export function writeJson(path, value, indent) {
    GLib.file_set_contents(path, encoder.encode(JSON.stringify(value, null, indent)));
}
