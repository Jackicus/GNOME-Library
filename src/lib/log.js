// Progress lines, turned on by the development entry point only.

let verbose = false;

export function setVerbose(on) {
    verbose = on;
}

export function note(message) {
    if (verbose)
        console.log(`[Library] ${message}`);
}
