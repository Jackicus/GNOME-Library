// The development entry point, installed by `make link` in place of
// src/extension.js, which imports lib/ once as an install should. Nothing here
// ships.
//
// Copied from the GNOME-EXTENSIONS kit (template/scripts/dev-extension.js) by
// its scripts/sync.sh: change it there. What it builds is named in
// dev-extension.json, which `./scripts/dev.sh link` writes beside it from
// scripts/ext.conf.
//
// GJS caches ES modules by URL for the life of the process, so re-importing
// lib/ after an edit would hand back the old code. Every enable() therefore
// stages lib/ into a directory named after a checksum of its files (path, size
// and modification time to the microsecond) and imports from there: a fresh
// directory per edit reloads without a shell restart, while an unlock
// re-enables into the same stage and the same module graph. GNOME Shell names a
// GObject class after the path of the module that registers it, so a class in a
// new stage registers under a new name; a GTypeName set in lib/ would not, so
// none is.
//
// Each shell stages under a directory of its own, named for its process id, and
// removes only its own old stages and those of shells that are gone. A nested
// shell shares the runtime directory with the real one, and neither may delete
// what the other has imported.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

export default class DevelopmentExtension extends Extension {
    async enable() {
        // disable() can arrive while the import is still pending, and would
        // find no app to take down; the one built afterwards would then never
        // be taken down at all.
        const enabling = {};
        this._enabling = enabling;
        const config = this._config();
        try {
            const lib = this._stageLib();
            const module = await import(lib.get_child('app.js').get_uri());
            const log = lib.get_child('log.js');
            const verbose = log.query_exists(null) ? await import(log.get_uri()) : null;
            if (this._enabling !== enabling)
                return;
            verbose?.setVerbose?.(true);
            const App = config.appClass
                ? module[config.appClass]
                : Object.entries(module).find(([name, value]) =>
                    typeof value === 'function' && name.endsWith('App'))?.[1];
            if (typeof App !== 'function')
                throw new Error(`lib/app.js exports no ${config.appClass ?? '…App class'}`);
            this._app = new App(this);
            this._app.enable();
            console.log(`${config.logPrefix} Enabled from ${lib.get_path()}`);
        } catch (e) {
            console.error(`${config.logPrefix} Failed to load lib/app.js:`, e);
        }
    }

    disable() {
        this._enabling = null;
        if (this._app) {
            try {
                this._app.disable();
            } catch (e) {
                console.error(`${this._config().logPrefix} Error during disable:`, e);
            }
            this._app = null;
        }
    }

    // dev-extension.json; without it (a link made before the kit wrote one), the
    // class lib/app.js exports whose name ends in App, and the extension's name.
    _config() {
        const config = {appClass: null, logPrefix: `[${this.metadata.name}]`};
        try {
            const [, bytes] = this.dir.get_child('dev-extension.json').load_contents(null);
            Object.assign(config, JSON.parse(new TextDecoder().decode(bytes)));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
                console.warn(`${config.logPrefix} dev-extension.json: ${e.message}`);
        }
        return config;
    }

    _stageLib() {
        const base = Gio.File.new_for_path(GLib.build_filenamev([
            GLib.get_user_runtime_dir(), this.uuid.split('@')[0]]));
        const pid = Gio.Credentials.new().get_unix_pid();
        const own = base.get_child(`shell-${pid}`);

        const src = this.dir.get_child('lib');
        const files = [];
        listTree(src, '', files);
        files.sort((a, b) => a.path.localeCompare(b.path));
        const stamp = GLib.compute_checksum_for_string(GLib.ChecksumType.SHA256,
            files.map(f => f.stamp).join('\n'), -1).slice(0, 16);

        const stage = own.get_child(`lib-${stamp}`);
        if (!stage.query_exists(null)) {
            // Built under another name and renamed into place, so a stage that
            // exists is always whole.
            const building = own.get_child(`.lib-${stamp}-${GLib.get_monotonic_time()}`);
            makeDirectory(building);
            for (const file of files) {
                const target = building.resolve_relative_path(file.path);
                makeDirectory(target.get_parent());
                src.resolve_relative_path(file.path).copy(target, Gio.FileCopyFlags.NONE, null, null);
            }
            building.move(stage, Gio.FileCopyFlags.NONE, null, null);
        }

        this._sweep(base, own, stage);
        return stage;
    }

    // Removes this shell's other stages, and the directories of shells that no
    // longer run. Another live shell's stages are never touched.
    _sweep(base, own, keep) {
        for (const name of listNames(own)) {
            if (name !== keep.get_basename())
                removeTree(own.get_child(name));
        }
        for (const name of listNames(base)) {
            const match = /^shell-(\d+)$/.exec(name);
            if (match && !GLib.file_test(`/proc/${match[1]}`, GLib.FileTest.EXISTS))
                removeTree(base.get_child(name));
        }
    }
}

// Every file under DIR, with what its stamp is made of: path, size, mtime.
function listTree(dir, prefix, out) {
    const attrs = 'standard::name,standard::type,standard::size,time::modified,time::modified-usec';
    const it = dir.enumerate_children(attrs, Gio.FileQueryInfoFlags.NONE, null);
    let info;
    while ((info = it.next_file(null))) {
        const name = info.get_name();
        const path = prefix ? `${prefix}/${name}` : name;
        if (info.get_file_type() === Gio.FileType.DIRECTORY) {
            listTree(dir.get_child(name), path, out);
        } else if (info.get_file_type() === Gio.FileType.REGULAR && !name.startsWith('.')) {
            const mtime = info.get_modification_date_time();
            out.push({path, stamp: `${path}:${info.get_size()}:${mtime.to_unix()}:${mtime.get_microsecond()}`});
        }
    }
    it.close(null);
}

function makeDirectory(dir) {
    try {
        dir.make_directory_with_parents(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.EXISTS))
            throw e;
    }
}

function listNames(dir) {
    const names = [];
    try {
        const it = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = it.next_file(null)))
            names.push(info.get_name());
        it.close(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`Could not list ${dir.get_path()}: ${e.message}`);
    }
    return names;
}

function removeTree(file) {
    try {
        const it = file.enumerate_children('standard::name,standard::type',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS, null);
        let info;
        while ((info = it.next_file(null))) {
            const child = file.get_child(info.get_name());
            if (info.get_file_type() === Gio.FileType.DIRECTORY)
                removeTree(child);
            else
                child.delete(null);
        }
        it.close(null);
        file.delete(null);
    } catch (e) {
        if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.NOT_FOUND))
            console.warn(`Could not remove ${file.get_path()}: ${e.message}`);
    }
}
