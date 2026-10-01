# Private and deep GNOME Shell API

Video Library puts its button beside Show Apps, borrows the app grid for its
posters and the folder dialog for its pop-up pane, and makes both the overview
and the workspace slide show its pages where they would otherwise show empty
wallpaper. None of that has a public API of its own. This is everything it
reaches into, for reviewers on extensions.gnome.org and for whoever ports it to
the next GNOME.

Every entry was checked against the GNOME Shell 50.5 JavaScript on the test
machine (extracted to a scratch copy from the installed `libshell`,
`js/ui/{appDisplay,dash,iconGrid,layout,overviewControls,workspace,
workspaceAnimation,workspaceThumbnail,workspacesView,windowManager}.js`).
Several of the entries were also checked against the `48.0` and `49.0` tags of
`GNOME/gnome-shell` on gitlab.gnome.org, and are marked so below; the rest have
only been checked at 50.5, which `compatibility.md` says plainly. Line numbers
are left out on purpose, because `src/` is changing; functions are named
instead.

## At a glance

| Expression | File | If it changes in a future GNOME | Checked in code |
|---|---|---|---|
| `Main.layoutManager._backgroundGroup` | app.js | The surface is not drawn anywhere; the shell's own wallpaper and everything else carries on | Yes, falls back to `global.window_group` |
| `workspace._keepAliveId` (read and set) | app.js | A workspace GNOME's dynamic-workspace code would otherwise collapse is folded away under the library or the pane | No — see "why nothing public" below |
| `Main.wm._workspaceTracker._queueCheckWorkspaces()` | app.js | A workspace just released is not folded away until the shell next does that on its own | Yes, optional-chained; a no-op if missing |
| `Dash.ShowAppsIcon`, its `_createIcon`/`_iconActor` | libraryButton.js | The subclass throws on `_init`; caught, so no button appears | Yes, the whole attach is try/caught |
| `Main.overview.dash._dashContainer`, `dash._hookUpLabel` | libraryButton.js | No button in the dash (the `menu`/`modal` places lose their only way in there) | Yes, checked before use; falls through to Dash to Panel or nothing |
| `global.dashToPanel`, `panels[0]`, `panels-created` | libraryButton.js | No button in Dash to Panel's panel; falls back to the dash, or to nothing if that has none either | Yes, every field checked before use |
| `panel.showAppsIconWrapper.realShowAppsIcon`, `panel.panel`, `panel._updateGroupedElements`, `panel.geom`, `panel.updateElementPositions` | libraryButton.js | Same as above; the whole attach is wrapped in try/catch | Yes |
| `panel._elementGroups`, each group's `.elements` and `.expandableIndex`, an element's `.actor` and `.position` (read inside the `_updateGroupedElements` wrap) | libraryButton.js | `_elementGroups` gone: the button is added to the panel but never given a place in its layout. A group or element of another shape: the wrap throws; the layout `_attachToPanel()` asks for runs inside `_attach()`'s try/catch, so no button and a warning | Partly — `_elementGroups` is `?? []`; the entries' shape is not checked |
| `Main.overview._overview.controls`, `.appDisplay`, `._box` | mediaMenu.js | No media menu; a warning once, if sections are enabled | Yes, logs a warning |
| `Main.overview.dash.showAppsButton` (`.checked`) | mediaMenu.js | The view can no longer tell "is the app grid up" from "is it ours"; see CLAUDE.md's "Traps of its own" | No |
| `controls._searchController`, `.searchActive` | mediaMenu.js | Workspaces do not reappear for a search while the view is up | No, optional-chained |
| `controls._stateAdjustment` | mediaMenu.js | The workspace row is not folded/unfolded in step with the overview's own transition | No, optional-chained |
| `controls._workspacesDisplay` (`.opacity`, `.reactive`, `setPrimaryWorkspaceVisible`) | mediaMenu.js | The slot still grows over the workspace row, but the row is never faded out or made unreactive, so it stays over the top of the posters and takes their clicks | No, optional-chained |
| `controls.layout_manager._getAppDisplayBoxForState` (wrapped) | mediaMenu.js | The slot is never grown, so the view has no room above the workspace row | Yes, guarded and chain-safe (below) |
| `Object.getPrototypeOf(this)._getAppDisplayBoxForState` | mediaMenu.js | The measured slot can be a size another extension's wrap grew for its own view | No — falls back to the (possibly wrong) size the stock call already returned |
| Restated `DASH_MAX_HEIGHT_RATIO` and `VERTICAL_SPACING_RATIO` (as `DASH_MAX_SHARE`, `VERTICAL_SPACING_SHARE`), and `_slotSize()` restating `ControlsManagerLayout.vfunc_allocate` step for step | mediaMenu.js | A view built before the overview has ever laid out its slot is sized for a slot a little off, until it is next opened and built again against the shell's own measurement | No |
| `Object.getPrototypeOf(AppDisplay.AppDisplay)` (`BaseAppView`) | mediaGrid.js | `mediaGrid.js` throws as it loads, and the extension fails to load at all | No — a straight top-level throw |
| `AppDisplay.AppViewItem`, `AppDisplay.AppGrid`, `IconGrid.BaseIcon`, `IconGrid.IconGridLayout` (exported, but their private fields below are not) | mediaGrid.js | Depends on which field; see the grid section | Partial — see below |
| `this._parentalControlsManager`, `this._appFavorites` (disconnected) on `BaseAppView` | mediaGrid.js | `disconnectObject` on `undefined` throws in `MediaView`'s constructor; no grid anywhere | No |
| `this._box`, `this._pageIndicators`, `this._grid` on `BaseAppView` | mediaGrid.js | `MediaView`'s constructor throws (`add_child`, `dots.connect`, `this._grid.connect`); no grid anywhere | No |
| `this._adjustment` on `BaseAppView` | mediaGrid.js | `_shownPage()` throws, and with it the staggered reveal, where the keyboard lands on a page and a remote's page turn; the grid still draws and pages by swipe, wheel and arrows | No |
| `AppViewItem`'s `this._id`/`this._name` (set directly) and its positional `_init(params, isDraggable, expandTitleOnHover)` | mediaGrid.js | Renamed fields: tiles still draw, but the parent's id-keyed bookkeeping no longer tells them apart. A changed signature: the two flags land on the wrong parameters, so a poster becomes draggable or its title stops unfolding on hover | No |
| Restated `PAGE_PREVIEW_RATIO` (as `ARROWS_SHARE`) | mediaGrid.js | Covers are sized for a margin beside the grid that no longer matches where the shell puts its page arrows; cosmetic | No |
| `this._pages`, `_pageWidth`, `_pageHeight`, `_shouldEaseItems`, `_pageSizeChanged` on `IconGrid.IconGridLayout` | mediaGrid.js | `PosterGridLayout.vfunc_allocate` throws or lays every tile at (0,0); no grid draws | No |
| `Main.overview._overview.controls._appDisplay._folderIcons`, `icon._dialog`, `dialog._viewBox` | panel.js `folderLook()` | The pop-up panel always uses the shell's own shade and theme, even where Blur my Shell changes a folder's | Yes, fails soft to `null` |
| `Cogl.Color`, restated `DIALOG_SHADE_NORMAL` | panel.js | Cosmetic only if the shade colour ever changes upstream | No |
| `Main.overview._overview.controls._workspacesDisplay._workspacesViews`, `view._workspaces` | overviewPreview.js | No clones in the overview's workspace previews | Yes, optional-chained to `[]` |
| `workspace._background`, `._backgroundGroup`, `._monitorIndex` | overviewPreview.js | No clone in that preview | Yes, skipped per preview |
| `controls._thumbnailsBox._thumbnails`, `thumbnail._contents` | overviewPreview.js | No clone in the thumbnail strip | Yes, optional-chained |
| `Main.wm._workspaceAnimation`, override of `_prepareWorkspaceSwitch`, its `this._switchData` | overviewPreview.js | No clones during a workspace slide; the library blinks back once it lands | Yes, guarded and chain-safe via `InjectionManager` |
| `switchData.monitors`, `strip._monitor`, `strip._workspaceGroups`, `group._background` | overviewPreview.js | No clones during the slide | Yes, optional-chained throughout |
| Restated `WINDOW_ANIMATION_TIME` (as `WORKSPACE_SLIDE_TIME`) | app.js | The timer that releases a claimed workspace after a slide fires a little before or after the slide ends; cosmetic | No |
| `Main.wm.addKeybinding` / `removeKeybinding` | app.js | Public, listed for completeness — the shortcut simply would not grab | N/A (public) |

