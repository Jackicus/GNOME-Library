// Fills a scroll view a batch at a time, each batch on its own idle.

import GLib from 'gi://GLib';

const MARGIN = 600;

// `buildBatch()` appends the next batch and returns false when nothing is left.
export function fillOnScroll(scroll, buildBatch, {margin = MARGIN} = {}) {
    const adjustment = scroll.vadjustment;
    let more = buildBatch();
    let pending = 0;

    // page_size is 0 until the view is first allocated.
    const wantsMore = () => adjustment.page_size > 0 &&
        (adjustment.upper <= adjustment.page_size + 1 ||
         adjustment.value + adjustment.page_size >= adjustment.upper - margin);

    const topUp = () => {
        if (pending || !more)
            return;
        pending = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            pending = 0;
            if (more && wantsMore()) {
                more = buildBatch();
                topUp();   // keep going until the view is covered
            }
            return GLib.SOURCE_REMOVE;
        });
    };

    adjustment.connect('notify::value', topUp);
    adjustment.connect('notify::upper', topUp);
    adjustment.connect('notify::page-size', topUp);
    // The adjustment is already disposed by now; only the idle is ours to remove.
    scroll.connect('destroy', () => {
        if (pending)
            GLib.source_remove(pending);
        pending = 0;
        more = false;
    });

    topUp();
}
