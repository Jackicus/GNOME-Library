# Private and deep GNOME Shell API

Library puts its button beside Show Apps, borrows the app grid for its
posters and the folder dialog's shape for its pop-up pane, and puts its pages
into the overview and the workspace slide, which would otherwise show bare
wallpaper. None of that has a public API. This is everything it reaches into,
for reviewers on extensions.gnome.org and for whoever ports it. Which shell
versions each reach was read at is [compatibility.md](compatibility.md)'s.
Functions are named rather than line numbers.

## At a glance

"Guarded" **No** does not always mean a throw: most reaches are behind `?.` or
an `if`, and then the only sign is the symptom, with nothing logged.

| Expression | File | If it changes | Guarded |
|---|---|---|---|
| `Main.layoutManager._backgroundGroup` | app.js | Building the surface throws; no `desktop` or `workspaces` place | No |
| `workspace._keepAliveId` (read and set) | app.js | A workspace the library or pane is on is folded away under it; a workspace the shell holds mid drag-and-drop can be claimed | No, and silent |
| `Main.wm._workspaceTracker._queueCheckWorkspaces()` | app.js | A released workspace folds away on the shell's next check, not at once | Yes, `?.` |
| `Dash.ShowAppsIcon`, its `_createIcon`, `_iconActor` | libraryButton.js | The subclass throws building; no button, a warning | Yes, try/catch |
| `Main.overview.dash._dashContainer`, `dash._hookUpLabel` | libraryButton.js | No button in the dash; no hover label | Yes, `?.` |
| `global.dashToPanel.panels[0]`, `panels-created`, `.showAppsIconWrapper.realShowAppsIcon`, `.panel`, `._updateGroupedElements` (wrapped), `.geom`, `.updateElementPositions` | libraryButton.js | The button goes in the dash instead | Yes, each checked first; read only with `dash-to-panel` on |
| `panel._elementGroups`, a group's `.elements` and `.expandableIndex`, an element's `.actor` and `.position` | libraryButton.js | `_elementGroups` gone: the button is in the panel with no place in its layout. Another shape: the wrap throws inside `_attach()`'s try/catch, so no button and a warning | Partly |
| `Main.overview._overview.controls`, `.appDisplay`, `._box` | mediaMenu.js | No `menu` library; one warning, if a section is enabled | Yes |
| `Main.overview.dash.showAppsButton` (`.checked`) | mediaMenu.js | The menu can no longer tell the app grid is up (the kit's "Is the app grid up?" rule) | No |
| `controls._searchController.searchActive` | mediaMenu.js | Workspaces do not come back for a search while the view is up | Yes, `?.` |
| `controls._stateAdjustment` | mediaMenu.js | The workspace row is not folded in step with the overview | Yes, `?.` |
| `controls._workspacesDisplay` (`.opacity`, `.reactive`, `setPrimaryWorkspaceVisible`) | mediaMenu.js, overviewPreview.js | The row is never faded, so it stays over the posters and takes their clicks; no clones in the previews | Yes, `?.` |
| `controls.layout_manager._getAppDisplayBoxForState` (wrapped) | mediaMenu.js | The slot never grows over the workspace row | Yes, `typeof` check |
| Restated `DASH_MAX_HEIGHT_RATIO`, `VERTICAL_SPACING_RATIO`, and `_slotSize()` restating `ControlsManagerLayout.vfunc_allocate` | mediaMenu.js | A view built before the overview ever laid out is a little off until next built | No |
| `Object.getPrototypeOf(AppDisplay.AppDisplay)` (`BaseAppView`) | mediaGrid.js | `mediaGrid.js` throws as it loads; the extension does not load | No |
| `BaseAppView`'s `_parentalControlsManager`, `_appFavorites`, `_box`, `_pageIndicators`, `_grid` | mediaGrid.js | `MediaView`'s constructor throws; no grid anywhere | No |
| `BaseAppView`'s `_adjustment` | mediaGrid.js | `_shownPage()` throws: no staggered reveal, keyboard landing or remote page turn; swipe, wheel and arrows still page | No |
| `BaseAppView`'s `_createGrid`, `_loadApps`, `_compareItems` (overridden), `_addItem` (called) | mediaGrid.js | `_createGrid` renamed: square cells. `_addItem` changed: no tiles. The other two: a cancelled overview drag re-diffs the grid wrongly | No |
| `AppViewItem`'s `_id`, `_name` and positional `_init(params, isDraggable, expandTitleOnHover)` | mediaGrid.js | Tiles draw but share one id; a changed signature makes posters draggable or stops the title unfolding | No |
| Restated `PAGE_PREVIEW_RATIO` (`ARROWS_SHARE`) | mediaGrid.js | Covers sized for the wrong margin beside the page arrows | No |
| `IconGridLayout`'s `_pageWidth`, `_pageHeight`, `_pages`, `_pageSizeChanged`, `_shouldEaseItems` | mediaGrid.js | `_pageWidth`/`_pageHeight` gone: `vfunc_allocate` returns early and no tile is allocated, so no poster shows. `_pages` gone: it throws | No |
| `controls._appDisplay._folderIcons`, `icon._dialog`, `dialog._viewBox` | panel.js `folderLook()` | The pop-up keeps the stock shade and theme even under Blur my Shell | Yes, `?.` to `null` |
| Restated `DIALOG_SHADE_NORMAL` (`SHADE`) | panel.js | The shade drifts from the shell's | No |
| `controls._workspacesDisplay._workspacesViews`, `view._workspaces` | overviewPreview.js | No clones in the overview's previews | Yes, `?? []` |
| `workspace._background`, `._backgroundGroup`, `._monitorIndex` | overviewPreview.js | No clone in that preview | Yes, skipped |
| `controls._thumbnailsBox._thumbnails`, `thumbnail._contents` | overviewPreview.js | No clone in the thumbnails | Yes, `?.` |
| `Main.wm._workspaceAnimation._prepareWorkspaceSwitch` (overridden), `._switchData` | overviewPreview.js | No clones in the slide; the library blinks back once it lands | Yes, a chain-safe wrap |
| `switchData.monitors`, `strip._monitor`, `strip._workspaceGroups`, `group._background` | overviewPreview.js | No clones in the slide | Yes, `?.` |

## The button beside Show Apps (libraryButton.js)

`LibraryButtonIcon` subclasses `Dash.ShowAppsIcon` for the hover, focus
ring, label and sizing every dash icon has. `BaseIcon._init` calls
`_createIcon` before the subclass's `_init` returns, so `_gicon` is set before
the chain-up; `_canRemoveApp()` returns false so the button is no unpin target.
`_attach()` builds it inside one try/catch and logs "No button beside Show
Apps" on failure, at enable and on each re-attach.

In the plain dash it goes into `_dashContainer` and `_hookUpLabel` gives it
the dash's label. Dash to Panel is reached only while the `dash-to-panel`
setting ("Work with Dash to Panel", off by default) is on. Off, none of what
follows runs, nothing of Dash to Panel is read or watched, and the button
stays in the overview's dash, which Dash to Panel hides. On,
`global.dashToPanel` is the object Dash to Panel exports for other extensions,
with its `panels` and its `panels-created` signal, and the extension manager's
`extension-state-changed` for Dash to Panel's UUID says when it comes and
goes. Dash to Panel has no way to add an element to its panel: it lays the
panel out from `_elementGroups`, a private list its `_updateGroupedElements`
rebuilds from its own settings. So the one patch is a wrap of that method on
`panels[0]`, the primary monitor's panel, put on at attach and taken off
("Chain-safe wraps", below) at detach, when the setting goes off, and when
Dash to Panel rebuilds its panels or is disabled. The wrap splices the
button's entry in after Show Apps in `_elementGroups`, with Show Apps'
`position`, and moves `expandableIndex` up one if it lay beyond. The shell
disables and re-enables the extensions enabled after one being disabled
without a signal, and Dash to Panel then hands its primary panel's bar back to
the top bar with the button still in it; so the `destroy` of its Show Apps
(`showAppsIconWrapper.realShowAppsIcon`) releases the button and looks for the
new panel on the next idle. `panels-created` and `extension-state-changed`
re-run `_attach`, but `_reattach` acts only when `panels[0]` changed or the
button lost its parent: a button rebuilt for nothing takes the modal library's
panel, which zooms out of it, down with it. If Dash to Panel renames or
reshapes what the table above lists, the button falls back to the dash, or is
missing with a warning in the log; turning the setting off puts it back in the
dash.

## The overview's app-grid slot (mediaMenu.js)

There is no extension point for a second view in the app grid's slot. The
`menu` library's `LibraryView` is added to `AppDisplay` beside its `_box`, and
the two take turns by `_box.visible`.

The row of small workspaces folds away by wrapping
`ControlsManagerLayout._getAppDisplayBoxForState` (`_foldWorkspaces()`), the
method that computes the app grid's box for each overview state: there is no
hook for that layout. The wrap also records the slot (`menu._slot`) for a view
that has to be built before it is ever laid out. `_slotSize()` works the same
slot out step for step for a button pressed before the overview has ever been
shown, with the two ratios restated from `overviewControls.js`.

## The app grid (mediaGrid.js)

`BaseAppView`, the class `AppDisplay` and `FolderView` extend, is not
exported; `Object.getPrototypeOf(AppDisplay.AppDisplay)` is the only way to
subclass it without `AppDisplay`'s favourites, folders and search. It is the
one point of failure with no fallback.

- `MediaView`'s constructor disconnects `_parentalControlsManager` and
  `_appFavorites`, whose changes would re-diff a grid of thousands of tiles
  for nothing; adds `_box` to itself, as `AppDisplay` does; keeps
  `_pageIndicators` visible at zero opacity on a one-page section so every
  section's rows line up; and follows `_grid`'s `pages-changed`.
- `_createGrid()` runs from the parent's `_init`, before `this` is usable,
  hence the module-level `pendingGrid`. `_loadApps()` returns the tiles
  already built, so the parent's diff is a no-op, and `_fillTo` places tiles a
  page at a time with `_addItem`.
- `MediaItem` passes `AppViewItem._init` its two flags positionally (`false`:
  not draggable; `true`: the title unfolds on hover) and sets `_id` and
  `_name`, which the public `id` and `name` getters return.
- `PosterGridLayout.vfunc_allocate` replaces the parent's whole allocation,
  which takes one square cell from an item's larger side; a poster is not
  square, and no narrower vfunc exists. The spacing and per-page counts are
  public GObject properties. `MediaGrid` replaces the layout `IconGrid` built
  and re-emits the new layout's `pages-changed` as the grid's own.

## The folder's panel (panel.js, detailDialog.js, libraryWindow.js)

`MediaPanel` is a copy of `AppFolderDialog`'s shape, not a subclass: the
folder's name entry and grid are built into its `_init`. To look like a folder
under Blur my Shell, which drops the shade, blurs behind and adds a class to
the folder's box, `folderLook()` asks a real folder's `_dialog` once per open
and copies its `Shell.BlurEffect` and extra `_viewBox` classes. A folder
builds its dialog the first time it opens, so with none opened yet there is
nothing to ask, and the stock shade stands, without a warning.

## Workspaces held open (app.js)

The shell's `WorkspaceTracker._checkWorkspaces()` (`windowManager.js`) spares
an empty workspace whose `_keepAliveId` is set. `_keepOnly()` sets it, with a
`GLib.MAXUINT32` timeout that never fires, on each workspace the library or
pane claimed and on one being slid away from, and removes it the moment
nothing needs the workspace; `_claimWorkspace()` passes over a workspace whose
id someone else set. The public `Main.wm.keepWorkspaceAlive(workspace,
duration)` writes the same field but expires on a clock, and the hold here
lasts as long as the library is open. `_queueCheckWorkspaces()` is called
after a release and a claim so the tracker re-checks at once.
`_releaseWorkspaces()` waits `workspaceAnimation.js`'s `WINDOW_ANIMATION_TIME` (through
`adjustAnimationTime`, plus 50 ms) before giving up a workspace being left.

