// Adapted from GNOME Shell's AppFolderDialog (js/ui/appDisplay.js), without the
// folder's grid and name entry; subclasses fill it and size it (_sizePanel).

import Atk from 'gi://Atk';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as GrabHelper from 'resource:///org/gnome/shell/ui/grabHelper.js';
import * as Layout from 'resource:///org/gnome/shell/ui/layout.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Duration, Ease, POP_SCALE, easeProps, rectIn} from './anim.js';
import {NAVIGATION_KEYS, handleBoundKey} from './controls.js';
import {radiusStyle} from './shape.js';

// Logical pixels. A folder's panel is 720px square; this is one poster wider.
const MARGIN = 48;
const MAX_WIDTH = 1180;
const MAX_HEIGHT = 760;
// The shade behind the panel: the shell's DIALOG_SHADE_NORMAL, not exported.
const SHADE = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 204});
const CLEAR = new Cogl.Color({red: 0, green: 0, blue: 0, alpha: 0});
const BLUR = 'library-panel-blur';

// The blur and classes a folder's dialog carries (Blur my Shell sets both), to
// match; private, see docs/private-api.md.
function folderLook() {
    const icons = Main.overview._overview?.controls?._appDisplay?._folderIcons ?? [];
    for (const icon of icons) {
        const dialog = icon._dialog;
        if (!dialog)
            continue;
        const blur = dialog.get_effects().find(e => e instanceof Shell.BlurEffect);
        const classes = (dialog._viewBox?.get_style_class_name() ?? '')
            .split(/\s+/).filter(c => c && c !== 'app-folder-dialog');
        if (blur || classes.length) {
            return {
                blur: blur ? {radius: blur.radius, brightness: blur.brightness} : null,
                classes,
            };
        }
    }
    return null;
}

