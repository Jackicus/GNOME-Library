// Tabs over one grid per section, each built the first time its tab is chosen.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {createMediaView} from './mediaGrid.js';
import {createEmptyState, createHeader} from './widgets.js';

// .ml-header's height plus its margin-bottom in stylesheet.css, logical px.
export const HEADER_ALLOWANCE = 76;

export class LibraryView {
    // width and height are the whole view, header included, in physical px.
    constructor({sections, itemsFor, active, width, height, columns, rows, onActivate, onSwitch, onBack, end, onOpenSettings}) {
        this._sections = sections;
        this._itemsFor = itemsFor;
        this._width = width;
        this._height = height;
        this._columns = columns;
        this._rows = rows;
        this._onActivate = onActivate;
        this._onSwitch = onSwitch;
        this._onOpenSettings = onOpenSettings;
        this._pages = new Map();
        this._prebuildIdle = 0;
        this._key = this._sectionFor(active)?.key ?? null;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        this.header = createHeader({
            sections,
            active: this._key,
            onSwitch: key => {
                this.show(key);
                this._onSwitch?.(key);
            },
            onBack,
            end,
        });
        this.actor.add_child(this.header.actor);

        // Unclipped: the grid overhangs it so hovered edge tiles are not cut off.
        this.stack = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.actor.add_child(this.stack);

        this.actor.connect('key-press-event', (_actor, event) => this._onKeyPress(event));
        this.actor.connect('destroy', () => {
            if (this._prebuildIdle)
                GLib.source_remove(this._prebuildIdle);
            this._prebuildIdle = 0;
            this._pages.clear();
        });
    }

    destroy() {
        this.actor.destroy();
    }

    get key() {
        return this._key;
    }

    get currentView() {
        return this._pages.get(this._key)?.view ?? null;
    }

    show(key, {reveal = false} = {}) {
        this._key = this._sectionFor(key)?.key ?? this._key;
        if (!this._key)
            return;
        this.header.setActive(this._key);
        const page = this._page(this._key);
        for (const other of this._pages.values())
            other.actor.visible = other === page;
        if (reveal)
            page.view?.reveal();
    }

    // A grid is a couple of hundred actors: the rest are built ahead, one to an idle.
    prebuild() {
        if (this._prebuildIdle)
            return;
        this._prebuildIdle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            const next = this._sections.find(s => !this._pages.has(s.key));
            if (next)
                this._page(next.key).actor.hide();
            if (this._sections.some(s => !this._pages.has(s.key)))
                return GLib.SOURCE_CONTINUE;
            this._prebuildIdle = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    focusFirst() {
        const view = this.currentView;
        if (view)
            return view.focusFirst();
        return this._pages.get(this._key)?.actor
            .navigate_focus(null, St.DirectionType.TAB_FORWARD, false) ?? false;
    }

    _sectionFor(key) {
        return this._sections.find(s => s.key === key) ?? this._sections[0] ?? null;
    }

    _page(key) {
        let page = this._pages.get(key);
        if (page)
            return page;
        const section = this._sections.find(s => s.key === key);
        const items = this._itemsFor(key);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        let view = null;
        let actor;
        if (items.length) {
            actor = view = createMediaView({
                section,
                items,
                width: this._width,
                height: this._height - HEADER_ALLOWANCE * scale,
                columns: this._columns,
                rows: this._rows,
                onActivate: this._onActivate,
            });
        } else {
            actor = createEmptyState({
                icon: section.icon,
                title: `No ${section.title.toLowerCase()} yet`,
                hint: section.emptyHint,
                actionLabel: this._onOpenSettings ? 'Open Settings' : null,
                onAction: this._onOpenSettings,
            });
        }
        this.stack.add_child(actor);
        page = {actor, view};
        this._pages.set(key, page);
        return page;
    }

    // St walks within one focus group, so the step between the tabs and the grid is ours.
    _onKeyPress(event) {
        const view = this.currentView;
        if (!view?.visible)
            return Clutter.EVENT_PROPAGATE;
        const focus = global.stage.get_key_focus();
        const symbol = event.get_key_symbol();
        if (symbol === Clutter.KEY_Up && view.atTopRow(focus))
            return this.header.focusTabs() ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        if (symbol === Clutter.KEY_Down && focus && this.header.actor.contains(focus))
            return view.focusFirst() ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE;
        return Clutter.EVENT_PROPAGATE;
    }
}
