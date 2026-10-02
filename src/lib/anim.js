// The extension's durations sit beside the shell's 250 ms (CLAUDE.md, Motion).

import Clutter from 'gi://Clutter';

import {adjustAnimationTime} from 'resource:///org/gnome/shell/misc/animationUtils.js';

export const Duration = {
    FAST: 120,     // hover, pressed state, things leaving
    NORMAL: 200,   // page change, things arriving
    SLOW: 260,     // hero flight between views
};

export const Ease = {
    OUT: Clutter.AnimationMode.EASE_OUT_QUAD,
    OUT_EXPO: Clutter.AnimationMode.EASE_OUT_EXPO,
    // Only for a folder's icon coming back as its dialog closes.
    IN: Clutter.AnimationMode.EASE_IN_QUAD,
};

// The scale the shell pops a window from; the grid recedes to it behind the pane.
export const POP_SCALE = 0.94;

// For an effect's properties, which actor.ease() cannot reach. Returns the
// timeline, to stop if the object goes first.
export function easeProps(object, targets, {duration = Duration.NORMAL, mode = Ease.OUT, onComplete} = {}) {
    const time = adjustAnimationTime(duration);
    const entries = Object.entries(targets).map(([key, to]) => [key, object[key], to]);
    const land = () => {
        for (const [key, , to] of entries)
            object[key] = to;
        onComplete?.();
    };
    if (time < 1) {
        land();
        return null;
    }

    const timeline = new Clutter.Timeline({
        actor: global.stage,
        duration: time,
        progress_mode: mode,
    });
    timeline.connect('new-frame', () => {
        const t = timeline.get_progress();
        for (const [key, from, to] of entries)
            object[key] = from + (to - from) * t;
    });
    timeline.connect('stopped', (_timeline, finished) => {
        if (finished)
            land();
    });
    timeline.start();
    return timeline;
}

export function staggerIn(actors, {step = 12, cap = 150, fromY = 10, duration = Duration.NORMAL} = {}) {
    actors.forEach((actor, i) => {
        actor.remove_all_transitions();
        actor.opacity = 0;
        actor.translation_y = fromY;
        actor.ease({
            opacity: 255,
            translation_y: 0,
            delay: Math.min(i * step, cap),
            duration,
            mode: Ease.OUT,
        });
    });
}

// onComplete runs however the slide ends, interrupted too, so the outgoing
// actor is always let go.
export function slideSwap(outgoing, incoming, direction, {distance = 32, onComplete} = {}) {
    if (outgoing) {
        outgoing.remove_all_transitions();
        outgoing.ease({
            opacity: 0,
            translation_x: -direction * distance,
            duration: Duration.FAST,
            mode: Ease.OUT,
            onComplete: () => {
                outgoing.hide();
                outgoing.translation_x = 0;
                outgoing.opacity = 255;
            },
        });
    }
    incoming.remove_all_transitions();
    incoming.translation_x = direction * distance;
    incoming.opacity = 0;
    incoming.show();
    incoming.ease({
        opacity: 255,
        translation_x: 0,
        duration: Duration.NORMAL,
        mode: Ease.OUT,
        onStopped: () => onComplete?.(),
    });
}

export function fadeTo(actor, opacity, {duration = Duration.NORMAL} = {}) {
    actor.remove_all_transitions();
    if (opacity > 0)
        actor.show();
    actor.ease({
        opacity,
        duration,
        mode: Ease.OUT,
        onComplete: () => {
            if (opacity === 0)
                actor.hide();
        },
    });
}

// Flies by transform alone, so nothing is re-allocated per frame. Resolves when
// the clone goes, landed or destroyed with its layer, so no caller waits forever.
export function flyClone(layer, source, from, to, {duration = Duration.SLOW} = {}) {
    return new Promise(resolve => {
        const clone = new Clutter.Clone({
            source,
            x: from.x,
            y: from.y,
            width: from.width,
            height: from.height,
        });
        clone.set_pivot_point(0, 0);
        clone.connect('destroy', () => resolve());
        layer.add_child(clone);
        clone.ease({
            translation_x: to.x - from.x,
            translation_y: to.y - from.y,
            scale_x: to.width / Math.max(1, from.width),
            scale_y: to.height / Math.max(1, from.height),
            duration,
            mode: Ease.OUT_EXPO,
            onComplete: () => clone.destroy(),
        });
    });
}

// ensure_style() covers only the widget it is called on, and a fresh column
// measures without its spacing and margins until each child has had it.
export function ensureStyleDeep(actor) {
    actor.ensure_style?.();
    for (const child of actor.get_children())
        ensureStyleDeep(child);
}

// A freshly shown actor has no allocation until the next frame and measures
// NaN. Its parent must already be allocated.
export function allocateNow(actor) {
    const parent = actor.get_parent();
    if (!parent)
        return;
    const box = parent.get_allocation_box();
    actor.allocate(new Clutter.ActorBox({x1: 0, y1: 0, x2: box.x2 - box.x1, y2: box.y2 - box.y1}));
}

export function rectIn(actor, ancestor) {
    const [ax, ay] = ancestor.get_transformed_position();
    const [x, y] = actor.get_transformed_position();
    const [width, height] = actor.get_transformed_size();
    return {x: x - ax, y: y - ay, width, height};
}