"Checked in code" of **No** does not mean unguarded outright — most of these
are behind `?.` or an `if`, so a missing field degrades to nothing happening
rather than a throw; it means there is no console message, so the only sign is
the symptom in the "if it changes" column.

## The button beside Show Apps (libraryButton.js)

### `Dash.ShowAppsIcon`, its `_createIcon` and `_iconActor`

`LibraryIcon extends Dash.ShowAppsIcon`:

```js
class VideoLibraryLibraryIcon extends Dash.ShowAppsIcon {
    _init(gicon) {
        this._gicon = gicon;
        super._init();
        this.setLabelText(LIBRARY.title);
    }
    _createIcon(size) {
        this._iconActor = new St.Icon({gicon: this._gicon, icon_size: size, ...});
        return this._iconActor;
    }
    _canRemoveApp() { return false; }
}
```

**What for.** `ShowAppsIcon` (exported) is a `DashItemContainer` around a
`show-apps` toggle button with a `BaseIcon` in it, built through `_createIcon`
— which `BaseIcon`'s own `_init` calls straight away, hence `_gicon` being set
before the chain-up rather than after. Subclassing it, rather than building a
`DashItemContainer` from scratch, is what gives the library's button the same
hover, focus ring, tooltip label and dash sizing every other dash icon has.
`_canRemoveApp` overrides Show Apps' own use as the dash's unpin target, which
the library's button is not.

**Why nothing public.** There is no public "make me one of these"; `BaseIcon`
and `DashItemContainer` are exported but building the right shape of one by
hand would duplicate the toggle-button wiring `ShowAppsIcon._init` already
does.

**If it changes.** `_createIcon` is called from inside `BaseIcon._init`
(itself called from `ShowAppsIcon._init`, called from the subclass's own
`super._init()`), so a renamed or removed hook throws there and the
`_attach()` call catches it (below): no button appears anywhere, and a warning
is logged on every attempt — at enable, and on each re-attach, which with no
button standing is every `extension-state-changed`.

**Checked.** `_attach()` wraps the whole build:

```js
try {
    if (panel?.showAppsIconWrapper && ...) this._attachToPanel(panel);
    else if (Main.overview.dash?._dashContainer) this._attachToDash(Main.overview.dash);
} catch (e) {
    console.warn(`[Video Library] No button beside Show Apps: ${e}`);
    this._detach();
}
```

### `Main.overview.dash._dashContainer` and `dash._hookUpLabel`

`_attachToDash()`:

```js
container.icon.setIconSize(dash.iconSize);
dash._hookUpLabel?.(container);
dash._dashContainer.add_child(container);
dash.connectObject('icon-size-changed', () => container.icon.setIconSize(dash.iconSize), this);
```

