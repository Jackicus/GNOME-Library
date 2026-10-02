# Library's own dev.sh commands, sourced by the kit's scripts/dev.sh.
#
#   ./scripts/dev.sh scan [ARGS]
#                               scan every enabled section into the real cache, with
#                               the user's own settings and keys (theirs to run); extra
#                               arguments pass through, e.g. --only films --force
#   ./scripts/dev.sh prune      remove superseded builds, keeping the current one
#   ./scripts/dev.sh uninstall  remove the extension, and the superseded builds prune
#                               removes
#   ./scripts/dev.sh stalls [LOG]
#                               watch for desktop freezes: shell main-loop stalls,
#                               processes stuck in the kernel and automount triggers,
#                               with timestamps (default log: dist/stalls.log)
#   ./scripts/dev.sh scanner    the scanner's whole import graph, offline in a scratch
#                               home, and the Python scripts byte-compiled; one of
#                               'check's
#   ./scripts/dev.sh import-settings [--force]
#                               carry Video Library's and Games Library's settings,
#                               cache and watched marks into Library's (the owner's own
#                               session, once; scripts/import_settings.py says what)
#
# 'status' adds the cache and the library's size per section.

# Append to this on each rename so 'prune' sweeps up every superseded build.
LEGACY_UUIDS=("gnomeflix@jackt" "media-workspace-desktop@jackt" "media-libraries@jackt"
    "video-library@jackicus" "games-library@jackicus")
# As GLib.get_user_cache_dir() resolves it in the extension.
CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/library@jackicus"

# Scan every enabled section. The scanner reads the preferences itself, so
# nothing here or in the preferences' Rescan buttons turns settings into flags.
# Extra arguments are passed straight through, e.g. '--only films' or '--force'.
cmd_scan() {
    require gjs
    compile_schemas
    # The API keys are read straight out of the preferences by the scanner, so
    # no key ever reaches a command line.
    gjs -m "$SRC_DIR/backend/scanLibrary.js" "$@"
}

# Remove superseded builds of this extension, leaving the current one alone.
cmd_prune() {
    local root found=0 legacy
    root="$(dirname "$EXT_DIR")"
    for legacy in "${LEGACY_UUIDS[@]}"; do
        if [[ -e "$root/$legacy" || -L "$root/$legacy" ]]; then
            gnome-extensions disable "$legacy" 2>/dev/null || true
            rm -rf "${root:?}/$legacy"
            ok "Removed stale build $legacy"
            found=1
        fi
    done
    [[ $found -eq 0 ]] && info "No stale builds to remove."
    return 0
}

cmd_uninstall() {
    remove_installed
    ok "Removed $EXT_DIR"
    cmd_prune
}

cmd_import_settings() {
    require python3
    python3 "$REPO_DIR/scripts/import_settings.py" "$@"
}

# A freeze is over by the time anyone looks; this leaves a log of what stalled.
cmd_stalls() {
    require python3
    info "Watching for freezes (Ctrl+C to stop); reproduce one, then read the log."
    python3 "$REPO_DIR/scripts/stallwatch.py" "$@"
}

# What 'check' runs after the schema, with no shell, display or network: the
# scanner's whole import graph (its --help exits before it reads a setting or
# touches the cache, and it runs in a scratch home with in-memory settings
# besides), and the Python scripts byte-compiled where nothing is written into
# the tree.
cmd_scanner() {
    require gjs
    require python3
    local scratch
    scratch="$(mktemp -d)"
    info "Scanner imports (gjs -m src/backend/scanLibrary.js --help)..."
    if ! env HOME="$scratch" XDG_CACHE_HOME="$scratch/.cache" XDG_CONFIG_HOME="$scratch/.config" \
            XDG_DATA_HOME="$scratch/.local/share" GSETTINGS_BACKEND=memory \
            gjs -m "$SRC_DIR/backend/scanLibrary.js" --help >/dev/null; then
        rm -rf "$scratch"
        die "The scanner does not load."
    fi
    rm -rf "$scratch"
    info "Python scripts..."
    python3 - "$REPO_DIR"/scripts/*.py <<'PY'
import sys
for path in sys.argv[1:]:
    with open(path, encoding='utf-8') as f:
        compile(f.read(), path, 'exec')
PY
    ok "Scanner imports and scripts check out."
}

# The real session's cache, and how many items each section holds.
dev_status() {
    echo "cache:    $CACHE_DIR$([[ -d "$CACHE_DIR" ]] || echo ' (absent)')"
    if [[ -f "$CACHE_DIR/library.json" ]]; then
        # Read through the extension's own reader rather than restating how
        # the file is shaped a second time.
        echo "library:  $(gjs -c 'import(imports.gi.GLib.filename_to_uri(ARGV[0], null)).then(
            ({readSections}) => print(Object.entries(readSections().sections)
                .map(([k, v]) => `${Array.isArray(v) ? v.length : 0} ${k}`).join(", ") || "empty"),
            () => print("unreadable"))' \
            "$SRC_DIR/lib/library.js" 2>/dev/null || echo 'unreadable')"
    else
        echo "library:  not scanned yet"
    fi
}
