// The "menu" library: the library view in the overview's app-grid slot
// (.claude/rules/places.md has how it behaves).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {ControlsState} from 'resource:///org/gnome/shell/ui/overviewControls.js';

import {Duration, Ease} from './anim.js';
import {LibraryView} from './libraryView.js';

// DASH_MAX_HEIGHT_RATIO and VERTICAL_SPACING_RATIO, which overviewControls.js
// does not export.
const DASH_MAX_SHARE = 0.16;
const VERTICAL_SPACING_SHARE = 0.02;

export class MediaMenu {
    constructor({sections, itemsFor, onActivate, columns, rows, button, onSwitch, onOpenSettings}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._columns = columns;
        this._rows = rows;
        this._button = button;
        this._onSwitch = onSwitch;
        this._onOpenSettings = onOpenSettings;
        this._library = null;
        this._showing = false;
        this._key = sections[0]?.key ?? null;
        this._slot = null;
        this._box = null;
        this._fold = 0;
        this._forced = false;
        this._escapeId = 0;
        // The tab to reopen onto when another extension's view held the slot.
        this._next = null;
        this._reopenId = 0;
    }

    enable() {
        this._controls = Main.overview._overview?.controls ?? null;
        this._appDisplay = this._controls?.appDisplay ?? null;
        this._appsBox = this._appDisplay?._box ?? null;
        if (!this._appDisplay || !this._appsBox || !this._sections.length) {
            if (this._sections.length)
                console.warn('[Library] The overview is not laid out as expected; no media menu.');
            this._appsBox = null;
            return;
        }

        // Leaving an overview our button opened takes it all the way down, but
        // not mid-swipe or for a search, which uncheck Show Apps too.
        this._showAppsButton = Main.overview.dash.showAppsButton;
        this._showAppsButton.connectObject('notify::checked', button => {
            if (button.checked)
                return;
            const leaving = this._showing && this._forced &&
                Main.overview.visible && !Main.overview.animationInProgress &&
                !this._adjustment?.gestureInProgress &&
                !this._controls._searchController?.searchActive;
            this._show(false);
            if (leaving)
                Main.overview.hide();
        }, this);

        this._controls._searchController?.connectObject('notify::search-active', controller => {
            if (!controller.searchActive && this._showing)
                this._syncWorkspaces(true);
        }, this);

        this._adjustment = this._controls._stateAdjustment ?? null;
        this._adjustment?.connectObject('notify::value', () => this._syncWorkspaces(), this);

        // Reopened off an idle, once the shell's own hide has finished.
        Main.overview.connectObject('hidden', () => {
            this._unforce();
            const next = this._next;
            this._next = null;
            if (next && !this._reopenId) {
                this._reopenId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                    this._reopenId = 0;
                    this.open(next);
                    return GLib.SOURCE_REMOVE;
                });
            }
        }, this);

        this._foldWorkspaces();
    }

    disable() {
        if (!this._appsBox)
            return;
        this._show(false);
        // Put back only while it is still ours; left in a chain, ours does nothing.
        const layout = this._controls.layout_manager;
        if (this._foldedBox && layout._getAppDisplayBoxForState === this._foldedBox) {
            if (this._stockBox)
                layout._getAppDisplayBoxForState = this._stockBox;
            else
                delete layout._getAppDisplayBoxForState;
        }
        this._foldedBox = this._stockBox = null;
        this._controls.queue_relayout();
        this._showAppsButton?.disconnectObject(this);
        this._showAppsButton = null;
        Main.overview.disconnectObject(this);
        this._unforce();
        if (this._reopenId)
            GLib.source_remove(this._reopenId);
        this._reopenId = 0;
        this._next = null;
        this._controls._searchController?.disconnectObject(this);
        this._adjustment?.disconnectObject(this);
        this._adjustment = null;
        this._dropView();
        this._slot = null;
        this._controls = this._appDisplay = this._appsBox = null;
    }

    // While the view is up the grid's box grows over the workspaces row; the
    // row keeps its own box, because the shell divides by its height.
    _foldWorkspaces() {
        const layout = this._controls.layout_manager;
        const stock = layout._getAppDisplayBoxForState;
        if (typeof stock !== 'function')
            return;
        const menu = this;
        this._stockBox = Object.hasOwn(layout, '_getAppDisplayBoxForState') ? stock : null;
        const folded = function (state, box, searchHeight, dashHeight, workspacesBox, spacing) {
            const slot = stock.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
            if (menu._foldedBox !== folded)
                return slot;
            // Measured by the prototype's method: `stock` may be Games
            // Library's wrap, which has already grown the slot.
            const own = Object.getPrototypeOf(this)._getAppDisplayBoxForState;
            const shell = own && own !== stock
                ? own.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing) : slot;
            menu._slot = [shell.get_width(), shell.get_height() + workspacesBox.get_height() + spacing];
            if (!menu._showing)
                return slot;
            const extra = workspacesBox.get_height() + spacing;
            const [x, y] = slot.get_origin();
            const [width, height] = slot.get_size();
            slot.set_origin(x, state === ControlsState.APP_GRID ? y - extra : y);
            slot.set_size(width, height + extra);
            return slot;
        };
        this._foldedBox = layout._getAppDisplayBoxForState = folded;
    }

    // The fold follows the overview's state adjustment; only a change of view
    // with the overview standing still is eased.
    _syncWorkspaces(animate = false) {
        // An ease of ours can outlast the menu.
        const workspaces = this._controls?._workspacesDisplay;
        if (!workspaces || this._controls._searchController?.searchActive)
            return;
        const state = this._adjustment?.value ?? ControlsState.WINDOW_PICKER;
        const fold = this._showing
            ? Math.clamp(state - ControlsState.WINDOW_PICKER, 0, 1) : 0;
        if (!fold && !this._fold)
            return;
        const opacity = Math.round(255 * (1 - fold));

        // A transparent workspace over the grown slot would still take clicks.
        if (fold < 1) {
            workspaces.reactive = true;
            workspaces.setPrimaryWorkspaceVisible?.(true);
        }
        workspaces.remove_transition('opacity');
        if (animate && workspaces.mapped && workspaces.opacity !== opacity) {
            workspaces.ease({
                opacity,
                duration: Duration.NORMAL,
                mode: Ease.OUT,
                onComplete: () => this._syncWorkspaces(),
            });
            return;
        }
        this._fold = fold;
        workspaces.opacity = opacity;
        if (fold === 1) {
            workspaces.reactive = false;
            workspaces.setPrimaryWorkspaceVisible?.(false);
        }
    }

    toggle(key = null) {
        if (this.isShowing) {
            if (this._forced)
                Main.overview.hide();
            else
                this._showAppsButton.checked = false;
            return;
        }
        this.open(key);
    }

    close() {
        Main.overview.hide();
    }

    get isShowing() {
        return Main.overview.visible && !!this._showAppsButton?.checked && this._showing;
    }

    get currentView() {
        return this.isShowing ? this._library?.currentView ?? null : null;
    }

    get state() {
        return {key: this._showing ? this._key : null, forced: this._forced};
    }

    restore(state) {
        if (!state?.key || !this._appsBox || !Main.overview.visible)
            return;
        if (state.forced)
            this._force();
        this.open(state.key);
    }

    open(key = null) {
        this._next = null;
        if (!this._appsBox)
            return;
        if (this._sections.some(s => s.key === key))
            this._key = key;
        // Another extension's view in the slot: hide, and reopen onto ours.
        if (Main.overview.visible && this._showAppsButton.checked &&
            !this._showing && !this._appsBox.visible) {
            this._next = this._key;
            Main.overview.hide();
            return;
        }
        this._show(true);
        if (Main.overview.visible) {
            this._showAppsButton.checked = true;
            return;
        }
        this._force();
        Main.overview.show(ControlsState.APP_GRID);
    }

    // In an overview our button opened, Escape closes it whole; captured ahead
    // of the shell's handler, which would only step down to the window picker.
    _force() {
        this._forced = true;
        if (this._escapeId)
            return;
        this._escapeId = global.stage.connect('captured-event::key', (_stage, event) => {
            if (event.type() !== Clutter.EventType.KEY_PRESS ||
                event.get_key_symbol() !== Clutter.KEY_Escape ||
                !this._showing || !this._showAppsButton?.checked ||
                Main.modalCount > 1 || this._controls?._searchController?.searchActive)
                return Clutter.EVENT_PROPAGATE;
            Main.overview.hide();
            return Clutter.EVENT_STOP;
        });
    }

    _unforce() {
        this._forced = false;
        if (this._escapeId)
            global.stage.disconnect(this._escapeId);
        this._escapeId = 0;
    }

    _show(showing) {
        if (!this._appsBox)
            return;
        if (showing !== this._showing) {
            const library = showing ? this._view() : null;
            if (!showing)
                this._library?.actor.hide();
            this._showing = showing;
            this._appsBox.visible = !showing;
            if (library) {
                library.show(this._key);
                library.actor.show();
                library.currentView?.goToPage(0, false);
            }
            this._syncWorkspaces(true);
            this._controls.queue_relayout();
        } else if (showing) {
            this._library?.show(this._key);
        }
        this._button.sync(this._showing);
    }

    // Before the overview has ever been shown, the slot is worked out as
    // ControlsManagerLayout.vfunc_allocate does (.claude/rules/layout.md).
    _slotSize() {
        if (this._slot)
            return this._slot;
        const monitor = Main.layoutManager.primaryMonitor;
        const {width, height} = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const spacing = Math.round(height * VERTICAL_SPACING_SHARE);
        const maxDash = Math.round(height * DASH_MAX_SHARE);
        const search = Main.overview.searchEntry?.get_parent();
        const searchHeight = search ? search.get_preferred_height(width)[0] : 0;
        const dash = Main.overview.dash;
        dash.setMaxSize(width, maxDash);
        const dashHeight = Math.min(dash.get_preferred_height(width)[1], maxDash);
        return [width, height - searchHeight - dashHeight - 2 * spacing];
    }

    // Rebuilt, every tab at once, when the slot it was built for moves.
    _view() {
        const [width, height] = this._slotSize();
        if (this._box && (this._box[0] !== width || this._box[1] !== height))
            this._dropView();
        this._box = [width, height];
        if (this._library)
            return this._library;

        this._library = new LibraryView({
            sections: this._sections,
            itemsFor: this._itemsFor,
            active: this._key,
            width,
            height,
            columns: this._columns,
            rows: this._rows,
            onActivate: this._onActivate,
            onSwitch: key => {
                this._key = key;
                this._onSwitch(key);
            },
            onOpenSettings: this._onOpenSettings,
        });
        this._library.actor.visible = false;
        this._appDisplay.add_child(this._library.actor);
        return this._library;
    }

    _dropView() {
        this._library?.destroy();
        this._library = null;
        this._box = null;
    }
}