**What for.** `_dashContainer` is the `St.BoxLayout` the dash's icons actually
live in (as against `Dash.actor`, which wraps a scroll view around it);
`_hookUpLabel` is what makes the button's hover label behave as every other
icon's does (delay, position, the running-indicator dots it does not have).
`iconSize` and `icon-size-changed` are public, and this is the plain,
stock-GNOME path — reached only when Dash to Panel is not the one holding the
dash.

**If it changes.** `_dashContainer` missing skips this branch (`?.`) and no
button appears in the dash; `_hookUpLabel` missing (optional-chained) means
the button has no hover label, which is cosmetic.

**Checked.** `_dashContainer` is checked (`Main.overview.dash?._dashContainer`)
before this branch is taken at all; `_hookUpLabel` is called with `?.`.

### `global.dashToPanel`, Dash to Panel's panel internals

`_attach()` and `_attachToPanel()`:

```js
const panel = global.dashToPanel?.panels?.[0];
if (panel?.showAppsIconWrapper && panel.panel && panel._updateGroupedElements)
    this._attachToPanel(panel);
...
const showApps = panel.showAppsIconWrapper.realShowAppsIcon;
...
panel.panel.add_child(box);
panel._updateGroupedElements = wrapped;   // see "chain-safe wraps" below
panel.updateElementPositions?.();
```

**What for.** `global.dashToPanel` is Dash to Panel's own global, not the
shell's — the same way any extension can publish one. `panels[0]` is its
primary-monitor panel (a button per panel would need a list of hosts to
release, which is not done — only the first panel ever gets one). `.panel` is
the `St.Widget` panel elements live in; `.showAppsIconWrapper.realShowAppsIcon`
is the actual Show Apps icon Dash to Panel wraps its own tracking around, whose
size and style are copied so the button matches; `_updateGroupedElements` is
the method that lays its elements out into groups, wrapped chain-safely
(below) to insert the library's button straight after Show Apps every time it
runs; `updateElementPositions` asks the panel to re-run its own layout once
the wrap is in (or out). Inside the wrap, `this._elementGroups` is the list of
groups the stock method has just made: each group's `elements` (entries of
the shape `{actor, box, position}`, Show Apps found by its `actor`) gets the
button's own entry spliced in after Show Apps, with Show Apps' `position`, and
the group's `expandableIndex` is moved up one if it lay beyond.

**Why nothing public.** Dash to Panel exposes none of its layout as public
API; this is the same kind of reach any extension coexisting with it has to
make.

**If it changes.** Every field is checked (`panel?.showAppsIconWrapper && ...`)
before `_attachToPanel` is even called, so a changed shape falls through to
the dash branch instead — the button still appears, just in the wrong place
relative to Dash to Panel's own layout, or (with the dash also gone, which
does not happen on stock GNOME) not at all. `_elementGroups` gone (`?? []`):
the button is in `panel.panel` but never given a place in Dash to Panel's
layout. A group or entry of another shape makes the wrap throw; the layout
`_attachToPanel()` asks for runs inside `_attach()`'s try/catch, so that is
no button and a warning.

**Checked.** Yes, gated on entry as above, and the whole call is inside the
`_attach()` try/catch. `panels-created`, Dash to Panel's own signal, and
`extension-state-changed` on `Main.extensionManager` are what re-run `_attach`
when Dash to Panel appears, is toggled, or rebuilds its panels (a
`monitors-changed`, which no extension-state signal reflects) — and only
then: `_reattach` compares `global.dashToPanel.panels[0]` with the panel the
button is in and checks the button still has a parent, since
`extension-state-changed` fires for every extension, and a button rebuilt
for nothing takes the modal library's panel (which zooms out of it) down.

## The overview's app-grid slot (mediaMenu.js)

### `Main.overview._overview.controls`, `.appDisplay`, `._box`

`enable()`:

```js
this._controls = Main.overview._overview?.controls ?? null;
this._appDisplay = this._controls?.appDisplay ?? null;
this._appsBox = this._appDisplay?._box ?? null;
```

**What for.** `controls` is the public getter on the private `OverviewActor`
(the same first link every entry below climbs through); `appDisplay` is a
public getter for the `AppDisplay` instance; `_box` is the `St.BoxLayout`
`AppDisplay` fills with its scroll view and page dots — the media menu's own
`LibraryView` is added to `AppDisplay` itself, beside `_box`, hidden until
shown, taking turns with the apps by toggling `_appsBox.visible`.

**Why nothing public.** There is no supported way to add a second view into
the app grid's own slot; the overview offers no such extension point.

**If it changes.** `_appDisplay`/`_appsBox` null: no media menu, and (only
if any section is enabled — nothing to say otherwise) one warning at enable
time. Everything else in this file keys off `this._appsBox` being set.

**Checked.** Yes:

```js
if (!this._appDisplay || !this._appsBox || !this._sections.length) {
    if (this._sections.length)
        console.warn('[Video Library] The overview is not laid out as expected; no media menu.');
    this._appsBox = null;
    return;
}
```

### `Main.overview.dash.showAppsButton` and its `checked`

Followed in `enable()`; see the "Is the app grid up?" note in CLAUDE.md's
"Traps of its own" for why `checked` and not `appDisplay.visible`.
`showAppsButton` is a public getter on `Dash`.

**If it changes.** The view can no longer tell whether the app grid is
actually showing from whether Show Apps is lit; Escape or a swipe could leave
the media menu current with nothing showing it, the trap that note
describes.