export const MediaPanel = GObject.registerClass({
    Signals: {
        'open-state-changed': {param_types: [GObject.TYPE_BOOLEAN]},
    },
}, class LibraryMediaPanel extends St.Bin {
    constructor({host = null, dieWithSource = true, size = 1, inset = 0} = {}) {
        super({
            visible: false,
            x_expand: true,
            y_expand: true,
            reactive: true,
            accessible_role: Atk.Role.PANEL,
        });

        this._constraint = new Layout.MonitorConstraint({index: Main.layoutManager.primaryIndex});
        this.add_constraint(this._constraint);

        this._host = host;
        this._dieWithSource = dieWithSource;
        this._size = size;
        this._inset = inset;

        this._addClickAway();

        this._panel = new St.BoxLayout({
            style_class: 'app-folder-dialog',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            orientation: Clutter.Orientation.VERTICAL,
            // St scales a CSS length itself, so the inset goes in unmultiplied.
            style: inset
                ? `${radiusStyle('pane')} padding: ${inset}px;` : radiusStyle('pane'),
        });
        this._panel.set_pivot_point(0, 0);

        this.child = new St.Bin({
            child: this._panel,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
        });

        global.focus_manager.add_group(this);

        this._grabHelper = new GrabHelper.GrabHelper(this, {
            actionMode: Shell.ActionMode.POPUP,
        });

        this._source = null;
        this._isOpen = false;
        this._needsZoomAndFade = false;
        this._blur = null;
        this._classes = [];
        this._blurTimeline = null;
        this._closingLead = 0;
        this._restSize = [320, 320];

        this.connect('open-state-changed', (_panel, isOpen) => {
            const source = this._source;
            if (!source)
                return;
            const duration = Duration.NORMAL / 2;
            source.ease({
                opacity: isOpen ? 0 : 255,
                duration,
                mode: isOpen ? Ease.OUT : Ease.IN,
                delay: isOpen ? 0 : this._closingLead + Duration.NORMAL - duration,
            });
        });

        // A focused child destroyed under the panel drops key focus to the stage.
        global.stage.connectObject('notify::key-focus', () => {
            if (this._isOpen && !global.stage.get_key_focus())
                this.grab_key_focus();
        }, this);

        this.connect('destroy', () => this._onDestroy());
    }

    _addClickAway() {
        if (Clutter.ClickGesture) {
            const clickGesture = new Clutter.ClickGesture();
            clickGesture.connect('may-recognize', () => {
                const coords = clickGesture.get_coords_abs();
                const [, x, y] = this.child.transform_stage_point(coords.x, coords.y);
                return !this._panel.allocation.contains(x, y);
            });
            clickGesture.connect('recognize', () => this.popdown());
            this.add_action(clickGesture);
            return;
        }

        const clickAction = new Clutter.ClickAction();
        clickAction.connect('clicked', () => {
            const [x, y] = clickAction.get_coords();
            if (global.stage.get_actor_at_pos(Clutter.PickMode.ALL, x, y) === this)
                this.popdown();
        });
        this.add_action(clickAction);
    }

    get isOpen() {
        return this._isOpen;
    }

    _onDestroy() {
        if (this._isOpen) {
            this._isOpen = false;
            this._grabHelper.ungrab({actor: this});
            this._grabHelper = null;
        }
        this._blurTimeline?.stop();
        this._blurTimeline = null;
        this._source?.disconnectObject(this);
        this._source = null;
        global.stage.disconnectObject(this);
        global.focus_manager.remove_group(this);
    }

    _sourceArt(source = this._source) {
        return source?.artwork ?? source;
    }

    get _framePx() {
        return this._inset * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    // The container fills the monitor; the work area's insets are its padding.
    _budget() {
        const monitor = Main.layoutManager.monitors[this._constraint.index] ??
            Main.layoutManager.primaryMonitor;
        const area = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
        const top = (area.y - monitor.y) / scale;
        const left = (area.x - monitor.x) / scale;
        const right = (monitor.x + monitor.width - area.x - area.width) / scale;
        const bottom = (monitor.y + monitor.height - area.y - area.height) / scale;
        this.child.set_style(`padding: ${top}px ${right}px ${bottom}px ${left}px;`);

        // `maxHeight` is for content that does not fit in the `detail-size` share.
        const room = {
            width: Math.min(MAX_WIDTH * scale, area.width - 2 * MARGIN * scale),
            height: Math.min(MAX_HEIGHT * scale, area.height - 2 * MARGIN * scale),
        };
        return {
            width: Math.round(room.width * this._size),
            height: Math.round(room.height * this._size),
            maxHeight: Math.round(room.height),
        };
    }

    _sizePanel(_budget) {
        throw new GObject.NotImplementedError(`_sizePanel in ${this.constructor.name}`);
    }

    _opened() {
    }

    _closeSequence() {
        this._zoomAndFadeOut();
    }

    _setSource(source) {
        this._source?.disconnectObject(this);
        this._source = source;
        if (this._dieWithSource) {
            source.connectObject('notify::mapped', () => {
                if (!source.mapped)
                    this.popdown();
            }, this);
        }
        source.connectObject('destroy', () => {
            this._source = null;
            this.popdown();
        }, this);
    }

    _easeBackdrop(on) {
        this._blurTimeline?.stop();
        this._blurTimeline = null;

        if (on) {
            const look = folderLook();
            this._blur = look?.blur ?? null;
            this._classes = look?.classes ?? [];
            for (const c of this._classes)
                this._panel.add_style_class_name(c);
        } else {
            for (const c of this._classes)
                this._panel.remove_style_class_name(c);
            this._classes = [];
        }

        if (!this._blur) {
            this.remove_effect_by_name(BLUR);
            this.ease({
                background_color: on ? SHADE : CLEAR,
                duration: Duration.NORMAL,
                mode: Ease.OUT,
            });
            return;
        }

        let blur = this.get_effect(BLUR);
        if (!blur) {
            blur = new Shell.BlurEffect({
                name: BLUR,
                radius: 0,
                brightness: 1,
                mode: Shell.BlurMode.BACKGROUND,
            });
            this.add_effect(blur);
        }
        this._blurTimeline = easeProps(blur, {
            radius: on ? this._blur.radius : 0,
            brightness: on ? this._blur.brightness : 1,
        }, {duration: Duration.NORMAL, mode: Ease.OUT});
    }

    _zoomAndFadeIn() {
        // The panel is untransformed here, so the artwork's rectangle in it is
        // the translation.
        const {x, y, width, height} = rectIn(this._sourceArt(), this._panel);

        this._panel.set({
            translation_x: x,
            translation_y: y,
            scale_x: width / this._panel.width,
            scale_y: height / this._panel.height,
            opacity: 0,
        });

        this._easeBackdrop(true);
        this._panel.ease({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: Duration.NORMAL,
            mode: Ease.OUT_EXPO,
            onComplete: () => this._opened(),
        });

        this._needsZoomAndFade = false;
    }

    _zoomAndFadeOut() {
        if (!this._source?.mapped) {
            this._fadeOut();
            return;
        }

        const {x, y, width, height} = rectIn(this._sourceArt(), this._panel);

        this._easeBackdrop(false);
        this._panel.ease({
            opacity: 0,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
        });
        this._panel.ease({
            translation_x: x,
            translation_y: y,
            scale_x: width / this._panel.width,
            scale_y: height / this._panel.height,
            duration: Duration.NORMAL,
            mode: Ease.OUT_EXPO,
            onComplete: () => this._settle(),
        });

        this._needsZoomAndFade = false;
    }

    _fadeIn() {
        this._panel.set_pivot_point(0.5, 0.5);
        this._panel.set({scale_x: POP_SCALE, scale_y: POP_SCALE, opacity: 0});

        this._easeBackdrop(true);
        this._panel.ease({
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => this._opened(),
        });
    }

    _fadeOut() {
        this._easeBackdrop(false);
        this._panel.ease({
            opacity: 0,
            duration: Duration.NORMAL,
            mode: Ease.OUT,
            onComplete: () => this._settle(),
        });
    }

    _settle() {
        this.remove_all_transitions();
        this._blurTimeline?.stop();
        this._blurTimeline = null;
        this.remove_effect_by_name(BLUR);
        this._panel.remove_all_transitions();
        this._panel.set_pivot_point(0, 0);
        this._panel.set_size(...this._restSize);
        this._panel.set({
            translation_x: 0,
            translation_y: 0,
            scale_x: 1,
            scale_y: 1,
            opacity: 255,
        });
        this.background_color = CLEAR;
        this.hide();
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);

        if (this._needsZoomAndFade)
            this._zoomAndFadeIn();
    }

    vfunc_key_press_event(event) {
        if (handleBoundKey(event))
            return Clutter.EVENT_STOP;

        if (global.focus_manager.navigate_from_event(event))
            return Clutter.EVENT_STOP;

        // An arrow from the panel itself has nowhere to go; land where Tab would.
        if (global.stage.get_key_focus() === this &&
            NAVIGATION_KEYS.includes(event.get_key_symbol()) && this._focusFirst())
            return Clutter.EVENT_STOP;

        return Clutter.EVENT_PROPAGATE;
    }

    _focusFirst() {
        return this.navigate_focus(null, St.DirectionType.TAB_FORWARD, false);
    }

    popup(source = null) {
        if (this._isOpen)
            return;

        const art = this._sourceArt(source);
        if (art) {
            const [x, y] = art.get_transformed_position();
            const [width, height] = art.get_transformed_size();
            this._constraint.index = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({
                    x: Math.floor(x),
                    y: Math.floor(y),
                    width: Math.max(1, Math.ceil(width)),
                    height: Math.max(1, Math.ceil(height)),
                }));
        } else {
            this._constraint.index = global.display.get_current_monitor();
        }

        const host = this._host ?? (Main.overview.visible
            ? Main.layoutManager.overviewGroup : Main.layoutManager.uiGroup);
        if (this.get_parent() !== host) {
            this.get_parent()?.remove_child(this);
            host.add_child(this);
        }

        this._isOpen = this._grabHelper.grab({
            actor: this,
            focus: this,
            onUngrab: () => this.popdown(),
        });

        if (!this._isOpen)
            return;

        host.set_child_above_sibling(this, null);

        if (source) {
            this._setSource(source);
        } else {
            this._source?.disconnectObject(this);
            this._source = null;
        }

        const budget = this._budget();
        this._prepare?.(budget);
        this._sizePanel(budget);

        if (source) {
            this._needsZoomAndFade = true;
            this.show();
        } else {
            this.show();
            this._fadeIn();
        }

        this.emit('open-state-changed', true);
    }

    popdown() {
        if (!this._isOpen)
            return;

        this._isOpen = false;
        this._closeSequence();
        this._grabHelper.ungrab({actor: this});
        this.emit('open-state-changed', false);
    }
});
