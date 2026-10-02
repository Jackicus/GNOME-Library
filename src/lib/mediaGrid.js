// The shell's own app grid, holding posters instead of apps. A library runs to
// thousands, so only the pages in reach of the one showing are built.

import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as AppDisplay from 'resource:///org/gnome/shell/ui/appDisplay.js';
import * as IconGrid from 'resource:///org/gnome/shell/ui/iconGrid.js';

import {staggerIn} from './anim.js';
import {handleBoundKey} from './controls.js';
import {createArtwork} from './widgets.js';

// Not exported by the shell, but it is what AppDisplay extends.
const BaseAppView = Object.getPrototypeOf(AppDisplay.AppDisplay);

// Logical pixels, as the theme writes them.
const MIN_ART = 96;
// .icon-grid's column-spacing and row-spacing in the shell theme.
const GAP = 12;
// An overview-tile's padding, and its label beneath the artwork.
const TILE_PADDING = 24;
const TILE_CHROME = 56;
// Room for a hovered title in the bottom row to wrap to a second line.
const TITLE_LINE = 20;
const PAGE_PADDING_V = 48;
const PAGE_PADDING_H = 36;
// The shell's PAGE_PREVIEW_RATIO each side, for the page arrows.
const ARROWS_SHARE = 0.2;
const DOTS_HEIGHT = 36;
const PAGES_AHEAD = 2;

let gridAlign = 'center';
export function setGridAlign(align) {
    gridAlign = align === 'start' ? 'start' : 'center';
}

// Decided before any item is added: the layout does not page items again
// when the mode changes.
function gridFor(width, height, aspect, wantColumns, wantRows) {
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    const gap = GAP * scale;
    const pad = TILE_PADDING * scale;
    const chrome = TILE_CHROME * scale;
    const minArt = MIN_ART * scale;

    const gridW = width * (1 - ARROWS_SHARE) - PAGE_PADDING_H * scale;
    const gridH = height - (DOTS_HEIGHT + PAGE_PADDING_V + TITLE_LINE) * scale;

    const fitColumns = Math.floor((gridW + gap) / (minArt / aspect + pad + gap));
    const columns = Math.max(1, Math.min(wantColumns, fitColumns));
    const cellW = Math.floor((gridW - gap * (columns - 1)) / columns);
    const byWidth = Math.floor((cellW - pad) * aspect);

    const forRows = n => Math.floor((gridH + gap) / n - chrome - gap);
    const fitRows = Math.floor((gridH + gap) / (minArt + chrome + gap));
    const rows = Math.max(1, Math.min(wantRows, fitRows));

    const iconSize = Math.max(minArt, Math.min(byWidth, forRows(rows)));

    return {rows, columns, iconSize};
}

// The shell's layout makes every cell a square; posters are not.
const PosterGridLayout = GObject.registerClass(
class VideoLibraryPosterGridLayout extends IconGrid.IconGridLayout {
    vfunc_allocate() {
        if (!this._pageWidth || !this._pageHeight)
            return;

        // Every tile is the same size; this runs on each frame the overview moves.
        const first = this._pages[0]?.visibleChildren[0];
        if (!first)
            return;
        const cellW = first.get_preferred_width(-1)[0];
        const cellH = first.get_preferred_height(-1)[0];

        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        // Already scaled by the theme, and 0 until the first style change.
        const hGap = this.columnSpacing || GAP * scale;
        const vGap = this.rowSpacing || GAP * scale;

        const rtl = Clutter.get_default_text_direction() === Clutter.TextDirection.RTL;
        const {columnsPerPage: columns, rowsPerPage: rows, pagePadding: pad} = this;
        const blockW = columns * cellW + (columns - 1) * hGap;
        const blockH = rows * cellH + (rows - 1) * vGap;
        const centred = gridAlign === 'center';
        const left = pad.left + Math.max(0, (this._pageWidth - pad.left - pad.right - blockW) / 2);
        const top = pad.top +
            Math.max(0, (this._pageHeight - pad.top - pad.bottom - TITLE_LINE * scale - blockH) / 2);

        const box = new Clutter.ActorBox();
        this._pages.forEach((page, pageIndex) => {
            if (rtl)
                pageIndex = this._pages.length - 1 - pageIndex;
            page.visibleChildren.forEach((item, index) => {
                const column = rtl ? columns - 1 - index % columns : index % columns;
                const row = Math.floor(index / columns);
                const inRow = Math.min(columns, page.visibleChildren.length - row * columns);
                const rowOffset = centred
                    ? (rtl ? -1 : 1) * (columns - inRow) * (cellW + hGap) / 2
                    : 0;
                box.set_origin(
                    Math.floor(pageIndex * this._pageWidth + left + rowOffset +
                        column * (cellW + hGap)),
                    Math.floor(top + row * (cellH + vGap)));
                // A hovered tile wraps its title, so the cell is a floor.
                box.set_size(cellW, Math.max(cellH, item.get_preferred_height(cellW)[1]));
                item.allocate(box);
            });
        });

        this._pageSizeChanged = false;
        this._shouldEaseItems = false;
    }
});

const MediaGrid = GObject.registerClass(
class VideoLibraryMediaGrid extends AppDisplay.AppGrid {
    constructor({rows, columns, iconSize}) {
        super({
            allow_incomplete_pages: true,
            rows_per_page: rows,
            columns_per_page: columns,
        });
        this.setGridModes([{rows, columns}]);

        // The layout IconGrid made stays alive in its constructor's closure.
        const layout = new PosterGridLayout({
            allow_incomplete_pages: true,
            orientation: Clutter.Orientation.HORIZONTAL,
            rows_per_page: rows,
            columns_per_page: columns,
            fixed_icon_size: iconSize,
        });
        layout.connect('pages-changed', () => this.emit('pages-changed'));
        this.layout_manager = layout;
    }
});