**Checked.** No — `this._showAppsButton = Main.overview.dash.showAppsButton;`
is unguarded, since `dash` and `showAppsButton` are both long-standing public
getters, not underscore fields.

### `controls._searchController` and `controls._stateAdjustment`

Both private fields of `ControlsManagerLayout`'s owner (`ControlsManager`),
read once in `enable()` and used throughout to fold the workspace row and to
show it again once a search ends. Every use is `?.`-guarded
(`this._controls._searchController?.searchActive`,
`this._adjustment?.value`), so a missing field means the workspace row is
simply never folded or unfolded by this extension — the shell's own overview
still behaves correctly, just with the row always showing behind the posters.

### `controls._workspacesDisplay`

The workspace row itself, read in `_syncWorkspaces()` (`this._controls?._workspacesDisplay`)
and faded and made unreactive there as the fold goes in, with
`setPrimaryWorkspaceVisible?.(false)` once it is folded whole, as the shell
hides the row for a search; overviewPreview.js reaches the same
field for its previews (below). If it is gone, `_syncWorkspaces()` returns
early: the slot is still grown over the row, but the row is never faded, so
it stays drawn over the top of the posters and takes their clicks. Checked:
optional-chained, no warning.

### Restated `DASH_MAX_HEIGHT_RATIO` and `VERTICAL_SPACING_RATIO`, and `_slotSize()`

```js
const DASH_MAX_SHARE = 0.16;
const VERTICAL_SPACING_SHARE = 0.02;
```

Module-private constants of `overviewControls.js`, copied by inspection, and
used only by `_slotSize()`, which works out the app grid's slot step for step
as `ControlsManagerLayout.vfunc_allocate` does (search entry, dash, spacing),
for a button pressed before the overview has ever laid the slot out. Once the
shell has measured it, `menu._slot` is used instead. If either value or the
shell's own division of the overview changes, the view built from the
estimate is sized for a slot a little off, until it is next opened and
`_view()` builds it again against the shell's own measurement. Cosmetic, and
nothing to check for at runtime.

### `controls.layout_manager._getAppDisplayBoxForState` — the fold

`_foldWorkspaces()`:

```js
const layout = this._controls.layout_manager;
const stock = layout._getAppDisplayBoxForState;
if (typeof stock !== 'function') return;
this._stockBox = Object.hasOwn(layout, '_getAppDisplayBoxForState') ? stock : null;
const folded = function (state, box, searchHeight, dashHeight, workspacesBox, spacing) {
    const slot = stock.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing);
    ...
};
this._foldedBox = layout._getAppDisplayBoxForState = folded;
```

**What for.** `ControlsManagerLayout._getAppDisplayBoxForState` is the private
method (confirmed present, with this exact six-argument signature, at GNOME
`48.0` and `50.5`) that works out the app grid's box for a given
overview state — app grid, window picker, and the states between, during a
transition. There is no signal or hook for "the app grid's slot is about to be
laid out"; wrapping the method that computes it is the only way to grow it
over the workspace row while the media menu is up, and to read back the size
the shell is about to hand the grid (`menu._slot`) for the next time a view
has to be built ahead of being laid out at all — a button pressed before the
overview has ever shown.

**Why nothing public.** No public API describes or reserves the app grid's
slot; the overview lays out exactly what it knows about (search, dash,
workspaces, app grid) with nothing configurable in that division.

**If it changes.** `typeof stock !== 'function'` catches the method being gone
entirely: the wrap is simply not installed, and the workspace row is never
folded — the media menu still opens, just with the row of small workspaces
left showing above it, taking its room.

**Checked.** Guarded on entry as above; the chain-safety with Games Library's own
wrap of the same method is covered separately below.

### `Object.getPrototypeOf(this)._getAppDisplayBoxForState` — the unwrapped size

Inside the `folded` wrapper:

```js
const own = Object.getPrototypeOf(this)._getAppDisplayBoxForState;
const shell = own && own !== stock
    ? own.call(this, state, box, searchHeight, dashHeight, workspacesBox, spacing) : slot;
menu._slot = [shell.get_width(), shell.get_height() + workspacesBox.get_height() + spacing];
```

