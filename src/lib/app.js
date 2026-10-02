// The library's button, the surface on the wallpaper, and the places the library
// and a picked item open in: .claude/rules/places.md.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Util from 'resource:///org/gnome/shell/misc/util.js';
import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import {WINDOW_ANIMATION_TIME} from 'resource:///org/gnome/shell/ui/workspaceAnimation.js';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import {Duration, Ease, POP_SCALE, allocateNow, fadeTo, flyClone, rectIn} from './anim.js';
import {SECTIONS, loadLibrary, libraryPath, openCommandKey, sectionByKey} from './library.js';
import {createHeader, createIconButton} from './widgets.js';
import {setCornerRadius} from './shape.js';
import {setGridAlign} from './mediaGrid.js';
import {HEADER_ALLOWANCE, LibraryView} from './libraryView.js';
import {LibraryButton} from './libraryButton.js';
import {DetailView} from './detailView.js';
import {OverviewPreview, installSlideHook, removeSlideHook} from './overviewPreview.js';
import {MediaMenu} from './mediaMenu.js';
import {LibraryWindow} from './libraryWindow.js';
import {DetailDialog} from './detailDialog.js';
import {Tracker} from './tracking.js';
import {PlaybackWatcher} from './playback.js';
import {Controls, NAVIGATION_KEYS, handleBoundKey} from './controls.js';
import {note} from './log.js';

// Gap between the surface and the work-area edges, in logical px.
const OUTER_MARGIN = 28;
const LIBRARY = 'library';
const DETAIL = 'detail';

// With the section's command, or the default app when its program is not installed.
// An array is a game's own command line, run as it is.
function openPath(path, command = '', beforeLaunch = null) {
    if (!path)
        return;
    if (Array.isArray(path)) {
        beforeLaunch?.();
        Util.spawn(path);
        return;
    }
    const file = Gio.File.new_for_path(path);
    // Asynchronous: a share that has idled out would stall the compositor.
    file.query_info_async(
        'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
        (_file, result) => {
            let isDir = false;
            let found = false;
            try {
                isDir = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
                found = true;
            } catch {
                // Not there: let the launch below say so.
            }
            if (found && !isDir)
                beforeLaunch?.();
            if (command && !isDir) {
                let argv;
                try {
                    [, argv] = GLib.shell_parse_argv(command);
                } catch (e) {
                    Main.notifyError(`Could not open ${file.get_basename()}`, e.message);
                    return;
                }
                if (GLib.find_program_in_path(argv[0])) {
                    Util.spawn([...argv, path]);
                    return;
                }
            }
            Gio.AppInfo.launch_default_for_uri_async(file.get_uri(),
                global.create_app_launch_context(0, -1), null, (_source, res) => {
                    try {
                        Gio.AppInfo.launch_default_for_uri_finish(res);
                    } catch (e) {
                        Main.notifyError(`Could not open ${file.get_basename()}`, e.message);
                    }
                });
        });
}

// index() on a removed workspace is a libmutter CRITICAL, so compare objects.
function workspaceIsLive(workspace) {
    if (!workspace)
        return false;
    const wm = global.workspace_manager;
    for (let i = 0; i < wm.n_workspaces; i++) {
        if (wm.get_workspace_by_index(i) === workspace)
            return true;
    }
    return false;
}

// A teardown step that reaches private shell API or another extension's object:
// if it throws, the rest of the teardown still runs.
function settle(what, step) {
    try {
        step();
    } catch (e) {
        console.error(`[Library] Could not release the ${what}: ${e}`);
    }
}

