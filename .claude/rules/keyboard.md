---
paths:
  - "src/lib/app.js"
  - "src/lib/libraryView.js"
  - "src/lib/mediaGrid.js"
  - "src/lib/panel.js"
  - "src/lib/controls.js"
  - "src/lib/actions.js"
  - "src/lib/widgets.js"
  - "src/prefs.js"
---

# The keyboard, remotes and controllers

## St's focus

- The surface's page stack is a focus group (`global.focus_manager.add_group`), as the
  shell's dialogs are, and so is each grid: the nearest group around the focus is the
  one the arrows walk. The group is the stack, not the surface, because a group that
  can take the keyboard itself yields the focus (`st_widget_real_navigate_focus`), and
  the surface is focusable: it holds the keyboard while nothing else does, and is what
  Escape bubbles up to.
- Nothing is focused until a navigation key asks; then Tab and the arrows move, Enter
  opens, Escape (ours) backs out a level. Whatever holds the keyboard is constantly
  hidden or destroyed, and Clutter drops key focus to the stage then, so `app.js`
  watches `notify::key-focus` and takes it back while the surface is what the
  workspace shows. A window on the surface's workspace therefore gets no keys.
- The tabs and the grid are two groups, and St never walks between groups: an arrow
  up from the grid's top row (`atTopRow`) focuses the tabs and an arrow down from them
  the first tile (`libraryView.js`). A tab chooses itself on `key-focus-in`
  (`widgets.js`), so a remote with only arrows can switch sections.
- A pop-up panel holds the keyboard as it opens and an arrow finds nothing to move to,
  so its first navigation key lands where Tab would (`panel.js` `_focusFirst`).

## Bound keys and controllers

- Ten actions (`lib/actions.js`): the four directions, Select, Back, Home, a page each
  way, Mark watched. Each has keys (`keys-<action>`, `a(uu)` keyval and modifiers:
  numbers, because Clutter's keysym table lacks `XF86OK`, `XF86HomePage` and others a
  remote sends) and controller inputs (`pad-<action>`, `"button:304"`, `"axis:1-"`).
- The first six are replayed as their key through a Clutter virtual keyboard, so they
  do exactly what the arrows, Enter and Escape do. Paging (`mediaGrid.js` `pageBy`:
  the shell's grid turns no page for a key), Home and Mark watched (a row's
  `toggleWatched`: St's focus stops at the row) are done directly.
- A bound key is handed over by the view it reached (the surface's `_onKeyPress`, a
  grid's key handler, a panel's `vfunc_key_press_event`), so a binding means nothing
  outside a library. The arrows, Enter and Escape are never offered for binding.
- Controllers are read with libmanette, loaded on demand (it runs without it), and
  acted on only while `_controlsActive()`, except Home, which opens the library when
  no window has the focus.

## The shortcut

`library-shortcut` (`as`, empty by default) is grabbed with `Main.wm.addKeybinding`,
so mutter follows the setting at once; it is not listed in GNOME Settings. A press is
the button's press (`app.js` `_onShortcut`). It is grabbed in `POPUP` mode too, only so
the modal library's panel can be closed or switched with it. The preferences capture
it as GNOME Settings does (`prefs.js` `_captureShortcut`): system shortcuts are
inhibited while listening (the shell asks once whether the Extensions app may), and a
key the window manager, the shell or the media keys already hold is refused.
