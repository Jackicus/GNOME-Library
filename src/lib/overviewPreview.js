// Clones of the surface in the overview's previews and the workspace slide, which
// build wallpapers of their own: docs/private-api.md.

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import GObject from 'gi://GObject';
import Clutter from 'gi://Clutter';

// The current build's previews, handed each slide.
let current = null;
// The wrap on a prototype Wallpaper FX wraps too: chain-safe, docs/private-api.md.
let slideHook = null;

export function installSlideHook() {
    const animation = Main.wm._workspaceAnimation;
    if (!animation?._prepareWorkspaceSwitch)
        return;
    const proto = Object.getPrototypeOf(animation);
    const hadOwn = Object.hasOwn(proto, '_prepareWorkspaceSwitch');
    const previous = proto._prepareWorkspaceSwitch;
    const hook = function (...args) {
        // Returns early, setting nothing, when a slide is already under way.
        const fresh = !this._switchData;
        const result = previous.apply(this, args);
        if (slideHook?.hook === hook && fresh && this._switchData)
            current?._joinSlide(this._switchData);
        return result;
    };
    proto._prepareWorkspaceSwitch = hook;
    slideHook = {proto, hadOwn, previous, hook};
}

// Put back only while it is still the outermost; left in a chain, it does nothing.
export function removeSlideHook() {
    const {proto, hadOwn, previous, hook} = slideHook ?? {};
    if (proto && proto._prepareWorkspaceSwitch === hook) {
        if (hadOwn)
            proto._prepareWorkspaceSwitch = previous;
        else
            delete proto._prepareWorkspaceSwitch;
    }
    slideHook = null;
}

// The preview's group is re-allocated small and stretched as the overview
// animates, without always notifying, so the scale is read back here.
const PreviewHost = GObject.registerClass(
class VideoLibraryPreviewHost extends Clutter.Actor {
    constructor(props, monitor) {
        super(props);
        this._monitor = monitor;
    }

    // A size request would stretch the workspace preview out of shape.
    vfunc_get_preferred_width() {
        return [0, 0];
    }

    vfunc_get_preferred_height() {
        return [0, 0];
    }

    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const frame = this.get_first_child();
        if (!frame)
            return;
        const scaleX = box.get_width() / this._monitor.width;
        const scaleY = box.get_height() / this._monitor.height;
        if (!isFinite(scaleX) || !isFinite(scaleY) || scaleX <= 0 || scaleY <= 0)
            return;
        // Re-allocated on most frames of the overview's animation.
        if (scaleX === this._scaleX && scaleY === this._scaleY)
            return;
        this._scaleX = scaleX;
        this._scaleY = scaleY;
        frame.set_scale(scaleX, scaleY);
    }
});

export class OverviewPreview {
    // Handed the Meta.Workspace, never an index: see app.js workspaceIsLive().
    constructor({placeForWorkspace, sourceFor, bounds}) {
        this._placeForWorkspace = placeForWorkspace;
        this._sourceFor = sourceFor;
        this._bounds = bounds;
        this._clones = [];
        this._attached = false;
    }

    enable() {
        current = this;
        Main.overview.connectObject(
            'showing', () => this._attach(),
            'hidden', () => this._detach(),
            this);
        if (Main.overview.visible)
            this._attach();
    }

    destroy() {
        if (current === this)
            current = null;
        Main.overview.disconnectObject(this);
        this._detach();
    }

    _joinSlide(switchData) {
        const monitor = Main.layoutManager.primaryMonitor;
        const strip = switchData.monitors?.find(m => m._monitor?.index === monitor?.index);
        for (const group of strip?._workspaceGroups ?? []) {
            const place = this._placeForWorkspace(group.workspace);
            const source = place ? this._sourceFor(place) : null;
            // Over the wallpaper, under the desktop's own windows.
            const wallpaper = group._background?.get_first_child();
            if (source && wallpaper)
                group._background.insert_child_above(this._cloneOf(source, this._bounds.x - monitor.x, this._bounds.y - monitor.y), wallpaper);
        }
    }

    invalidate() {
        if (!this._attached)
            return;
        this._detach();
        this._attach();
    }

    _attach() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        this._attached = true;

        for (const workspace of this._workspacePreviews()) {
            const background = workspace._background;
            const group = background?._backgroundGroup;
            // The surface is drawn on the primary monitor only.
            if (!group || background._monitorIndex !== Main.layoutManager.primaryIndex)
                continue;

            const place = this._placeForWorkspace(workspace.metaWorkspace);
            const source = place ? this._sourceFor(place) : null;
            if (!source)
                continue;

            const host = new PreviewHost({
                name: `VideoLibraryPreview:${place}`,
                x_align: Clutter.ActorAlign.FILL,
                y_align: Clutter.ActorAlign.FILL,
                x_expand: true,
                y_expand: true,
                reactive: false,
            }, monitor);
            const frame = new Clutter.Actor({width: monitor.width, height: monitor.height, reactive: false});
            // One texture the overview scales, rather than every tile on every frame.
            frame.set_offscreen_redirect(Clutter.OffscreenRedirect.ALWAYS);
            frame.add_child(this._cloneOf(source, this._bounds.x - monitor.x, this._bounds.y - monitor.y));
            host.add_child(frame);
            group.add_child(host);
            this._track(host);

            // The thumbnails lay their contents out in stage coordinates.
            const thumbnails = Main.overview._overview?.controls?._thumbnailsBox?._thumbnails ?? [];
            const contents = thumbnails.find(t => t.metaWorkspace === workspace.metaWorkspace)?._contents;
            if (contents) {
                const clone = this._cloneOf(source, this._bounds.x, this._bounds.y);
                contents.add_child(clone);
                this._track(clone);
            }
        }
    }

    _cloneOf(source, x, y) {
        return new Clutter.Clone({
            source,
            reactive: false,
            x,
            y,
            width: this._bounds.width,
            height: this._bounds.height,
        });
    }

    _detach() {
        this._attached = false;
        for (const actor of [...this._clones])
            actor.destroy();
        this._clones = [];
    }

    _track(actor) {
        this._clones.push(actor);
        actor.connect('destroy', () => {
            const at = this._clones.indexOf(actor);
            if (at >= 0)
                this._clones.splice(at, 1);
        });
    }

    _workspacePreviews() {
        const views = Main.overview._overview?.controls?._workspacesDisplay?._workspacesViews ?? [];
        const out = [];
        for (const view of views)
            out.push(...(view._workspaces ?? []));
        return out;
    }
}