export class LibraryApp {
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._container = null;
        this._stack = null;
        this._overlay = null;
        this._library = null;
        this._detailPage = null;
        this._detail = null;
        this._dialog = null;
        this._sections = {};
        this._sectionKey = null;
        this._mode = 'library';
        this._shown = null;
        this._busy = false;
        this._reloadWanted = false;
        this._leaving = new Map();
        this._heroFrom = null;
        this._monitor = null;
        this._previews = null;
        this._button = new LibraryButton({
            path: extension.path,
            onActivate: () => this._toggleLibrary(),
        });
        this._browser = null;
        this._picked = null;
        this._origin = null;
        this._builtBounds = null;
        this._rebuildTimer = 0;
        this._closeTimer = 0;
        this._scanCancel = null;
        this._keptAlive = [];
        this._libraryWorkspace = null;
        this._detailWorkspace = null;
        this._tracker = new Tracker(this._settings);
        this._playback = new PlaybackWatcher(this._settings, this._tracker);
        this._controls = new Controls(this._settings, {
            isActive: () => this._controlsActive(),
            onHome: () => this._closeLibrary(),
            onOpen: () => this._controlsOpen(),
            currentView: () => this._browser?.currentView ??
                (this._mode === 'library' ? this._library?.currentView : null),
        });
    }

    // The shell never calls disable() after enable() throws, so undo it here.
    enable() {
        try {
            this._enable();
        } catch (e) {
            this.disable();
            throw e;
        }
    }

    _enable() {
        this._controls.enable();
        this._tracker.enable();
        this._playback.enable();
        this._sections = loadLibrary();
        // Once per enable, not per build: docs/private-api.md.
        installSlideHook();
        this._build();

        global.workspace_manager.connectObject(
            'active-workspace-changed', () => this._onWorkspaceChanged(),
            'workspace-removed', () => this._onWorkspaceRemoved(),
            this);
        // Docks register their struts after login, changing the work area under us.
        Main.layoutManager.connectObject(
            'monitors-changed', () => this._onGeometryChanged(),
            'startup-complete', () => this._onGeometryChanged(),
            this);
        global.display.connectObject('workareas-changed',
            () => this._onGeometryChanged(), this);
        St.ThemeContext.get_for_stage(global.stage).connectObject('notify::scale-factor',
            () => this._scheduleRebuild(), this);
        // Clutter drops key focus to the stage as what had it is hidden or destroyed.
        global.stage.connectObject('notify::key-focus',
            () => this._onStageFocusChanged(), this);
        Main.overview.connectObject('hidden',
            () => this._syncKeyFocus(this._onTarget()), this);

        const rebuildKeys = ['columns', 'rows', 'grid-align', 'corner-radius', 'detail-size',
            ...SECTIONS.map(s => `${s.prefix}-enabled`)];
        for (const key of rebuildKeys)
            this._settings.connectObject(`changed::${key}`, () => this._scheduleRebuild(), this);
        // A claimed workspace or a pick means something else in another place.
        for (const key of ['library-opens-in', 'detail-opens-in']) {
            this._settings.connectObject(`changed::${key}`, () => {
                this._libraryWorkspace = this._detailWorkspace = null;
                this._picked = this._origin = null;
                this._scheduleRebuild();
            }, this);
        }

        // POPUP mode only so the shortcut can close the modal library's panel.
        Main.wm.addKeybinding('library-shortcut', this._settings,
            Meta.KeyBindingFlags.NONE,
            Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
            () => this._onShortcut());

        const file = Gio.File.new_for_path(libraryPath());
        this._monitor = file.monitor_file(Gio.FileMonitorFlags.NONE, null);
        this._monitor.connect('changed', (_m, _f, _o, event) => {
            if (event === Gio.FileMonitorEvent.CHANGES_DONE_HINT ||
                event === Gio.FileMonitorEvent.CREATED ||
                event === Gio.FileMonitorEvent.RENAMED ||
                event === Gio.FileMonitorEvent.MOVED_IN)
                this._scheduleRebuild({reload: true, delay: 400});
        });

        this._syncVisibility(false);
    }

    disable() {
        Main.wm.removeKeybinding('library-shortcut');
        global.workspace_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.stage.disconnectObject(this);
        St.ThemeContext.get_for_stage(global.stage).disconnectObject(this);
        this._settings.disconnectObject(this);
        if (this._monitor) {
            this._monitor.cancel();
            this._monitor = null;
        }
        for (const id of [this._rebuildTimer, this._closeTimer]) {
            if (id)
                GLib.source_remove(id);
        }
        this._rebuildTimer = this._closeTimer = 0;
        this._scanCancel?.cancel();
        this._scanCancel = null;
        this._leaving.clear();
        this._teardown();
        settle('slide hook', () => removeSlideHook());
        settle('button', () => this._button.detach());
        this._libraryWorkspace = this._detailWorkspace = null;
        this._picked = this._origin = null;
        settle('held workspaces', () => this._keepOnly(new Set()));
        this._sections = {};
        // Playback saves its position before the tracker stops.
        this._playback.disable();
        this._tracker.disable();
        this._controls.disable();
    }

    _teardown() {
        this._previews?.destroy();
        this._previews = null;
        settle('library view', () => this._browser?.disable());
        this._browser = null;
        this._library = null;
        this._detailPage = null;
        this._detail?.destroy();
        this._dialog?.popdown();
        this._dialog?.destroy();
        const container = this._container;
        const stack = this._stack;
        this._detail = this._dialog = null;
        this._container = this._stack = this._overlay = null;
        if (stack)
            global.focus_manager.remove_group(stack);
        container?.destroy();
        this._busy = false;
        this._mode = 'library';
        this._shown = null;
    }

    // 'workareas-changed' comes with every workspace added or removed: rebuild only
    // when the box drawn in has moved.
    _onGeometryChanged() {
        const now = this._bounds();
        const was = this._builtBounds;
        if (!was || ['x', 'y', 'width', 'height'].some(k => now[k] !== was[k]))
            this._scheduleRebuild();
    }

    // Settings, geometry and a rescan's writes come in bursts: one rebuild per burst.
    _scheduleRebuild({reload = false, delay = 150} = {}) {
        this._reloadWanted ||= reload;
        if (this._rebuildTimer)
            GLib.source_remove(this._rebuildTimer);
        this._rebuildTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._rebuildTimer = 0;
            if (this._reloadWanted) {
                this._sections = loadLibrary();
                this._tracker.sync();
            }
            this._reloadWanted = false;
            const browsing = this._browser?.state ?? null;
            this._teardown();
            this._build();
            this._syncVisibility(false);
            this._browser?.restore(browsing);
            note('Rebuilt');
            return GLib.SOURCE_REMOVE;
        });
    }

    _enabledSections() {
        return SECTIONS.filter(s => this._settings.get_boolean(`${s.prefix}-enabled`));
    }

    _libraryMode() {
        return this._settings.get_string('library-opens-in');
    }

    _detailMode() {
        return this._settings.get_string('detail-opens-in');
    }

    _libraryOnSurface() {
        const mode = this._libraryMode();
        return mode === 'desktop' || mode === 'workspaces';
    }

    _detailOnSurface() {
        const mode = this._detailMode();
        return mode === 'desktop' || mode === 'workspaces';
    }

    // Grid and pane on one workspace: a pick flies the artwork into the grid's place.
    _detailInPlace() {
        return this._libraryOnSurface() && this._detailMode() === 'desktop';
    }

    _libraryClaimsWorkspace() {
        return this._libraryMode() === 'workspaces';
    }

    _detailClaimsWorkspace() {
        return this._detailMode() === 'workspaces';
    }

    _placeForWorkspace(workspace) {
        if (!workspace)
            return null;
        if (this._detailClaimsWorkspace() && this._picked &&
            workspace === this._detailWorkspace)
            return DETAIL;
        if (!this._libraryOnSurface()) {
            return this._detailOnSurface() && this._picked && workspace === this._origin
                ? DETAIL : null;
        }
        return workspace === this._libraryWorkspace ? LIBRARY : null;
    }

    _holdWorkspaces() {
        if (!workspaceIsLive(this._libraryWorkspace))
            this._libraryWorkspace = null;
        if (!workspaceIsLive(this._detailWorkspace))
            this._detailWorkspace = null;
        if (!workspaceIsLive(this._origin))
            this._origin = null;
        if (this._picked && !this._enabledSections().some(s => s.key === this._picked.key))
            this._picked = null;

        const wanted = new Set(this._leaving.keys());
        for (const workspace of [this._libraryWorkspace, this._detailWorkspace]) {
            if (workspace)
                wanted.add(workspace);
        }
        const away = (this._libraryClaimsWorkspace() && this._libraryWorkspace) ||
            this._detailWorkspace || (!this._libraryOnSurface() && this._picked);
        if (away && this._origin)
            wanted.add(this._origin);
        this._keepOnly(wanted);
    }

    // Held with the shell's own _keepAliveId: docs/private-api.md.
    _keepOnly(wanted) {
        let released = false;
        this._keptAlive = this._keptAlive.filter(ws => {
            if (wanted.has(ws))
                return true;
            if (ws._keepAliveId) {
                GLib.source_remove(ws._keepAliveId);
                ws._keepAliveId = 0;
            }
            released = true;
            return false;
        });
        for (const ws of wanted) {
            // Set by someone else: the shell's own, mid drag-and-drop.
            if (!ws || ws._keepAliveId)
                continue;
            ws._keepAliveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLib.MAXUINT32, () => GLib.SOURCE_CONTINUE);
            GLib.Source.set_name_by_id(ws._keepAliveId, '[library] keep workspace');
            this._keptAlive.push(ws);
        }
        if (released)
            Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
    }

    // Dynamic workspaces always end in an empty one; holding it makes the shell add the next.
    _claimWorkspace() {
        const wm = global.workspace_manager;
        const taken = new Set([this._libraryWorkspace, this._detailWorkspace]);
        const free = ws => ws && !taken.has(ws) && !ws._keepAliveId &&
            !ws.list_windows().some(w => !w.is_on_all_workspaces());
        if (Meta.prefs_get_dynamic_workspaces()) {
            const last = wm.get_workspace_by_index(wm.n_workspaces - 1);
            return free(last) ? last : wm.append_new_workspace(false, global.get_current_time());
        }
        for (let i = wm.n_workspaces - 1; i >= 0; i--) {
            const ws = wm.get_workspace_by_index(i);
            if (free(ws))
                return ws;
        }
        return null;
    }

    _takeWorkspace(what) {
        const workspace = this._claimWorkspace();
        if (!workspace) {
            console.warn(`[Library] No free workspace to open ${what} on ` +
                '(Settings → Multitasking, or open it on the desktop instead).');
            return null;
        }
        this._keepOnly(new Set([...this._keptAlive, workspace]));
        Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
        return workspace;
    }

    // Given up once the slide away from them is over: it still draws them.
    _releaseWorkspaces(given) {
        for (const [workspace, place] of given)
            this._leaving.set(workspace, place);
        if (this._closeTimer)
            GLib.source_remove(this._closeTimer);
        this._closeTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            adjustAnimationTime(WINDOW_ANIMATION_TIME) + 50, () => {
                this._closeTimer = 0;
                this._leaving.clear();
                this._holdWorkspaces();
                this._previews?.invalidate();
                return GLib.SOURCE_REMOVE;
            });
    }

    _landing(given) {
        const wm = global.workspace_manager;
        const first = Math.min(...given.map(ws => ws.index()));
        for (let i = first - 1; i >= 0; i--) {
            const ws = wm.get_workspace_by_index(i);
            if (!given.includes(ws))
                return ws;
        }
        for (let i = 0; i < wm.n_workspaces; i++) {
            const ws = wm.get_workspace_by_index(i);
            if (!given.includes(ws))
                return ws;
        }
        return null;
    }

    _toggleLibrary() {
        if (this._browser) {
            this._browser.toggle(this._sectionKey);
            return;
        }
        if (!this._libraryOnSurface() || this._busy)
            return;
        const overview = Main.overview.visible;
        const here = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        if (here && !overview) {
            this._closeLibrary();
            return;
        }
        Main.overview.hide();
        this._openLibrary({reveal: !overview});
    }

    _openLibrary({reveal = true} = {}) {
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace();
        if (!this._libraryClaimsWorkspace()) {
            if (this._libraryWorkspace !== active || this._shown !== LIBRARY) {
                this._libraryWorkspace = active;
                this._holdWorkspaces();
                this._showLibraryNow({reveal});
            }
            this._syncVisibility(true);
            this._previews?.invalidate();
            return;
        }
        let workspace = this._libraryWorkspace;
        if (!workspaceIsLive(workspace)) {
            workspace = this._takeWorkspace('the library');
            if (!workspace)
                return;
            this._libraryWorkspace = workspace;
        }
        if (workspace === active) {
            if (this._shown !== LIBRARY)
                this._showLibraryNow({reveal});
            this._syncVisibility(true);
            return;
        }
        this._origin = active;
        this._holdWorkspaces();
        workspace.activate(global.get_current_time());
    }

    _closeLibrary() {
        if (this._busy)
            return;
        this._dismiss();
        const wm = global.workspace_manager;
        const active = wm.get_active_workspace();
        const given = new Map();
        if (this._libraryClaimsWorkspace() && workspaceIsLive(this._libraryWorkspace))
            given.set(this._libraryWorkspace, LIBRARY);
        if (workspaceIsLive(this._detailWorkspace))
            given.set(this._detailWorkspace, DETAIL);
        const home = this._libraryOnSurface() && !this._libraryClaimsWorkspace()
            ? this._libraryWorkspace : this._origin;

        this._picked = null;
        this._libraryWorkspace = this._detailWorkspace = null;
        this._shown = null;

        if (given.has(active)) {
            const claimed = [...given.keys()];
            const to = workspaceIsLive(home) && !given.has(home) ? home : this._landing(claimed);
            to?.activate(global.get_current_time());
        }
        this._syncVisibility(true);
        if (given.size)
            this._releaseWorkspaces(given);
        this._holdWorkspaces();
        this._previews?.invalidate();
    }

    _onShortcut() {
        // Under a popup, only the modal library's own panel is closed by the shortcut.
        if (Main.actionMode === Shell.ActionMode.POPUP &&
            !(this._browser instanceof LibraryWindow && this._browser.isShowing))
            return;
        this._toggleLibrary();
    }

    _controlsActive() {
        if (this._dialog?.isOpen || this._browser?.isShowing)
            return true;
        return !!this._container?.visible && this._onTarget() && !Main.overview.visible &&
            !global.display.focus_window && Main.modalCount === 0;
    }

    // Never over a window, where Home would be a game's Start button too.
    _controlsOpen() {
        if (global.display.focus_window || Main.modalCount > 0)
            return;
        if (this._browser) {
            this._browser.open(this._sectionKey);
            return;
        }
        if (this._libraryOnSurface())
            this._openLibrary();
    }

    _dismiss() {
        this._dialog?.popdown();
        this._browser?.close();
    }

    _openSettings() {
        this._dismiss();
        this._extension.openPreferences();
    }

    // The video sections need a folder first; games are found with none.
    _onEmpty(section, button) {
        if (!section.launchers) {
            this._openSettings();
            return;
        }
        // Put back by the rebuild the scan's write brings, or a failure's.
        button.setLabel('Looking…');
        button.reactive = false;
        this._scan(section.key);
    }

    // In a process of its own, as the preferences' Rescan runs it (backend/CLAUDE.md).
    _scan(key) {
        if (this._scanCancel)
            return;
        const cancel = new Gio.Cancellable();
        this._scanCancel = cancel;
        const scanner = GLib.build_filenamev([this._extension.path, 'backend', 'scanLibrary.js']);
        let proc;
        try {
            proc = Gio.Subprocess.new(['gjs', '-m', scanner, '--only', key],
                Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            this._scanCancel = null;
            this._scanFailed(e.message);
            return;
        }
        proc.communicate_utf8_async(null, cancel, (_proc, result) => {
            if (cancel.is_cancelled())
                return;
            this._scanCancel = null;
            try {
                const [, , stderr] = proc.communicate_utf8_finish(result);
                if (!proc.get_successful())
                    this._scanFailed(stderr);
            } catch (e) {
                this._scanFailed(e.message);
            }
        });
    }

    _scanFailed(why) {
        console.error(`[Library] Scan failed: ${why}`);
        this._scheduleRebuild();
    }

    _onWorkspaceRemoved() {
        this._holdWorkspaces();
        this._previews?.invalidate();
        this._onWorkspaceChanged();
    }

    _onWorkspaceChanged() {
        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        // Against _shown, not the place: a rebuild empties the stack.
        if (place && place !== this._shown) {
            if (place === DETAIL)
                this._showDetailNow();
            else
                this._showLibraryNow();
        }
        this._syncVisibility(true);
    }

    _openPicked(key, item, tile) {
        if (this._dialog) {
            if (this._detailMode() === 'modal')
                this._browser.close();
            this._dialog.popup(tile, item, sectionByKey(key));
            return;
        }
        this._browser.close();
        const active = global.workspace_manager.get_active_workspace();
        if (this._placeForWorkspace(active) === null)
            this._origin = active;
        this._showDetail(key, item);
    }

    _showDetail(key, item) {
        this._picked = {key, item};
        if (!this._detailClaimsWorkspace()) {
            this._holdWorkspaces();
            this._showDetailNow({reveal: true});
            this._syncVisibility(true);
            this._previews?.invalidate();
            return;
        }
        let workspace = this._detailWorkspace;
        if (!workspaceIsLive(workspace)) {
            workspace = this._takeWorkspace('a picked item');
            if (!workspace) {
                this._detailWorkspace = null;
                this._showDetailNow({reveal: true});
                this._syncVisibility(true);
                return;
            }
            this._detailWorkspace = workspace;
        }
        this._holdWorkspaces();
        this._showDetailNow();
        workspace.activate(global.get_current_time());
        this._syncVisibility(true);
    }

    _resetViews() {
        if (!this._container)
            return;
        this._overlay.destroy_all_children();
        this._detail?.actor.remove_all_transitions();
        this._detail?.actor.hide();
        const grid = this._library?.currentView;
        if (grid) {
            grid.remove_all_transitions();
            grid.set_scale(1, 1);
            grid.opacity = 255;
            grid.show();
        }
        this._library?.header.setLibraryMode(false);
        this._busy = false;
    }

    _showLibraryNow({reveal = false} = {}) {
        if (!this._container || !this._library)
            return;
        this._resetViews();
        this._mode = 'library';
        this._detailPage?.actor.hide();
        this._library.actor.show();
        this._library.show(this._sectionKey, {reveal});
        this._shown = LIBRARY;
    }

    _showDetailNow({reveal = false} = {}) {
        if (!this._container || !this._picked)
            return;
        this._resetViews();
        this._mode = 'detail';
        const {key, item} = this._picked;
        const section = sectionByKey(key);
        const page = this._detailPageFor(section);
        this._library?.actor.hide();
        page.actor.show();
        this._attachDetail(page.stack);
        this._detail.populate(item, section);
        const actor = this._detail.actor;
        actor.remove_all_transitions();
        actor.opacity = 255;
        actor.translation_y = 0;
        actor.show();
        if (reveal) {
            actor.opacity = 0;
            actor.translation_y = 24;
            actor.ease({
                opacity: 255,
                translation_y: 0,
                duration: Duration.SLOW,
                mode: Ease.OUT_EXPO,
            });
        }
        this._shown = DETAIL;
    }

    _attachDetail(stack) {
        const actor = this._detail?.actor;
        if (!actor || actor.get_parent() === stack)
            return;
        actor.get_parent()?.remove_child(actor);
        stack.add_child(actor);
    }

    _open(path, section) {
        const key = section ? openCommandKey(section) : null;
        openPath(path, key ? this._settings.get_string(key) : '', () => {
            if (Tracker.tracks(section))
                this._playback.resumeNext(path);
            // A pop-up's grab would hold a game's window off.
            if (Array.isArray(path)) {
                this._dismiss();
                Main.overview.hide();
            }
            this._toPlayingWorkspace();
        });
    }

    // A new window opens on the active workspace, so the player's lands on this one.
    _toPlayingWorkspace() {
        if (!this._settings.get_boolean('play-on-new-workspace'))
            return;
        const workspace = this._claimWorkspace();
        if (!workspace) {
            console.warn('[Library] No empty workspace to play on (Settings → Multitasking).');
            return;
        }
        this._dismiss();
        Main.overview.hide();
        workspace.activate(global.get_current_time());
    }

    _build() {
        // Before anything is built: every rounded surface reads it as it is made.
        setCornerRadius(this._settings.get_int('corner-radius'));
        setGridAlign(this._settings.get_string('grid-align'));

        const bounds = this._builtBounds = this._bounds();

        const sections = this._enabledSections();
        this._holdWorkspaces();
        if (!sections.length) {
            this._button.detach();
            this._libraryWorkspace = this._detailWorkspace = null;
            this._picked = null;
            this._holdWorkspaces();
            return;
        }
        if (!sections.some(s => s.key === this._sectionKey))
            this._sectionKey = (sections.find(s => this._sections[s.key]?.length) ?? sections[0]).key;
        this._button.attach();

        if (!this._detailOnSurface()) {
            this._dialog = new DetailDialog({
                onOpen: (path, section) => this._open(path, section),
                tracker: this._tracker,
                size: this._settings.get_int('detail-size') / 100,
                mode: this._detailMode(),
            });
        }

        if (!this._libraryOnSurface()) {
            const Browser = this._libraryMode() === 'modal' ? LibraryWindow : MediaMenu;
            this._browser = new Browser({
                sections,
                itemsFor: key => this._sections[key] ?? [],
                onActivate: (key, item, tile) => this._openPicked(key, item, tile),
                columns: this._settings.get_int('columns'),
                rows: this._settings.get_int('rows'),
                button: this._button,
                onSwitch: key => (this._sectionKey = key),
                onEmpty: (section, button) => this._onEmpty(section, button),
            });
            this._browser.enable();
        }

        if (!this._libraryOnSurface() && !this._detailOnSurface())
            return;

        this._container = new St.Widget({
            name: 'LibraryContainer',
            layout_manager: new Clutter.BinLayout(),
            reactive: true,
            can_focus: true,
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height,
        });

        this._container.connect('key-press-event', (_actor, event) => this._onKeyPress(event));

        this._stack = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._container.add_child(this._stack);

        global.focus_manager.add_group(this._stack);

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        if (this._detailOnSurface()) {
            this._detail = new DetailView({
                onOpen: (path, section) => this._open(path, section),
                tracker: this._tracker,
            });
            this._detail.setSize(bounds.width, bounds.height - HEADER_ALLOWANCE * scale);
            this._detail.actor.hide();
        }

        const onSurface = this._libraryOnSurface();
        if (onSurface)
            this._buildLibrary(bounds, sections);

        this._overlay = new Clutter.Actor({x_expand: true, y_expand: true});
        this._container.add_child(this._overlay);

        Main.layoutManager._backgroundGroup.add_child(this._container);

        const place = this._placeForWorkspace(global.workspace_manager.get_active_workspace());
        if (place === DETAIL || (!place && !onSurface && this._picked))
            this._showDetailNow({reveal: !!place});
        else if (onSurface)
            this._showLibraryNow({reveal: !!place});

        this._previews = new OverviewPreview({
            // A workspace on its way out is no longer ours, but the slide still draws it.
            placeForWorkspace: workspace => workspace
                ? this._leaving.get(workspace) ?? this._placeForWorkspace(workspace) : null,
            sourceFor: where => where === DETAIL ? this._detailPage?.actor : this._library?.actor,
            bounds,
        });
        this._previews.enable();

        if (onSurface)
            this._library.prebuild();
    }

    _buildLibrary(bounds, sections) {
        const {width, height} = bounds;
        const settings = createIconButton('preferences-system-symbolic', {accessibleName: 'Settings'});
        settings.connect('clicked', () => this._openSettings());
        const close = createIconButton('window-close-symbolic', {accessibleName: 'Close'});
        close.connect('clicked', () => this._closeLibrary());
        this._library = new LibraryView({
            sections,
            itemsFor: key => this._sections[key] ?? [],
            active: this._sectionKey,
            width,
            height,
            columns: this._settings.get_int('columns'),
            rows: this._settings.get_int('rows'),
            onActivate: (key, item, tile) => this._openItem(key, item, tile),
            onSwitch: key => (this._sectionKey = key),
            onBack: () => this._goBack(),
            end: [settings, close],
            onEmpty: (section, button) => this._onEmpty(section, button),
        });
        // Sized outright: the overview's clones lay a hidden source out at its own size.
        this._library.actor.set_size(width, height);
        this._library.actor.hide();
        this._stack.add_child(this._library.actor);
    }

    _detailPageFor(section) {
        if (!this._detailPage) {
            const {width, height} = this._builtBounds;
            const actor = new St.BoxLayout({
                orientation: Clutter.Orientation.VERTICAL,
                width, height, visible: false,
            });
            const header = createHeader({sections: [], onBack: () => this._goBack()});
            actor.add_child(header.actor);
            const stack = new St.Widget({
                layout_manager: new Clutter.BinLayout(),
                x_expand: true, y_expand: true,
            });
            actor.add_child(stack);
            this._stack.add_child(actor);
            this._detailPage = {actor, header, stack};
        }
        this._detailPage.header.setDetailMode(section.title);
        return this._detailPage;
    }


    _bounds() {
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const margin = OUTER_MARGIN * scale;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return {x: margin, y: margin, width: 1920 - 2 * margin, height: 1080 - 2 * margin};
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        return {
            x: area.x + margin,
            y: area.y + margin,
            width: area.width - 2 * margin,
            height: area.height - 2 * margin,
        };
    }

    async _openItem(key, item, tile) {
        if (this._busy || this._mode !== 'library')
            return;
        const section = sectionByKey(key);
        if (this._dialog) {
            this._dialog.popup(tile, item, section);
            return;
        }
        if (!this._detailInPlace()) {
            this._showDetail(key, item);
            return;
        }
        this._busy = true;
        this._mode = 'detail';

        const library = this._library;
        this._attachDetail(library.stack);
        const art = tile.artwork;
        const from = rectIn(art, this._container);
        this._heroFrom = {item, from};

        this._detail.populate(item, section);
        const detailActor = this._detail.actor;
        detailActor.opacity = 0;
        detailActor.translation_y = 0;
        detailActor.show();
        allocateNow(detailActor);
        const hero = this._detail.hero;
        hero.opacity = 0;
        const to = rectIn(hero, this._container);

        library.header.setDetailMode(section.title, true);

        const grid = library.currentView;
        grid.set_pivot_point(0.5, 0.5);
        grid.ease({
            opacity: 0,
            scale_x: POP_SCALE,
            scale_y: POP_SCALE,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => {
                grid.hide();
                grid.set_scale(1, 1);
                grid.opacity = 255;
            },
        });

        detailActor.translation_y = 24;
        detailActor.ease({
            opacity: 255,
            translation_y: 0,
            duration: Duration.SLOW,
            mode: Ease.OUT_EXPO,
        });

        art.opacity = 0;
        await flyClone(this._overlay, art, from, to);
        hero.opacity = 255;
        art.opacity = 255;
        this._busy = false;
    }

    async _goBack() {
        if (!this._detailInPlace()) {
            if (this._busy)
                return;
            const wm = global.workspace_manager;
            const key = this._picked?.key ?? this._sectionKey;
            const detailWorkspace = workspaceIsLive(this._detailWorkspace) ? this._detailWorkspace : null;
            this._picked = null;
            this._detailWorkspace = null;
            this._sectionKey = key;

            let to = this._libraryOnSurface() ? this._libraryWorkspace : this._origin;
            if (!workspaceIsLive(to) || to === detailWorkspace)
                to = workspaceIsLive(this._origin) && this._origin !== detailWorkspace ? this._origin : null;
            if (!to && detailWorkspace)
                to = this._landing([detailWorkspace]);
            to ??= wm.get_active_workspace();

            if (!this._libraryOnSurface()) {
                this._browser?.open(key);
            } else if (this._libraryClaimsWorkspace() && !workspaceIsLive(this._libraryWorkspace)) {
                to.activate(global.get_current_time());
                this._openLibrary();
                if (detailWorkspace)
                    this._releaseWorkspaces(new Map([[detailWorkspace, DETAIL]]));
                return;
            } else {
                this._libraryWorkspace = to;
                this._showLibraryNow({reveal: to === wm.get_active_workspace()});
            }
            to.activate(global.get_current_time());
            this._syncVisibility(true);
            if (detailWorkspace)
                this._releaseWorkspaces(new Map([[detailWorkspace, DETAIL]]));
            else
                this._previews?.invalidate();
            this._holdWorkspaces();
            return;
        }
        if (this._busy || this._mode !== 'detail')
            return;
        this._busy = true;
        this._mode = 'library';

        const detailActor = this._detail.actor;
        const hero = this._detail.hero;
        const library = this._library;
        const grid = library.currentView;
        const remembered = this._heroFrom;
        const tile = remembered ? grid.tileFor(remembered.item.id) : null;

        library.header.setLibraryMode(true);

        grid.set_pivot_point(0.5, 0.5);
        grid.set_scale(POP_SCALE, POP_SCALE);
        grid.opacity = 0;
        grid.show();
        grid.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            duration: Duration.SLOW,
            mode: Ease.OUT_EXPO,
        });

        detailActor.ease({
            opacity: 0,
            translation_y: 24,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => {
                detailActor.hide();
                detailActor.translation_y = 0;
            },
        });

        if (tile && hero) {
            const from = rectIn(hero, this._container);
            hero.opacity = 0;
            tile.artwork.opacity = 0;
            await flyClone(this._overlay, hero, from, remembered.from);
            tile.artwork.opacity = 255;
        }
        this._busy = false;
    }

    _onKeyPress(event) {
        if (handleBoundKey(event))
            return Clutter.EVENT_STOP;
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Escape) {
            if (this._mode === 'detail')
                this._goBack();
            else
                this._closeLibrary();
            return Clutter.EVENT_STOP;
        }
        if (NAVIGATION_KEYS.includes(symbol) &&
            global.stage.get_key_focus() === this._container) {
            if (this._mode === 'detail'
                ? this._detail?.actor.navigate_focus(null, St.DirectionType.TAB_FORWARD, false)
                : this._library?.focusFirst())
                return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onTarget() {
        return this._placeForWorkspace(global.workspace_manager.get_active_workspace()) !== null;
    }

    // Not under a grab: a popup's, or another extension's panel over the surface.
    _onStageFocusChanged() {
        if (!this._container)
            return;
        if (Main.overview.visible || Main.modalCount > 0 || global.stage.get_key_focus())
            return;
        this._syncKeyFocus(this._onTarget());
    }

    _syncKeyFocus(onTarget) {
        if (!this._container)
            return;
        const focus = global.stage.get_key_focus();
        const ours = focus && this._container.contains(focus);
        if (onTarget && !ours && Main.modalCount === 0)
            global.stage.set_key_focus(this._container);
        else if (!onTarget && ours)
            global.stage.set_key_focus(null);
    }

    _syncVisibility(animate) {
        const onTarget = this._onTarget();
        if (this._libraryOnSurface())
            this._button.sync(onTarget);
        if (!this._container)
            return;
        this._syncKeyFocus(onTarget);
        if (!animate) {
            this._container.visible = onTarget;
            this._container.opacity = onTarget ? 255 : 0;
            return;
        }
        if (this._container.visible === onTarget && this._container.opacity === (onTarget ? 255 : 0))
            return;
        fadeTo(this._container, onTarget ? 255 : 0, {duration: Duration.NORMAL});
    }
}
