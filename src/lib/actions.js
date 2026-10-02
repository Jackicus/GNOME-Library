// Data only, as the preferences import it. `stands` is the key an action replays.

export const ACTIONS = [
    {key: 'up', title: 'Up', stands: 'Up'},
    {key: 'down', title: 'Down', stands: 'Down'},
    {key: 'left', title: 'Left', stands: 'Left'},
    {key: 'right', title: 'Right', stands: 'Right'},
    {key: 'select', title: 'Select', subtitle: 'Opens or plays what is highlighted, as Enter does', stands: 'Return'},
    {key: 'back', title: 'Back', subtitle: 'Backs out one level, as Escape does', stands: 'Escape'},
    {key: 'home', title: 'Home', subtitle: 'Opens the library, or closes it from wherever in it you are'},
    {key: 'page-previous', title: 'Previous page', subtitle: 'Turns a library back a page'},
    {key: 'page-next', title: 'Next page', subtitle: 'Turns a library on a page'},
    {key: 'watched', title: 'Mark watched', subtitle: 'Ticks the highlighted episode or film on or off'},
];

// Never offered for binding: these already do the job everywhere.
export const NATIVE_KEYS = [
    'Up', 'Down', 'Left', 'Right', 'Return', 'KP_Enter', 'ISO_Enter', 'space',
    'Escape', 'Tab', 'ISO_Left_Tab',
];

// Linux input codes for a pad libmanette maps. Face buttons are by position, as
// the kernel's gamepad spec has them (307 top, 308 left: Y and X on an Xbox pad).
export const PAD_BUTTONS = {
    304: 'A', 305: 'B', 307: 'Y', 308: 'X',
    310: 'LB', 311: 'RB', 312: 'LT', 313: 'RT',
    314: 'View', 315: 'Menu', 316: 'Guide',
    317: 'Left stick press', 318: 'Right stick press',
    544: 'D-pad up', 545: 'D-pad down', 546: 'D-pad left', 547: 'D-pad right',
};

export const PAD_AXES = {
    0: ['Left stick left', 'Left stick right'],
    1: ['Left stick up', 'Left stick down'],
    3: ['Right stick left', 'Right stick right'],
    4: ['Right stick up', 'Right stick down'],
    16: ['D-pad left', 'D-pad right'],
    17: ['D-pad up', 'D-pad down'],
};

export function padLabel(input) {
    const [kind, code] = input.split(':');
    const number = parseInt(code);
    if (kind === 'button')
        return PAD_BUTTONS[number] ?? `Button ${number}`;
    const [minus, plus] = PAD_AXES[number] ?? [`Axis ${number} −`, `Axis ${number} +`];
    return code.endsWith('-') ? minus : plus;
}
