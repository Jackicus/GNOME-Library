// The "modal" library: the tabs and grids in the folder's panel, out of the button.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {LibraryView} from './libraryView.js';
import {MediaPanel} from './panel.js';

export const LibraryWindow = GObject.registerClass(
class LibraryWindow extends MediaPanel {
    constructor({sections, itemsFor, columns, rows, onActivate, button, onSwitch, onEmpty}) {
        // Gone when the button unmaps, as a folder is: that closes it with the overview.
        super({dieWithSource: true});
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._columns = columns;
        this._rows = rows;
        this._onActivate = onActivate;
        this._button = button;
        this._onSwitch = onSwitch;
        this._onEmpty = onEmpty;
        this._key = sections[0].key;
        this._library = null;
        // Not _budget, which is the host's method.
        this._room = null;
        this.connect('open-state-changed', (_panel, isOpen) => {
            if (!isOpen)
                this._button.sync(false);
        });
    }

    enable() {
    }

    disable() {
        this.popdown();
        this.destroy();
    }

    toggle(key = null) {
        if (this.isOpen)
            this.popdown();
        else
            this.open(key);
    }

    open(key = null) {
        if (this._sections.some(s => s.key === key))
            this._key = key;
        if (!this.isOpen) {
            // A shortcut on the desktop finds the icon unmapped: the panel fades in centred.
            this.popup(this._button.icon);
            if (!this.isOpen)
                return;
        }
        this._showSection(this._key);
        this._button.sync(true);
    }

    close() {
        this.popdown();
    }

    get isShowing() {
        return this.isOpen;
    }

    get currentView() {
        return this.isOpen ? this._library?.currentView ?? null : null;
    }

    get state() {
        return {key: this.isOpen ? this._key : null};
    }

    restore(state) {
        if (state?.key)
            this.open(state.key);
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
    _showSection(key) {
        if (!this._library) {
            const node = this._panel.get_theme_node();
            this._library = new LibraryView({
                sections: this._sections,
                itemsFor: this._itemsFor,
                active: key,
                width: Math.round(this._room.width -
                    node.get_padding(St.Side.LEFT) - node.get_padding(St.Side.RIGHT)),
                height: Math.round(this._room.height -
                    node.get_padding(St.Side.TOP) - node.get_padding(St.Side.BOTTOM)),
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
                onSwitch: tab => {
                    this._key = tab;
                    this._onSwitch(tab);
                },
                onEmpty: this._onEmpty,
            });
            this._panel.add_child(this._library.actor);
        }
        this._library.show(key);
        this._library.currentView?.goToPage(0, false);
    }

    _focusFirst() {
        return this._library?.focusFirst() ?? false;
    }
});
