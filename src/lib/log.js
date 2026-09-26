// Lines that say what the extension is doing, such as a rebuild after a
// rescan. The shipped extension logs only failures; the development entry
// point, scripts/dev-extension.js, turns these on.

let verbose = false;

export function setVerbose(on) {
    verbose = on;
}

export function note(message) {
    if (verbose)
        console.log(`[Media Libraries] ${message}`);
}