**What for.** `stock` (the closed-over previous value of the property) can
itself be Games Library's own wrap, already grown to fit *its* view — reading the
slot from `slot` (this call's own return value) in that case would record a
size grown for someone else's content, not the shell's true unfolded one. The
prototype's own method — the shell's original, since neither extension's wrap
is ever installed on the prototype, only as an own property of the instance —
is what both extensions fall back to for an honest "what the shell would give
the app grid with nothing folded".

**If it changes.** If the prototype's method is gone (caught by `own &&`), the
fallback is `slot` — the already-computed value from this call, which can be
a size grown for the *other* extension's view when both are enabled. The
practical effect is the media menu's grid being built one section's height too
generous or too tight until the next layout pass corrects it; not a crash.

**Checked.** `own && own !== stock` guards it; unguarded past that (a missing
`get_width`/`get_height` would throw, but every code path that reaches here
has already called `stock.call(...)` successfully with the same arguments, so
the returned `Clutter.ActorBox`-like value is never null in practice).

## The app grid (mediaGrid.js)

### `Object.getPrototypeOf(AppDisplay.AppDisplay)` — reaching `BaseAppView`

```js
const BaseAppView = Object.getPrototypeOf(AppDisplay.AppDisplay);
```

**What for.** `BaseAppView` is the class `AppDisplay` (exported) and
`FolderView` both extend, holding the grid, the scroll view, the page dots and
`goToPage`/`_redisplay`/`_addItem` — everything a media grid needs and nothing
that is apps-specific (that part is `AppDisplay` itself). It is not exported
under its own name at any checked version; reaching it off `AppDisplay`'s own
prototype chain is the only way to subclass it without subclassing
`AppDisplay` and then stripping out the apps-only parts (favourites, folders,
search).

**If it changes.** A straight top-level `Object.getPrototypeOf` call, in a
module `app.js` imports and `extension.js` imports in turn — if
`AppDisplay.AppDisplay` is gone, it throws as `mediaGrid.js` loads, and the
extension fails to load at all: no button, no library anywhere. If
`AppDisplay` stays but no longer has a `BaseAppView` as its prototype,
`MediaView` subclasses whatever it does extend, and its constructor throws
the first time a grid is built, on the first `BaseAppView` field it reads.

**Checked.** No. There is no fallback shape for the grid; this is the one
single point of failure the whole poster grid stands on.

### Private fields of `BaseAppView` read or disconnected

`MediaView`'s constructor:

```js
this.add_child(this._box);
this._parentalControlsManager.disconnectObject(this);
this._appFavorites.disconnectObject(this);
...
const dots = this._pageIndicators;
...
dots.connect('notify::visible', holdRoom);
this._grid.connect('pages-changed', holdRoom);
...
this._adjustment  // via `_shownPage()`, elsewhere
```

Plus, called from the parent's own machinery rather than read directly:
`_createGrid()`, which `BaseAppView`'s own `_init` calls (before
`MediaView`'s constructor body has run, hence the module-level `pendingGrid`
it builds from), and `_loadApps()`, `_compareItems(a, b)`, `_addItem(item,
page, position)` — private methods `BaseAppView`'s own `_redisplay()` calls.
The first three are overridden here; `_addItem` is called directly, since
media's own `goToPage`/`_fillTo` place tiles outright rather than going
through a diff-based `_redisplay`.

**What for.** `_parentalControlsManager` and `_appFavorites` are disconnected
because `BaseAppView` re-runs `_redisplay()` — a full diff of every tile —
whenever an app is favourited or the parental-controls filter changes; neither
has anything to say about media, and left connected they would occasionally
re-diff a grid of thousands of tiles for no reason. `_pageIndicators` is the
page-dot row, whose visibility is forced on with zero opacity for a one-page
section so every section's grid lands on the same baseline (see the Design
Rules note on page dots); `_grid`, the `MediaGrid` `_createGrid()` returned,
is followed for `pages-changed` so the dots are looked at once their count
has settled. `_box` is the box the parent fills with its scroll view and page
dots, which a subclass adds to itself, as `AppDisplay` does. `_adjustment` is
the scroll view's adjustment, which `_shownPage()` reads for the page
showing. `_addItem` is the private placement primitive
`_redisplay()` itself calls — used directly because letting the parent's own
`_redisplay()`/`_loadApps()`/`_compareItems()` diff-and-append pattern run
would, for a library of thousands, cost seconds on every tab switch; instead
`_loadApps()` is overridden to hand back exactly the tiles already built
(`[...this._media]`), which makes the parent's diff a no-op, and `_addItem` is
called directly from `_fillTo` as new tiles are wanted, a page at a time.

**Why nothing public.** `BaseAppView` is not built to be filled incrementally,
or to skip its own favourites/parental-controls machinery; there is no
supported subclassing point for either.

**If it changes.** `_parentalControlsManager`/`_appFavorites` gone or renamed:
`disconnectObject(this)` on `undefined` throws in `MediaView`'s constructor,
and no grid is built anywhere. The same goes for `_box`
(`this.add_child(this._box)`), `_pageIndicators` (`dots.connect(...)`) and
`_grid` (`this._grid.connect(...)`). `_adjustment` gone: `_shownPage()`
throws, and with it `reveal()`, `focusFirst()` and `pageBy()` — the grid
still draws and pages by swipe, scroll wheel and its arrows, but the
staggered reveal, where the keyboard lands on a page and a remote's page turn
all fail. `_addItem` gone or resignatured: tiles fail to place (thrown from
`_fillTo`). `_createGrid` renamed: the parent builds its own stock `AppGrid`,
whose layout puts the posters in square cells. `_loadApps`/`_compareItems`
renamed: only `_redisplay()` calls them, and with the favourites and
parental-controls hooks disconnected it runs only when a drag in the overview
is cancelled while the grid is mapped (`BaseAppView`'s own
`item-drag-cancelled` handler); that redisplay would then throw, or diff the
grid against the wrong list.

**Checked.** No. None of these is behind a feature check; the grid depends on
every one of them keeping its current shape, name and calling convention.

### `AppViewItem`'s `_id`, `_name` and positional `_init`

`MediaItem._init()`:

```js
super._init({style_class: 'overview-tile'}, false, true);
this._id = `${section.key}/${item.id}`;
this._name = item.title;
```

**What for.** `AppViewItem._init(params, isDraggable, expandTitleOnHover)`
takes its two flags positionally: `false` keeps a poster from being dragged
like an app icon, `true` keeps the title unfolding to two lines on hover.
`_id` and `_name` are the fields `AppViewItem`'s public `id` and `name`
getters return, and that subclasses set for themselves; `BaseAppView._addItem`
files each tile by `id`, and `_redisplay()` diffs by it.

**If it changes.** `_id`/`_name` renamed: every tile reads the same
`undefined` id, so the parent's item map and diff no longer tell tiles apart;
the tiles still place and draw, since `_fillTo` puts each one by page and
position. The signature changed: the two flags land on the wrong parameters,
and a poster becomes draggable or its title stops unfolding on hover.

**Checked.** No.

### Restated `PAGE_PREVIEW_RATIO`

