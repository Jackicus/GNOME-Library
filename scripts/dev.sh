#!/usr/bin/env bash
#
# Build, install and check this extension.
#
#   ./scripts/dev.sh link [--no-enable]
#                               link src/ into the extensions directory (development
#                               mode: the entry point is scripts/dev-extension.js) and
#                               enable it in the running shell; --no-enable leaves the
#                               running shell alone
#   ./scripts/dev.sh install    copy what ships into the extensions directory and enable it
#   ./scripts/dev.sh reload     recompile the schema and disable/enable the extension in
#                               the running shell (the user's session: theirs to run)
#   ./scripts/dev.sh logs [SINCE]
#                               the extension's lines in the journal, the preferences'
#                               included; follows, or with SINCE ('5 min ago', 'today')
#                               prints what is there and exits
#   ./scripts/dev.sh pack       build dist/<uuid>.shell-extension.zip for
#                               extensions.gnome.org, holding exactly what ships
#   ./scripts/dev.sh schema     the schema compiled as an install compiles it (--strict),
#                               writing nothing
#   ./scripts/dev.sh check      everything that needs no shell besides ESLint: the schema,
#                               then this extension's own checks (EXT_CHECKS); what
#                               'make check' runs after 'make lint', and what CI runs
#   ./scripts/dev.sh status     what is installed, and its state in the running shell
#   ./scripts/dev.sh uninstall  remove the extension
#   ./scripts/dev.sh clean      remove dist/, and the compiled schema unless a link
#                               install reads it
#
# Copied from the GNOME-EXTENSIONS kit (template/scripts/dev.sh) by its
# scripts/sync.sh: change it there. What is particular to this extension is in
# scripts/ext.conf, and its own commands are in scripts/dev.d/*.sh.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$REPO_DIR/scripts/dev.sh"
SRC_DIR="$REPO_DIR/src"
DIST_DIR="$REPO_DIR/dist"