## The overview previews and the workspace slide (overviewPreview.js)

Neither the overview's previews nor the slide's strip shows
`_backgroundGroup`: each builds a wallpaper of its own. So `overviewPreview.js`
puts a `Clutter.Clone` of the live page into each, as Wallpaper FX's
`overviewPreview.js` does for its canvas
([its private-api.md](https://github.com/Jackicus/GNOME-Wallpaper-FX/blob/main/docs/private-api.md)).
Unlike Wallpaper FX it draws on the primary monitor only: `_attach()` skips a
preview whose `_monitorIndex` is not `primaryIndex`, and a secondary monitor's
`SecondaryMonitorDisplay` has no `_workspaces`, so it adds nothing.

In the slide, the clone goes above `group._background.get_first_child()`,
below any window clones the slide adds after. The `_prepareWorkspaceSwitch`
override compares `this._switchData` before and after calling through: unset
before and set after is a fresh slide, handed to the current
`OverviewPreview`. It is installed once per enable (`installSlideHook`) and
removed at disable (`removeSlideHook`), not per rebuild, by the same protocol as
the wraps below: Wallpaper FX wraps the same prototype method for its own slide
clones.

## Chain-safe wraps

Dash to Panel's `_updateGroupedElements` (`libraryButton.js` `_attachToPanel`)
and the shell's `_getAppDisplayBoxForState` (`mediaMenu.js` `_foldWorkspaces`)
are wrapped as the kit's monkey-patch rule has it, since another extension may
wrap either (Dash to Dock patches the latter on the prototype). Each wrap here
closes over what the property held, always calls through, does nothing once it
is no longer current (`inert`, or `_foldedBox` no longer itself), and on
release puts back what it found only while it is still the outermost: another
extension's wrap if that was there, or a `delete` if the property was never an
own one. So disabling either, in either order, leaves the other's working.

The slide wrap (`overviewPreview.js`) keeps it beside Wallpaper FX, which wraps
`_prepareWorkspaceSwitch` on the same prototype through `InjectionManager`.
Disabling Library leaves Wallpaper FX's wrap in place in either order.
`InjectionManager.restoreMethod` puts back what it saved whatever is there now,
so disabling Wallpaper FX while ours sits over its wrap drops ours until the
next enable: that half is Wallpaper FX's to change.
