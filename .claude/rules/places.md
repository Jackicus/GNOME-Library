---
paths:
  - "src/lib/app.js"
  - "src/lib/libraryButton.js"
  - "src/lib/libraryView.js"
  - "src/lib/mediaMenu.js"
  - "src/lib/libraryWindow.js"
  - "src/lib/detailDialog.js"
  - "src/lib/panel.js"
  - "src/lib/overviewPreview.js"
---

# Where the library and the pane open

## The surface (`desktop`, `workspaces`)

- Built when either setting is a surface place, attached to
  `Main.layoutManager._backgroundGroup`, inside the monitor's work area. It holds **one
  library page** (`libraryView.js`: tabs over a grid per section, each grid built once,
  the enabled ones ahead of time one to an idle, and kept, so a tab switch is which
  grid is visible) and **one detail page**, a header over the shared pane, retitled per
  pick. The pane moves into the library page when it takes the grid's place.
  Separate pages are what let the library's and the pane's workspaces show different
  things at once, which the overview's previews clone side by side.
- The button brings the library up and puts it away; Escape and the header's Close do
  the same. There is no home menu: `desktop` draws nothing until the button is
  pressed, then draws on the workspace it was pressed on, following a press on
  another workspace rather than opening a second copy. `workspaces` claims the
  trailing empty workspace and slides to it; closing slides back and gives it up.
  `detail-opens-in` `workspaces` claims one for the pane the same way.
- The workspace a library or pane was opened *from* is held open while it is away
  (`_holdWorkspaces()`, called after anything that changes what is claimed), so Back
  and Close always have somewhere to land. Workspaces are held as `Meta.Workspace`
  objects, not indices, and marked with the shell's own `_keepAliveId` (which its
  workspace tracker uses during drag-and-drop), released when nothing needs them and
  on disable. `desktop` claims nothing, which is why it has the least private API
  under it.
- **Two pieces of state.** `_placeForWorkspace()` is worked out fresh from what
  survives a rebuild (`_libraryWorkspace`, `_detailWorkspace`, `_picked`, `_origin`,
  none of which `_teardown` touches); `_shown` is what is on the stack, and a rebuild
  empties it. `_onWorkspaceChanged` compares the computed place against `_shown`, or
  the surface stays blank after a rescan or a settings change.
- Opening an item flies its artwork into the hero slot with a `Clutter.Clone` while
  the grid recedes; Back reverses it.

## The browsers (`menu`, `modal`)

- A library in either is a browser of its own, `MediaMenu` or `LibraryWindow`, each
  holding one `LibraryView`, opened from the button. The button behaves as a dock's
  Show Apps: pressed on the desktop it opens the overview, so a second press or Escape
  lands back on the desktop; pressed with the overview up, back to the window picker.
  Every way out of an overview it opened goes all the way down: a dock's own
  `forcedOverview` flag is never set by us, and an overview left on the window picker
  made every later Show Apps press land there. Show Apps itself is left alone.
- Tabs switch in place, with no overview transition. A rebuild (a setting, a rescan)
  replaces the browser and puts back the tab that was showing (`state`/`restore`).
- `menu`: the tabs and grids go into the overview's app-grid slot, and the row of
  small workspaces folds away, read from the overview's own state adjustment, never
  timed (a fade of ours is out of step with the shell's, and one started as the
  overview unmaps stalls until it is next shown).
- `modal`: the tabs and grids go in a folder's panel (`panel.js`) that zooms out of the
  button as an app folder's does; a second press, Escape or a click on the shade closes
  it, and it dies the moment the button unmaps.
- With both settings outside the surface, nothing is drawn on the wallpaper and no
  surface is built. Every place draws a poster with `widgets.js` `createArtwork`.

## The pop-up pane (`detail-opens-in` `menu`, `modal`)

- `detailDialog.js` subclasses `panel.js` `MediaPanel` (as the modal library's
  `libraryWindow.js` does), a copy of the shell's `AppFolderDialog` with the folder's
  grid and name entry taken out, styled `app-folder-dialog`. Its panel is sized
  around a poster rather than a 720px square and holds a `DetailView` (with a `bare`
  frame) where the folder holds its grid.
- The pane sits inside the panel by `shape.js` `PANE_INSET`, taken out of the pane's
  own padding: `detailView.js` `PADDING.bare` and the stylesheet's
  `.ml-pane-bare .ml-pane-content` are the two halves and must agree, or the pane
  overhangs and the clip cuts the backdrop's bottom corners square.
- What goes behind it is asked of a folder, never assumed (`panel.js` `folderLook`): a
  `Shell.BlurEffect` on a folder's dialog is matched with the shade dropped, and any
  class on its box beyond `app-folder-dialog` goes on ours (Blur my Shell does both).
  With no folder on the desktop, the stock shade (`DIALOG_SHADE_NORMAL`) and theme stand.
- It opens in two moves: the panel zooms out of the tile as the artwork and buttons
  alone, poster-shaped, then widens onto the title, facts and list, built on an idle
  meanwhile. Closing mirrors it. The pane is laid out once at the open width inside a
  clip that is the panel, whose height is the side column's (`layout.md`).
- `menu`: hosted where the pick was made (`overviewGroup` with the overview up,
  `uiGroup` otherwise), and gone the moment its tile unmaps. `modal`: hosted in
  `uiGroup` always, so a pick in the overview hides the overview first (and the panel
  fades in centred), a pick from the modal library's panel closes that panel, and it
  outlives a workspace change.
- Its `GrabHelper` takes Escape and the keyboard, and holds the grab as
  `Shell.ActionMode.POPUP`, the app folder's tier, not `SYSTEM_MODAL`. Neither place is
  a window: a `Meta.Window` would need a second process, since the shell links no GTK.

## Pictures of a workspace

The overview and the workspace slide build their own wallpaper actor per workspace and
never show the desktop, so `overviewPreview.js` puts a `Clutter.Clone` of the live
library or detail page into every picture the shell makes of one of our workspaces:
the previews, the thumbnails and the slide's strip. Nothing is built for them; the
clones die with the shell's actors. A clone lays its hidden source out at the size it
asks for, so the pages are sized outright. A preview's background group is the
monitor allocated small and stretched in x and y independently while the overview
animates, re-allocated without reliably notifying, so the host reads its scale back
in its own `vfunc_allocate` and asks for no size; the monitor-sized frame inside is
redirected offscreen, one texture per preview.