info()  { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()    { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$REPO_DIR/scripts/ext.conf" ]] || die "scripts/ext.conf is missing: it names this extension for the kit's scripts."
EXT_SHIP=("lib:*.js")
EXT_CHECKS=()
# shellcheck source=/dev/null
source "$REPO_DIR/scripts/ext.conf"
: "${EXT_UUID:?scripts/ext.conf sets EXT_UUID}" "${EXT_NAME:?scripts/ext.conf sets EXT_NAME}"
EXT_SLUG="${EXT_SLUG:-${EXT_UUID%@*}}"
EXT_LOG_PREFIX="${EXT_LOG_PREFIX:-[$EXT_NAME]}"
EXT_DIR="$HOME/.local/share/gnome-shell/extensions/$EXT_UUID"

require() {
    command -v "$1" >/dev/null 2>&1 || die "'$1' not found in PATH."
}

compile_schemas() {
    require glib-compile-schemas
    glib-compile-schemas "$SRC_DIR/schemas" || die "The schema does not compile."
}

# An install compiles the schema with --strict, so a warning here is a failed
# install there. --dry-run writes nothing.
cmd_schema() {
    require glib-compile-schemas
    glib-compile-schemas --strict --dry-run "$SRC_DIR/schemas" || die "The schema does not pass --strict."
    ok "The schema compiles with --strict."
}

cmd_check() {
    cmd_schema
    local check
    for check in "${EXT_CHECKS[@]}"; do
        declare -F "cmd_${check//-/_}" >/dev/null || die "EXT_CHECKS names '$check', which no scripts/dev.d file defines."
        "cmd_${check//-/_}"
    done
}

# What dev-extension.js builds, and the prefix it logs with.
cmd_dev_config() {
    python3 -c 'import json, sys; print(json.dumps({"appClass": sys.argv[1] or None, "logPrefix": sys.argv[2]}))' \
        "${EXT_APP_CLASS:-}" "$EXT_LOG_PREFIX"
}

# Copies what ships into DIR: the entry points, metadata, stylesheet and schema
# XML that are there, every file EXT_SHIP names (DIR:PATTERN under src/), and
# the licence. Nothing else, whatever else is under src/.
stage_ship() {
    local dest="$1" name entry dir pattern file
    mkdir -p "$dest/schemas"
    for name in extension.js prefs.js metadata.json stylesheet.css; do
        [[ -f "$SRC_DIR/$name" ]] && cp "$SRC_DIR/$name" "$dest/"
    done
    cp "$SRC_DIR"/schemas/*.gschema.xml "$dest/schemas/"
    for entry in "${EXT_SHIP[@]}"; do
        dir="${entry%%:*}"; pattern="${entry#*:}"
        [[ -d "$SRC_DIR/$dir" ]] || die "EXT_SHIP names src/$dir, which does not exist."
        while IFS= read -r -d '' file; do
            mkdir -p "$dest/$(dirname "$file")"
            cp "$SRC_DIR/$file" "$dest/$file"
        done < <(cd "$SRC_DIR" && find "$dir" -type f -name "$pattern" -not -path '*/__pycache__/*' -print0)
    done
    for name in LICENSE COPYING; do
        [[ -f "$REPO_DIR/$name" ]] && { cp "$REPO_DIR/$name" "$dest/"; break; }
    done
    return 0
}

remove_installed() {
    # -e misses a symlink whose target is gone, so test -L as well.
    if [[ -e "$EXT_DIR" || -L "$EXT_DIR" ]]; then
        rm -rf "$EXT_DIR"
    fi
}

is_enabled() {
    gnome-extensions list --enabled 2>/dev/null | grep -qx "$EXT_UUID"
}

# The extension directory as links into src/, except its entry point, which is
# scripts/dev-extension.js, and dev-extension.json beside it.
link_tree() {
    mkdir -p "$EXT_DIR"
    local entry
    for entry in "$SRC_DIR"/*; do
        [[ "$(basename "$entry")" == extension.js ]] && continue
        ln -s "$entry" "$EXT_DIR/$(basename "$entry")"
    done
    ln -s "$REPO_DIR/scripts/dev-extension.js" "$EXT_DIR/extension.js"
    cmd_dev_config > "$EXT_DIR/dev-extension.json"
}

# --no-enable leaves the running shell alone: what nested.sh start uses, so a
# nested session never enables (or reloads) the extension in the real one.
cmd_link() {
    compile_schemas
    remove_installed
    link_tree
    ok "Linked $EXT_DIR → $SRC_DIR (entry point: scripts/dev-extension.js)"
    [[ "${1:-}" == --no-enable ]] && return 0
    warn "Development mode: edits in src/ are live after './scripts/dev.sh reload'."
    enable_extension
}

cmd_install() {
    remove_installed
    stage_ship "$EXT_DIR"
    glib-compile-schemas "$EXT_DIR/schemas" || die "The schema does not compile."
    ok "Installed to $EXT_DIR"
    enable_extension
}

enable_extension() {
    require gnome-extensions
    if is_enabled; then
        cmd_reload
    else
        info "Enabling $EXT_UUID..."
        if gnome-extensions enable "$EXT_UUID" 2>/dev/null; then
            ok "Enabled."
        else
            warn "The running GNOME Shell does not know about $EXT_UUID yet."
            warn "Log out and back in, then: gnome-extensions enable $EXT_UUID"
        fi
    fi
}

# Poll until the shell reports STATE, up to about 6 seconds.
wait_for_state() {
    local tries=0
    while (( tries < 60 )); do
        [[ "$(gnome-extensions info "$EXT_UUID" 2>/dev/null | sed -n 's/^ *State: *//p')" == "$1" ]] && return 0
        sleep 0.1
        tries=$((tries + 1))
    done
    return 1
}

cmd_reload() {
    require gnome-extensions
    compile_schemas
    info "Reloading $EXT_UUID..."
    gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
    # The shell applies a disable asynchronously; an enable before it lands is a
    # silent no-op that leaves the extension INACTIVE with nothing in the log.
    wait_for_state INACTIVE || warn "The extension did not report INACTIVE; enabling anyway."
    gnome-extensions enable "$EXT_UUID"
    if wait_for_state ACTIVE; then
        ok "Reloaded."
    else
        warn "Enabled but not ACTIVE. Check './scripts/dev.sh logs' for a JS error."
        return 1
    fi
}

# The shell's lines and the preferences' (their own process), filtered on the
# extension's prefix. With SINCE, what is there; without, follow.
cmd_logs() {
    require journalctl
    local match=(/usr/bin/gnome-shell + SYSLOG_IDENTIFIER=org.gnome.Shell.Extensions)
    if [[ -n "${1:-}" ]]; then
        info "$EXT_NAME log output since '$1':"
        journalctl -o cat --since "$1" "${match[@]}" 2>/dev/null \
            | grep -F -- "$EXT_LOG_PREFIX" || info "(nothing logged in that window)"
    else
        info "Following the shell's log for $EXT_LOG_PREFIX (Ctrl+C to stop)..."
        journalctl -f -o cat "${match[@]}" | grep --line-buffered -F -- "$EXT_LOG_PREFIX"
    fi
}

# The zip for extensions.gnome.org, packed from a staged copy of exactly what
# ships, then checked against that list: a stray file fails here, not in review.
cmd_pack() {
    require gnome-extensions
    require unzip
    local zip="$DIST_DIR/$EXT_UUID.shell-extension.zip" stage entry extra=()
    cmd_schema
    stage="$(mktemp -d)"
    # shellcheck disable=SC2064  # expanded now, on purpose
    trap "rm -rf '$stage'" EXIT
    stage_ship "$stage"
    for entry in "$stage"/*; do
        case "$(basename "$entry")" in
            extension.js|prefs.js|metadata.json|stylesheet.css|schemas) ;;
            *) extra+=(--extra-source="$entry") ;;
        esac
    done
    mkdir -p "$DIST_DIR"
    info "Packing $EXT_UUID..."
    gnome-extensions pack "$stage" "${extra[@]}" --out-dir="$DIST_DIR" --force \
        || die "gnome-extensions pack failed."
    # gnome-extensions 45 and older still compile the schema into the bundle;
    # GNOME 44 and later compile it on install.
    if unzip -Z1 "$zip" | grep -qx 'schemas/gschemas.compiled'; then
        require zip
        zip -qd "$zip" schemas/gschemas.compiled
    fi

    local expected actual missing stray
    expected="$(cd "$stage" && find . -type f | sed 's|^\./||' | sort)"
    actual="$(unzip -Z1 "$zip" | grep -v '/$' | sort)"
    missing="$(comm -23 <(echo "$expected") <(echo "$actual"))"
    stray="$(comm -13 <(echo "$expected") <(echo "$actual"))"
    [[ -z "$missing" ]] || die "Missing from the zip:"$'\n'"$missing"
    [[ -z "$stray" ]] || die "Should not be in the zip:"$'\n'"$stray"
    unzip -l "$zip"
    ok "Packed $zip: exactly the $(wc -l <<<"$expected") files that ship."
}

cmd_uninstall() {
    remove_installed
    ok "Removed $EXT_DIR"
}

# Whether the installed extension reads its schema from this src/: a link install.
linked_here() {
    [[ "$(readlink -f "$EXT_DIR/schemas" 2>/dev/null)" == "$(readlink -f "$SRC_DIR/schemas")" ]]
}

cmd_clean() {
    rm -rf "$DIST_DIR"
    if linked_here; then
        ok "Removed dist/; kept the compiled schema, which the link install at $EXT_DIR reads."
    else
        rm -f "$SRC_DIR/schemas/gschemas.compiled"
        ok "Removed dist/ and the compiled schema."
    fi
}

cmd_status() {
    if [[ -L "$EXT_DIR/extension.js" ]]; then
        echo "install:  link → $(dirname "$(readlink -f "$EXT_DIR/metadata.json")") (entry point: $(readlink -f "$EXT_DIR/extension.js"))"
        [[ -f "$EXT_DIR/dev-extension.json" ]] || echo "          made before dev-extension.json: 'make link' again"
    elif [[ -L "$EXT_DIR" ]]; then
        echo "install:  old-style symlink → $(readlink -f "$EXT_DIR") ('make link' again)"
    elif [[ -d "$EXT_DIR" ]]; then
        echo "install:  copy at $EXT_DIR"
    else
        echo "install:  not installed"
    fi
    if command -v gnome-extensions >/dev/null 2>&1; then
        local state
        state="$(gnome-extensions info "$EXT_UUID" 2>/dev/null | sed -n 's/^ *State: *//p' || true)"
        echo "state:    ${state:-unknown to the running shell (log out and back in)}"
    fi
    if declare -F dev_status >/dev/null; then dev_status; fi
    return 0
}

# The command lines of a script's header (each "#   ./scripts/..." line and the
# lines under it), leaving out the commands named after the file.
help_of() {
    local file="$1"; shift
    awk -v skip=" $* " '
        NR == 1 && /^#!/ { next }
        !/^#/ { exit }
        /^#   \.\/scripts\// { split($0, w, " "); keep = index(skip, " " w[3] " ") == 0 }
        /^#   / && keep { sub(/^# ?/, ""); print; next }
        !/^#   / { keep = 0 }
    ' "$file"
}

usage() {
    local file overridden
    overridden="$( (cat "$REPO_DIR"/scripts/dev.d/*.sh 2>/dev/null || true) | sed -n 's/^cmd_\([a-z_]*\)().*/\1/p' | tr _ - | tr '\n' ' ')"
    # shellcheck disable=SC2086  # a list of words
    help_of "$SELF" $overridden
    for file in "$REPO_DIR"/scripts/dev.d/*.sh; do
        [[ -f "$file" ]] || continue
        help_of "$file"
    done
    return 0
}

# This extension's own commands (cmd_NAME, run as 'dev.sh NAME') and the
# dev_status hook. A cmd_ defined there replaces the one above of the same name.
for extra in "$REPO_DIR"/scripts/dev.d/*.sh; do
    [[ -f "$extra" ]] || continue
    # shellcheck source=/dev/null
    source "$extra"
done

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    ""|-h|--help|help) usage ;;
    *)
        if [[ "$cmd" =~ ^[a-z][a-z0-9-]*$ ]] && declare -F "cmd_${cmd//-/_}" >/dev/null; then
            "cmd_${cmd//-/_}" "$@"
        else
            die "Unknown command '$cmd'. Run './scripts/dev.sh help'."
        fi
        ;;
esac
