---
paths:
  - "src/lib/mediaGrid.js"
  - "src/lib/mediaMenu.js"
  - "src/lib/detailView.js"
  - "src/lib/detailDialog.js"
  - "src/lib/panel.js"
  - "src/lib/shape.js"
  - "src/lib/lazyList.js"
  - "src/lib/widgets.js"
  - "src/stylesheet.css"
---

# How the grid and the pane size themselves

- **`columns` and `rows` are the grid's shape wherever it is drawn**, each capped by
  what fits at `mediaGrid.js` `MIN_ART` in the box that view is given, so a narrow space
  shows fewer of either. The block is always centred, because `gridFor` shrinks the
  cover to fit `rows` and `columns` exactly; `grid-align` (`setGridAlign`, read as the
  layout allocates) only decides whether a part-full row is centred under the full
  ones or hugs the leading edge.
- **The page dots keep their room on a one-page section**: the shell hides them, but the
  grid still budgets their height, so every section's rows land on the same lines.
- **The hero has a floor** (`detailView.js` `HERO_MIN`, 132 logical px): on a small
  work area the smallest `detail-size` leaves less room than the buttons beneath the
  artwork take, so the panel shrinks instead and the artwork does not vanish.
- **The overview is laid out in the work area, not on the monitor.** The box
  `ControlsManagerLayout.vfunc_allocate` divides is already inset by the top bar and
  anything reserved (Dash to Panel's 48 px), so `mediaMenu.js` `_slotSize`, which works
  the slot out before the overview has ever been shown, starts from
  `getWorkAreaForMonitor` and measures the dash whether or not it is visible, as the
  shell does. Wrong, and the first tab's grid is built against a taller box than every
  later one. The box each view was built for is kept, and every view is rebuilt when it
  moves.
- On destroy, `lazyList.js` takes back only its idle source: the scroll view's
  adjustment is gone by then.
- Only the tabs and the detail rows track hover; tiles hover by crossing events.
- **A measurement of something just built**: the detail pop-up's height is asked of the
  side column after `anim.js` `ensureStyleDeep()`; without it `get_preferred_height`
  answers as if there were no spacing or margins, the panel comes out shorter than the
  pane, and the clip cuts the backdrop's corners square.
