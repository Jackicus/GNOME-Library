// One item up close: artwork and primary action on the left, title, facts,
// synopsis and the group list (seasons, files) on the right.

import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {Duration, Ease, slideSwap, staggerIn} from './anim.js';
import {fillOnScroll} from './lazyList.js';
import {artworkStyle, createArtwork, createActionButton, createLabel, createPill, createRow} from './widgets.js';
import {PANE_INSET, radiusStyle} from './shape.js';
import {Tracker} from './tracking.js';
import {adjustAnimationTime, ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';

// Logical pixels; the stylesheet's .ml-pane-content padding must agree. The
// bare frame plus the panel's PANE_INSET comes to the same 32.
const PADDING = {pane: 28, bare: 32 - PANE_INSET};

const HERO_MAX_HEIGHT = 560;
const HERO_RESERVED = 2 * 52 + 28;         // two action buttons and the gaps
const HERO_MAX_WIDTH_FRACTION = 0.34;      // of the pane width
const HERO_MIN = 132;
// One line of the summary's 0.95em type; St has no line-height to set.
const SUMMARY_LINE = 21;
const SUMMARY_LINES = 5;
const FIRST_ROWS = 24;
const ROWS_PER_BATCH = 16;

export class DetailView {
    // `frame` 'bare' draws no surface of its own, inside the pop-up's panel.
    constructor({onOpen, tracker, frame = 'pane'}) {
        this._onOpen = onOpen;
        this._tracker = tracker;
        this._section = null;
        this._frame = frame;
        this._groups = [];
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        this._watchRows = new Map();
        this._play = null;
        this._playPath = null;
        this._playable = new Set();
        this._tabButtons = [];
        this._width = 0;
        this._height = 0;
        this._deferredList = 0;
        this._deferredMain = 0;
        this._columns = null;
        this._main = null;
        this._buildPendingMain = null;
        this.hero = null;
        this.side = null;
        this.item = null;

        this.actor = new St.BoxLayout({
            orientation: Clutter.Orientation.VERTICAL,
            x_expand: true,
            y_expand: true,
        });
        tracker.connectObject('changed', (_tracker, path, watched) => {
            this._watchRows.get(path)?.setWatched(watched);
            if (this._play && this._playable.has(path))
                this._syncPlay();
        }, this.actor);
    }

    destroy() {
        this.cancelDeferred();
        this.actor.destroy();
    }

    setSize(width, height) {
        this._width = width;
        this._height = height;
    }

    cancelDeferred() {
        if (this._deferredList) {
            GLib.source_remove(this._deferredList);
            this._deferredList = 0;
        }
        if (this._deferredMain) {
            GLib.source_remove(this._deferredMain);
            this._deferredMain = 0;
        }
    }

    get padding() {
        return PADDING[this._frame] * this._scale;
    }

    get _scale() {
        return St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    get _paneRadius() {
        return this._frame === 'bare' ? 'paneInner' : 'pane';
    }

    _heroSize(aspect) {
        const scale = this._scale;
        const room = this._height - 2 * this.padding - HERO_RESERVED * scale;
        const byHeight = Math.min(HERO_MAX_HEIGHT * scale, room);
        const byWidth = Math.round(this._width * HERO_MAX_WIDTH_FRACTION * aspect);
        const height = Math.max(HERO_MIN * scale, Math.min(byHeight, byWidth));
        return {width: Math.round(height / aspect), height};
    }

    // Continue from where the tracker says this was left, else play what the scan chose.
    _syncPlay() {
        const item = this.item;
        this._playPath = item.playPath;
        this._playable = new Set();
        let label = item.playLabel;
        if (this._tracker.enabled && Tracker.tracks(this._section)) {
            const groups = this._groups;
            const inRun = groups.filter(g => g.season).flatMap(g => g.entries);
            const order = inRun.length ? inRun.map(e => e.path) : [item.playPath];
            const others = inRun.length
                ? groups.filter(g => !g.season).flatMap(g => g.entries).map(e => e.path)
                : [];
            this._playable = new Set([...order, ...others]);
            const path = this._tracker.continueFrom(order, others);
            if (path && (path !== item.playPath || this._tracker.positionOf(path))) {
                const code = groups.flatMap(g => g.entries).find(e => e.path === path)?.code;
                this._playPath = path;
                label = code ? `Continue ${code}` : 'Continue';
            }
        }
        this._play.setLabel(label);
    }

    _open(path) {
        this._onOpen(path, this._section);
    }

    // `mainColumn` 'held': the caller reveals the second column itself.
    populate(item, section, {mainColumn = 'auto'} = {}) {
        this.cancelDeferred();
        this.actor.destroy_all_children();
        this.item = item;
        this._section = section;
        this._groups = item.groups;
        this._groupIndex = 0;
        this._list = null;
        this._listHost = null;
        this._watchRows = new Map();
        this._play = null;
        this._playPath = null;
        this._playable = new Set();
        this._main = null;
        this._tabButtons = [];

        const radius = this._paneRadius;
        const pane = new St.Widget({
            style_class: this._frame === 'bare' ? 'ml-pane ml-pane-bare' : 'ml-pane',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
            style: radiusStyle(radius),
        });
        this.actor.add_child(pane);

        if (item.backdrop) {
            const backdrop = new St.Widget({style_class: 'ml-backdrop', x_expand: true, y_expand: true});
            backdrop.set_style(artworkStyle(item.backdrop, radius));
            pane.add_child(backdrop);
            pane.add_child(new St.Widget({
                style_class: 'ml-backdrop-veil',
                x_expand: true,
                y_expand: true,
                style: radiusStyle(radius),
            }));
        }

        const columns = new St.BoxLayout({style_class: 'ml-pane-content', x_expand: true, y_expand: true});
        pane.add_child(columns);
        this._columns = columns;
        this.side = this._buildSide(item, section);
        columns.add_child(this.side);

        // The second column waits for an idle, off the frames of the opening move.
        this._buildPendingMain = () => this._buildMain(item);
        this._deferredMain = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._deferredMain = 0;
            this._addMain();
            if (mainColumn === 'auto')
                this.revealMain({settle: Duration.SLOW});
            return GLib.SOURCE_REMOVE;
        });
    }

    _addMain() {
        if (!this._buildPendingMain)
            return;
        const build = this._buildPendingMain;
        this._buildPendingMain = null;
        if (this._deferredMain) {
            GLib.source_remove(this._deferredMain);
            this._deferredMain = 0;
        }
        this._main = build();
        this._main.opacity = 0;
        this._columns.add_child(this._main);
    }

    revealMain({delay = 0, settle = Duration.NORMAL} = {}) {
        this._addMain();
        this._main?.ease({opacity: 255, delay, duration: Duration.NORMAL, mode: Ease.OUT});
        this._fillList(delay + settle);
    }

    // A timer, not an idle: an idle can fall mid-animation, and the first rows
    // are the one build here that would be felt.
    _fillList(after) {
        if (this._deferredList || this._list || !this._listHost)
            return;
        this._deferredList = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            adjustAnimationTime(after), () => {
                this._deferredList = 0;
                this._showGroup(this._groupIndex, {animate: false});
                return GLib.SOURCE_REMOVE;
            });
    }

    hideMain() {
        this._main?.ease({opacity: 0, duration: Duration.FAST, mode: Ease.OUT});
    }

    _buildSide(item, section) {
        // Clutter would otherwise inherit x_expand from the buttons inside.
        const side = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, style_class: 'ml-detail-side', x_expand: false, y_expand: true});

        const {width: heroW, height: heroH} = this._heroSize(section.aspect);
        this.hero = createArtwork({
            path: item.art,
            title: item.title,
            icon: section.icon,
            width: heroW,
            height: heroH,
            styleClass: 'ml-art ml-hero',
            radius: 'hero',
        });
        side.add_child(this.hero);

        if (item.playPath) {
            const play = createActionButton({
                label: item.playLabel,
                icon: 'media-playback-start-symbolic',
            });
            play.set_x_expand(true);
            play.connect('clicked', () => this._open(this._playPath ?? item.playPath));
            side.add_child(play);
            this._play = play;
            this._syncPlay();
        }

        if (item.folder && item.playPath !== item.folder) {
            const folder = createActionButton({
                label: 'Show in Files',
                icon: 'folder-symbolic',
                styleClass: 'button ml-action-secondary',
            });
            folder.set_x_expand(true);
            folder.connect('clicked', () => this._open(item.folder));
            side.add_child(folder);
        }

        return side;
    }

    _buildMain(item) {
        const main = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_expand: true, style_class: 'ml-detail-main'});

        main.add_child(createLabel(item.title, 'ml-detail-title'));
        if (item.tagline)
            main.add_child(createLabel(item.tagline, 'ml-tagline'));

        const facts = new St.BoxLayout({style_class: 'ml-facts', y_align: Clutter.ActorAlign.CENTER});
        if (item.year)
            facts.add_child(createPill(String(item.year), 'ml-fact'));
        if (item.rating)
            facts.add_child(createPill(`★ ${item.rating}`, 'ml-fact ml-fact-rating'));
        if (item.countLabel)
            facts.add_child(createPill(item.countLabel, 'ml-fact'));
        if (item.groupLabel)
            facts.add_child(createPill(item.groupLabel, 'ml-fact'));
        for (const tag of item.tags)
            facts.add_child(createPill(tag, 'ml-fact ml-fact-tag'));
        if (facts.get_n_children())
            main.add_child(facts);

        if (item.summary) {
            const summary = new St.Label({text: item.summary, style_class: 'ml-summary', x_expand: true});
            summary.clutter_text.line_wrap = true;
            summary.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
            summary.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            summary.height = SUMMARY_LINE * this._scale * SUMMARY_LINES;
            summary.y_expand = false;
            main.add_child(summary);
        }

        if (this._groups.length > 1 || this._groups[0]?.season)
            main.add_child(this._buildTabs());
        else if (this._groups.length === 1)
            main.add_child(new St.Label({text: this._groups[0].name, style_class: 'ml-group-heading'}));

        this._listHost = new St.Widget({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
            clip_to_allocation: true,
        });
        main.add_child(this._listHost);
        return main;
    }

    _buildTabs() {
        const tabs = new St.BoxLayout({style_class: 'ml-tabs', x_expand: true});
        this._groups.forEach((group, i) => {
            const tab = new St.Button({
                style_class: 'button ml-tab',
                label: group.name,
                toggle_mode: true,
                can_focus: true,
                track_hover: true,
            });
            tab.connect('clicked', () => {
                if (!tab.checked) {
                    tab.checked = true;
                    return;
                }
                this._showGroup(i, {animate: true});
            });
            this._tabButtons.push(tab);
            tabs.add_child(tab);
        });
        return tabs;
    }

    _showGroup(index, {animate}) {
        const previous = this._groupIndex;
        this._groupIndex = index;
        this._tabButtons.forEach((tab, i) => (tab.checked = i === index));

        const group = this._groups[index];
        const old = this._list;
        const list = group?.entries.length
            ? this._buildList(group)
            : new St.Label({text: 'Nothing here yet.', style_class: 'ml-empty-hint', x_expand: true});
        this._list = list;
        this._listHost.add_child(list);

        if (!animate) {
            old?.destroy();
            return;
        }
        slideSwap(old, list, index >= previous ? 1 : -1, {distance: 24, onComplete: () => old?.destroy()});
    }

    _buildList(group) {
        const scroll = new St.ScrollView({x_expand: true, y_expand: true, overlay_scrollbars: true, style_class: 'vfade ml-list-scroll'});
        scroll.set_policy(St.PolicyType.NEVER, St.PolicyType.AUTOMATIC);
        const box = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, style_class: 'ml-list'});
        scroll.set_child(box);

        const entries = group.entries;
        const tracker = this._tracker.enabled && Tracker.tracks(this._section) ? this._tracker : null;
        const watchRows = this._watchRows = new Map();
        let next = 0;
        let first = true;
        fillOnScroll(scroll, () => {
            const limit = Math.min(entries.length, next + (first ? FIRST_ROWS : ROWS_PER_BATCH));
            const batch = [];
            for (; next < limit; next++) {
                const entry = entries[next];
                const row = createRow({
                    index: entry.index,
                    title: entry.title,
                    subtitle: entry.subtitle,
                    badges: entry.badges,
                    size: entry.size,
                    onActivate: () => this._open(entry.path),
                    watched: tracker && entry.path ? tracker.isWatched(entry.path) : null,
                    onWatched: watched => tracker.setWatched(entry.path, watched),
                });
                if (tracker && entry.path)
                    watchRows.set(entry.path, row);
                // Tab past the fold must scroll, or the list is never topped up.
                row.connect('key-focus-in', () => ensureActorVisibleInScrollView(scroll, row));
                batch.push(row);
                box.add_child(row);
            }
            if (first)
                staggerIn(batch, {step: 12, cap: 160, fromY: 8});
            first = false;
            return next < entries.length;
        });
        return scroll;
    }
}
