// St CSS has no variables: every rounded surface takes its radius from here.

const MAX = 40;
const DEFAULT_RADIUS = 18;

// The shell's $base_padding (_common.scss): logical pixels, into a CSS string.
export const PANE_INSET = 6;

const PART = {
    art: r => r,
    hero: r => r + 4,
    pane: r => r + 12,
    // Inside the panel's frame: the outer curve less the frame keeps them concentric.
    paneInner: r => r + 12 - PANE_INSET,
    badge: r => Math.round(r / 2),
};

let styles = {};

export function setCornerRadius(px) {
    const base = Math.max(0, Math.min(MAX, Math.round(px) || 0));
    styles = {};
    for (const [part, scale] of Object.entries(PART))
        styles[part] = `border-radius: ${scale(base)}px;`;
}
setCornerRadius(DEFAULT_RADIUS);

export function radiusStyle(part = 'art') {
    return styles[part];
}