```js
const ARROWS_SHARE = 0.2;
```

The shell's `PAGE_PREVIEW_RATIO`, module-private in `appDisplay.js`: a tenth
of the view's width each side of the grid, where the page arrows stand.
`gridFor` takes it off the width before working out how many covers fit and
how large. If the shell's own share changes, covers are sized for a margin
that no longer matches where the arrows are, a little too large or too
small; cosmetic, and nothing to check for at runtime.

### Private fields of `IconGrid.IconGridLayout` read in `PosterGridLayout.vfunc_allocate`

```js
class VideoLibraryPosterGridLayout extends IconGrid.IconGridLayout {
    vfunc_allocate() {
        if (!this._pageWidth || !this._pageHeight) return;
        const first = this._pages[0]?.visibleChildren[0];
        ...
        this._pageSizeChanged = false;
        this._shouldEaseItems = false;
    }
}
```

**What for.** `IconGridLayout` (exported) does the app grid's own paging and
allocation; `_pages`, each with a `children`/`visibleChildren` list, `_pageWidth`
and `_pageHeight` are its private page model: `_pages` is kept by the
layout's own item bookkeeping as the grid adds tiles (`addItem`), and
`_pageWidth`/`_pageHeight` are set by its `adaptToSize()`, which
`IconGrid.vfunc_allocate` calls just before allocating its children. This
override replaces the parent's `vfunc_allocate` completely (no `super` call)
for one reason: the shell's layout takes the larger of an item's width and
height as one square cell side, which a poster is not. `columnSpacing`,
`rowSpacing`, `columnsPerPage`, `rowsPerPage` and `pagePadding` are, by
contrast, real GObject properties (`row-spacing`, `rows-per-page`, ... in the
class's `Properties`), so those are public and not part of this reach.
`_pageSizeChanged`/`_shouldEaseItems` are cleared at the end because this
layout never reorders and never needs the parent's own re-ease-on-reorder
logic to run.

**Why nothing public.** The layout is not built to have its shape of cell
overridden without overriding page geometry along with it; there is no
`vfunc` narrower than the whole allocation to hook.

**If it changes.** If `_pages`/`_pageWidth`/`_pageHeight` are renamed or
restructured, `vfunc_allocate` either throws (a page grid entirely blank, the
overview and every other view broken the same way) or silently allocates
every tile to (0, 0) — tiles stacked on top of one another, indistinguishable
from a hang.

**Checked.** No, beyond the early return on `!this._pageWidth ||
!this._pageHeight` (which guards against an allocation before `adaptToSize()`
has ever been called, where the parent's own `vfunc_allocate` throws, not
against the fields being gone).

A comment in `mediaGrid.js` also notes that the layout the shell's grid makes
for itself, which `MediaGrid` replaces with a `PosterGridLayout`
(`this.layout_manager = layout`), is deliberately left unreferenced: the
`IconGrid` class's own constructor (`iconGrid.js`, not `IconGridLayout`'s)
closes over the layout it built and disconnects its `pages-changed` from it
on destroy, so nothing here needs to hold it. That connection is to the
replaced layout only, so `MediaGrid` re-emits the `PosterGridLayout`'s
`pages-changed` as the grid's own by hand (`layout.connect('pages-changed',
() => this.emit('pages-changed'))`), which is what `BaseAppView` and the
page-dot code above follow. Confirmed present, in that shape, at 50.5.

## The folder's panel, borrowed (panel.js, detailDialog.js, libraryWindow.js)

`MediaPanel` (panel.js) is not a subclass of the shell's `AppFolderDialog` —
it is a hand-built copy of the same shape (the shade, the zoom out of a tile,
the `GrabHelper`, the click-away, the settle), because `AppFolderDialog`
itself has a name entry and a folder's grid baked into its `_init` that would
have to be torn back out. What is reused instead is the shell's own CSS class
and behaviour for the things this file cannot see into.

### `Main.overview._overview.controls._appDisplay._folderIcons`, `icon._dialog`, `dialog._viewBox` — `folderLook()`

```js
function folderLook() {
    const icons = Main.overview._overview?.controls?._appDisplay?._folderIcons ?? [];
    for (const icon of icons) {
        const dialog = icon._dialog;
        if (!dialog) continue;
        const blur = dialog.get_effects().find(e => e instanceof Shell.BlurEffect);
        const classes = (dialog._viewBox?.get_style_class_name() ?? '')
            .split(/\s+/).filter(c => c && c !== 'app-folder-dialog');
        if (blur || classes.length) return {blur: {...}, classes};
    }
    return null;
}
```

**What for.** `_folderIcons` is `AppDisplay`'s own list of `FolderIcon`s;
`_dialog` is the `AppFolderDialog` a folder icon builds itself lazily, the
first time it is opened (so a desktop that has never opened a folder this
session has none to ask, which `folderLook()` treats the same as a desktop
with no folders at all — see below); `_viewBox` is that dialog's own
`St.BoxLayout`. The point is cosmetic parity: Blur my Shell drops the app
folder's shade and blurs the desktop behind it instead, and puts a class of
its own on `_viewBox` to make the panel itself translucent — so a real
folder's dialog is asked, once per pop-up, what it currently looks like, and
the same blur/classes are matched onto `MediaPanel`'s own panel, rather than
computing "is Blur my Shell enabled" independently (which would still have to
reach into Blur my Shell to know its radius and brightness, and would drift
out of step with a folder the moment Blur my Shell changed either).

**Why nothing public.** Neither the shell nor Blur my Shell exposes "what does
a folder look like right now"; there is no signal for it either.

**If it changes.** `folderLook()` returns `null` the same way it does when
there genuinely is nothing to ask (no folder ever opened, or Blur my Shell
off): the pop-up panel falls back to the shell's own `DIALOG_SHADE_NORMAL`
shade and the plain `app-folder-dialog` theme, which is also exactly correct
on a desktop that has neither.

**Checked.** Every link is optional-chained to `?? []`/`null`; `folderLook()`
itself is only ever called from `_easeBackdrop(true)`, which handles a `null`
return as "use the shade" without a warning: a folder-less desktop takes this
path on every single open, and a warning there would be noise, not a
symptom.

### Restated `DIALOG_SHADE_NORMAL`

```js
// The shade behind the panel: the shell's DIALOG_SHADE_NORMAL, not exported.
const SHADE = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 204});
```

Not reached at runtime — a value copied once, by inspection, because the
shell's own constant is module-private in `appDisplay.js` (not exported at
`48.0`, `49.0` or `50.5`). If the shell's own shade colour ever changes, this
one does not follow it; purely cosmetic, and nothing to check for at runtime.

## Workspaces held open (app.js)

### `workspace._keepAliveId`, set and read directly

`_keepOnly()`:

```js
if (ws._keepAliveId) { GLib.source_remove(ws._keepAliveId); ws._keepAliveId = 0; }
...
if (!ws || ws._keepAliveId) continue;   // set by someone else — the shell's own, mid drag-and-drop
ws._keepAliveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, GLib.MAXUINT32, () => GLib.SOURCE_CONTINUE);
GLib.Source.set_name_by_id(ws._keepAliveId, '[video-library] keep workspace');
```

`_claimWorkspace()` reads it too, to pass over a workspace that is already
held — by this extension, or by the shell mid drag-and-drop — when looking
for a free one:

```js
const free = ws => ws && !taken.has(ws) && !ws._keepAliveId && ...;
```

**What for.** GNOME's dynamic workspaces fold away any empty workspace that is
not the active one or the last one; `_keepAliveId` is the field the shell's
own `WorkspaceTracker._checkWorkspaces()` (`windowManager.js`) checks before
folding a workspace, and `id !== 0` is what spares it. Video Library sets it
on every workspace it is holding open — the one the library or the pane
claimed, and the one being slid away from, whose picture the slide still
needs — and clears it (removing the source explicitly) the moment nothing
needs that workspace held any more.

**Why nothing fully public.** There *is* a public method that touches the
same field — `Main.wm.keepWorkspaceAlive(workspace, duration)` (confirmed
present, forwarding to `WorkspaceTracker.keepWorkspaceAlive`, at `48.0` and
50.5) — but it is duration-bound: it arms a timeout that clears
`_keepAliveId` and re-checks the workspaces itself once `duration` elapses.
Video Library needs a workspace held for as long as the library (or a pick)
is open on it, which can be arbitrarily longer than any fixed duration, and
released the instant that is no longer true — not re-armed on a clock. The
`GLib.timeout_add(..., GLib.MAXUINT32, () => GLib.SOURCE_CONTINUE)` here never
fires the shell's own re-check on a timer; only `_keepOnly()` removing the
source does. Calling the public method with a very large `duration` would
still eventually expire and fold the workspace away under whatever was open
on it.

**If it changes.** If the field is renamed, nothing is spared any more:
GNOME's own dynamic-workspace code folds an empty workspace the library or the
pane is on the moment focus moves off it, which — since the surface itself is
what is drawn there — would look like the library or the pane vanishing, or
the desktop losing a workspace out from under an open pane. `_claimWorkspace()`
would also no longer see a workspace the shell is holding for a drag.

**Checked.** No. Setting an unrecognised field on a `Meta.Workspace` does not
throw either way, so there is nothing to catch; the failure mode above is
silent.

### `Main.wm._workspaceTracker._queueCheckWorkspaces()`

Called after `_keepOnly()` releases any workspace, and once more after
`_takeWorkspace()` claims one:

```js
if (released) Main.wm._workspaceTracker?._queueCheckWorkspaces?.();
```

**What for.** Releasing a `_keepAliveId` does not itself fold the now-empty
workspace away — the tracker only re-checks when queued to. This nudges it to
do that promptly rather than waiting for the next window event to trigger one
on its own.

**If it changes.** A released workspace is folded away late, on the shell's
own next check, rather than immediately — cosmetic, not a correctness issue
(the workspace is still correctly *not* held, `_keepAliveId` is still `0`).

**Checked.** Yes, both the field and the method are optional-chained.

### Restated `WINDOW_ANIMATION_TIME`

```js
// workspaceAnimation.js WINDOW_ANIMATION_TIME — exported only from 50, so restated.
const WORKSPACE_SLIDE_TIME = 250;
```

The length of the shell's workspace slide, module-private at 48 and 49.
`_releaseWorkspaces()` waits that long (through `adjustAnimationTime`, plus
50 ms) before letting a workspace being slid away from go. If the shell's own
duration changes, the release lands a little before or after the slide
actually ends; cosmetic, not a hang, and nothing to check for at runtime.

## The overview previews and the workspace slide (overviewPreview.js)

This file's structure and every field in it are the same idea as Wallpaper
FX's own `overviewPreview.js` ([its private-api.md](https://github.com/Jackicus/GNOME-Wallpaper-FX/blob/main/docs/private-api.md)),
reached for the same reason: neither the overview's workspace previews nor the
workspace-slide strip shows `Main.layoutManager._backgroundGroup` — each
builds a wallpaper of its own — so a surface parented there is simply absent
from both pictures unless a clone of it is put into each by hand. The
mechanism is identical; only the source being cloned differs (the library's
current page here, the shader canvas there). See that document for the deeper
walk-through; this section lists the same reaches as they appear in this
extension's copy, plus the one difference.

### `Main.overview._overview.controls._workspacesDisplay._workspacesViews`, `view._workspaces`

```js
const views = Main.overview._overview?.controls?._workspacesDisplay?._workspacesViews ?? [];
const out = [];
for (const view of views) out.push(...(view._workspaces ?? []));
```

**The one difference from Wallpaper FX's copy.** Video Library only ever
draws on the primary monitor (checked immediately after, in `_attach()`:
`background._monitorIndex !== Main.layoutManager.primaryIndex` skips every
other preview), so this file does not unwrap `SecondaryMonitorDisplay`'s own
`_workspacesView`/`ExtraWorkspaceView` wrapper the way Wallpaper FX's does
for its multi-monitor patterns. Confirmed at 50.5: `_workspacesViews[i]` for
`i === primaryIndex` is always a plain `WorkspacesView` with a `_workspaces`
array (`workspacesView.js` `_updateWorkspacesViews()`); every other monitor's
entry is a `SecondaryMonitorDisplay`, which has no `_workspaces` field at all
and so silently contributes nothing (`?? []`) here — which is already the
right answer, since this file was going to skip it by monitor index anyway.
If a future GNOME wraps the *primary* monitor's view the same way secondary
monitors are (`workspaces-only-on-primary` off, say), this would need the same
unwrapping Wallpaper FX's copy already does.

### `workspace._background`, `._backgroundGroup`, `._monitorIndex`; `controls._thumbnailsBox._thumbnails`, `thumbnail._contents`; `Main.wm._workspaceAnimation` and its `_prepareWorkspaceSwitch`; `switchData.monitors`, `strip._monitor`, `strip._workspaceGroups`, `group._background`

Identical in shape and reasoning to Wallpaper FX's own copy — see that
document. One shape fact was independently confirmed here, since this
extension's slide code (unlike Wallpaper FX's) does not comment on it:
at 50.5, `group._background` (inside `switchData.monitors[]._workspaceGroups[]`)
is a `WorkspaceBackground` (`workspaceAnimation.js`, distinct from the
same-named class in `workspace.js`) whose own `_createBackground()` builds a
plain `Meta.BackgroundGroup` and adds it as its first (and, at the point the
slide clone is inserted, only) child — so `group._background.get_first_child()`
is that `Meta.BackgroundGroup`, and `insert_child_above(clone, that)` lands the
clone above the wallpaper and below any desktop-window clones the slide adds
afterwards. At `48.0`, `group._background` is itself a plain
`Meta.BackgroundGroup`, whose first child is the wallpaper actor, so the same
call lands the clone in the same place (`compatibility.md`). The override
reads the animation's own `this._switchData` before and after calling
through: empty before and set after is a fresh slide, handed on to be joined;
set before is a slide already under way, which the shell's method returns
from early. If `_switchData` is renamed, no slide is ever joined, and the
slide shows no clones. `InjectionManager` (imported from the
shell's own `resource:///.../extensions/extension.js`) is public extension API
— it is what makes the `_prepareWorkspaceSwitch` override chain-safely with
whatever else has already wrapped it. The wrap is installed once per enable
(`installSlideHook`, from `app.js`) and removed once at disable
(`removeSlideHook`), not per build: it sits on a shared prototype, and a
rebuild — every rescan — that took it out and put it back would drop a wrap
another extension added over it in between. It hands each slide to the
`OverviewPreview` that is current.

