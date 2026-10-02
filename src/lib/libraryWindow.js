// The "modal" library: the tabs and grids in the folder's panel, out of the button.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {LibraryView} from './libraryView.js';
import {MediaPanel} from './panel.js';

const LibraryPanel = GObject.registerClass(
class LibraryWindowPanel extends MediaPanel {
    constructor({sections, itemsFor, columns, rows, onActivate, onSwitch, onOpenSettings}) {
        // Gone when the button unmaps, as a folder is: that closes it with the overview.
        super({dieWithSource: true});

        this._sections = sections;
        this._itemsFor = itemsFor;
        this._columns = columns;
        this._rows = rows;
        this._onActivate = onActivate;
        this._onSwitch = onSwitch;
        this._onOpenSettings = onOpenSettings;
        this._library = null;
        // Not _budget, which is the host's method.
        this._room = null;
    }

    _sizePanel(budget) {
        this._panel.remove_all_transitions();
        // Overrides the 720px square the theme pins .app-folder-dialog to.
        this._panel.set_size(budget.width, budget.height);
        this._restSize = [budget.width, budget.height];

        // Built for one box: another rebuilds the view rather than stretching it.
        if (this._room && (this._room.width !== budget.width || this._room.height !== budget.height)) {
            this._library?.destroy();
            this._library = null;
        }
        this._room = budget;
    }

    // After popup(), so the panel is on stage and its padding can be measured.
    showSection(key) {
        if (!this._library) {
            const [width, height] = this._viewSize();
            this._library = new LibraryView({
                sections: this._sections,
                itemsFor: this._itemsFor,
                active: key,
                width,
                height,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onSwitch: this._onSwitch,
                onOpenSettings: this._onOpenSettings,
            });
            this._panel.add_child(this._library.actor);
        }
        this._library.show(key);
        this._library.currentView?.goToPage(0, false);
    }

    get currentView() {
        return this._library?.currentView ?? null;
    }

    _focusFirst() {
        return this._library?.focusFirst() ?? false;
    }

    _viewSize() {
        const node = this._panel.get_theme_node();
        const width = Math.round(this._room.width -
            node.get_padding(St.Side.LEFT) - node.get_padding(St.Side.RIGHT));
        const height = Math.round(this._room.height -
            node.get_padding(St.Side.TOP) - node.get_padding(St.Side.BOTTOM));
        return [width, height];
    }
});

export class LibraryWindow {
    constructor({sections, itemsFor, onActivate, columns, rows, button, onSwitch, onOpenSettings}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._onActivate = onActivate;
        this._columns = columns;
        this._rows = rows;
        this._button = button;
        this._onSwitch = onSwitch;
        this._onOpenSettings = onOpenSettings;
        this._panel = null;
        this._key = sections[0]?.key ?? null;
    }

    enable() {
    }

    disable() {
        this.close();
        this._panel?.destroy();
        this._panel = null;
    }

    toggle(key = null) {
        if (this._panel?.isOpen) {
            this.close();
            return;
        }
        this.open(key);
    }

    open(key = null) {
        if (!this._sections.length)
            return;
        if (this._sections.some(s => s.key === key))
            this._key = key;

        if (!this._panel) {
            this._panel = new LibraryPanel({
                sections: this._sections,
                itemsFor: this._itemsFor,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onSwitch: tab => {
                    this._key = tab;
                    this._onSwitch(tab);
                },
                onOpenSettings: this._onOpenSettings,
            });
            this._panel.connect('open-state-changed', (_panel, isOpen) => {
                if (!isOpen)
                    this._button.sync(false);
            });
        }

        if (!this._panel.isOpen) {
            // A shortcut on the desktop finds the icon unmapped: the panel fades in centred.
            this._panel.popup(this._button.icon);
            if (!this._panel.isOpen)
                return;
        }

        this._panel.showSection(this._key);
        this._button.sync(true);
    }

    close() {
        this._panel?.popdown();
    }

    get isShowing() {
        return !!this._panel?.isOpen;
    }

    get currentView() {
        return this._panel?.isOpen ? this._panel.currentView : null;
    }

    get state() {
        return {key: this._panel?.isOpen ? this._key : null};
    }

    restore(state) {
        if (state?.key)
            this.open(state.key);
    }
}