// A BaseIcon asks for a square; this one asks for its child's shape.
const PosterIcon = GObject.registerClass(
class VideoLibraryPosterIcon extends IconGrid.BaseIcon {
    vfunc_get_preferred_width(forHeight) {
        const node = this.get_theme_node();
        const [min, nat] = this.child.get_preferred_width(node.adjust_for_height(forHeight));
        return node.adjust_preferred_width(min, nat);
    }

    vfunc_get_preferred_height(forWidth) {
        const node = this.get_theme_node();
        const [min, nat] = this.child.get_preferred_height(node.adjust_for_width(forWidth));
        return node.adjust_preferred_height(min, nat);
    }
});

const MediaItem = GObject.registerClass(
class VideoLibraryMediaItem extends AppDisplay.AppViewItem {
    _init({item, section, order, onActivate}) {
        super._init({style_class: 'overview-tile'}, false, true);
        this._id = `${section.key}/${item.id}`;
        this._name = item.title;
        this.item = item;
        this.order = order;

        this.icon = new PosterIcon(item.title, {
            setSizeManually: true,
            createIcon: size => createArtwork({
                path: item.art,
                title: item.title,
                icon: section.icon,
                width: Math.round(size / section.aspect),
                height: size,
            }),
        });
        this.set_child(this.icon);
        this.connect('clicked', () => onActivate(section.key, item, this));
    }

    get artwork() {
        return this.icon.icon;
    }
});

// _createGrid() runs in the parent's _init, before `this` can hold parameters.
let pendingGrid = null;

const MediaView = GObject.registerClass(
class VideoLibraryMediaView extends BaseAppView {
    constructor({section, items, onActivate}) {
        super({
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this.add_child(this._box);

        // Pinning an app or a parental filter change would redisplay every tile.
        this._parentalControlsManager.disconnectObject(this);
        this._appFavorites.disconnectObject(this);

        global.focus_manager.add_group(this);
        this.connect('destroy', () => global.focus_manager.remove_group(this));

        this.connect('key-press-event', (_view, event) => handleBoundKey(event)
            ? Clutter.EVENT_STOP : Clutter.EVENT_PROPAGATE);

        // The dots keep their room on a one-page section (.claude/rules/layout.md).
        const dots = this._pageIndicators;
        const holdRoom = () => {
            if (!dots.visible) {
                dots.visible = true;
                dots.opacity = 0;
            } else if (dots.get_n_children() > 1) {
                dots.opacity = 255;
            }
        };
        dots.connect('notify::visible', holdRoom);
        // Connected after the shell's own handler, which sets the page count.
        this._grid.connect('pages-changed', holdRoom);
        holdRoom();

        this._section = section;
        this._data = items;
        this._onActivate = onActivate;
        this._columns = pendingGrid.columns;
        this._perPage = pendingGrid.rows * this._columns;
        this._media = [];
        this._byId = new Map();
        this._fillTo(0);
    }

    // Straight into the grid: _redisplay's diff takes seconds on a big library.
    _fillTo(page) {
        const want = Math.min(this._data.length, (page + 1 + PAGES_AHEAD) * this._perPage);
        while (this._media.length < want) {
            const order = this._media.length;
            const item = new MediaItem({
                item: this._data[order],
                section: this._section,
                order,
                onActivate: this._onActivate,
            });
            this._media.push(item);
            this._byId.set(this._data[order].id, item);
            // Placed outright: appended, the grid keeps new apps off the first page.
            this._addItem(item, Math.floor(order / this._perPage), order % this._perPage);
        }
    }

    // The parent's _init calls this before _data is set. As the view is destroyed, its
    // tiles going change the page count after the scroll view has let go of the
    // grid's adjustment, which the shell's IconGrid.goToPage would ease in a later.
    goToPage(page, animate = true) {
        if (!this._grid.hadjustment)
            return;
        if (this._data)
            this._fillTo(page);
        super.goToPage(page, animate);
    }

    tileFor(itemId) {
        return this._byId.get(itemId) ?? null;
    }

    reveal() {
        const start = this._shownPage() * this._perPage;
        staggerIn(this._media.slice(start, start + this._perPage));
    }

    focusFirst() {
        const item = this._media[this._shownPage() * this._perPage] ?? this._media[0];
        item?.grab_key_focus();
        return !!item;
    }

    atTopRow(actor) {
        const order = this._media.indexOf(actor);
        return order >= 0 && order % this._perPage < this._columns;
    }

    // The adjustment's answer, not the grid's, which the last batch of tiles moved.
    _shownPage() {
        const {value, page_size: pageSize} = this._adjustment;
        return pageSize > 0 ? Math.round(value / pageSize) : 0;
    }

    // The shell's grid turns no page for a key; the focus goes along with it.
    pageBy(delta) {
        const page = this._shownPage() + delta;
        if (page < 0 || page * this._perPage >= this._data.length)
            return false;
        this.goToPage(page);
        this._media[page * this._perPage]?.grab_key_focus();
        return true;
    }

    _createGrid() {
        return new MediaGrid(pendingGrid);
    }

    _loadApps() {
        return [...this._media];
    }

    _compareItems(a, b) {
        return a.order - b.order;
    }
});

export function createMediaView({section, items, width, height, columns, rows, onActivate}) {
    pendingGrid = gridFor(width, height, section.aspect, columns, rows);
    const view = new MediaView({section, items, onActivate});
    // Each batch of tiles moves the grid to the page it made.
    view.goToPage(0, false);
    return view;
}