## Chain-safe wraps, for coexisting with Games Library

Two methods here are wrapped the same way a sibling extension
(`games-library@jackicus`, meant to run alongside this one) wraps the same methods
for its own view: `panel._updateGroupedElements` (libraryButton.js
`_attachToPanel`, Dash to Panel's) and `layout._getAppDisplayBoxForState`
(mediaMenu.js `_foldWorkspaces`, the shell's). Both follow the same pattern —

1. Close over whatever the property held first (`stock`), which may already be
   the other extension's own wrap.
2. Call through to it before doing anything of this extension's own, every
   time, unconditionally.
3. Track whether *this* wrap is still the outermost one (`inert`, or
   comparing the property's current value against the closure), so a call
   arriving after this extension has been disabled — because the other
   extension wrapped the same method afterwards and is still installed — does
   nothing rather than running stale logic.
4. On the way out, restore what was there before only if this wrap is still
   the outermost (`panel._updateGroupedElements === wrapped`) — putting back
   `stock` if this extension had its own override, or `delete`-ing the
   property if it never did (so a later `Object.hasOwn` check, the other
   extension's or the shell's, reads it as absent rather than as a leftover
   `undefined`).

This means: disabling whichever of the two extensions wrapped *first* leaves
the other's wrap in the chain, calling through correctly, with nothing to
clean up until the second is disabled too, at which point its own `release()`
puts the true original back. Disabling the one that wrapped *second* is the
simple case — its own `release()` finds itself still outermost and restores
what was under it, which can be the other extension's wrap, still live.

**If it changes.** Nothing about this pattern depends on shell version; it
depends only on both extensions still wrapping the same private
method names Games Library does. If a future Games Library (or a future GNOME
renaming the wrapped methods) breaks the assumption, the practical failure is
one of the two extensions' contributions going missing from the panel or the
slot — not a throw, since each wrap calls through unconditionally regardless
of what it finds.

**Checked.** Yes, in the sense that both wraps are internally consistent
(`inert`/`hadOwn`/identity checks throughout); there is no way to check at
runtime that Games Library's own wraps follow the same protocol, since that lives
in a different extension's source.
