#!/usr/bin/env bash
#
# Drive a throwaway nested GNOME Shell with this extension in it.
#
#   ./scripts/nested.sh start [--headless] [--clean] [--stand-in] [--monitors N] [WxH]
#                                     start a nested shell (default 1600x900, one
#                                     monitor) with the extension ACTIVE, mirrored live
#                                     in a window on the real desktop unless --headless.
#                                     --clean resets its settings to their defaults
#                                     first; --stand-in (or --demo) runs it over
#                                     stand-in data, for screenshots
#   ./scripts/nested.sh reload        disable and enable the extension inside it,
#                                     picking up every edit under src/
#   ./scripts/nested.sh do "STEP" "STEP"...
#                                     several steps over one connection: say TEXT |
#                                     click X Y | move X Y | scroll X Y up|down [N] |
#                                     key KEYSYM | wait SECS | shot [FILE [X Y W H]] |
#                                     window FILE | overview on|off
#   ./scripts/nested.sh say|shot|click|move|scroll|key|overview ...
#                                     one step of the same
#   ./scripts/nested.sh preview       start if needed and screenshot it to dist/preview.png
#   ./scripts/nested.sh mirror on|off open or close the live mirror window
#   ./scripts/nested.sh run CMD...    run CMD against the nested session (its bus, its
#                                     display, its settings), never the real desktop's
#   ./scripts/nested.sh logs [N] [--all]
#                                     the last N lines of its output, D-Bus chatter
#                                     filtered out unless --all
#   ./scripts/nested.sh status        whether it runs, and as what
#   ./scripts/nested.sh stop          close the mirror, stop the shell and everything
#                                     of its session, remove what it made, and say if
#                                     anything survived
#
# Copied from the GNOME-EXTENSIONS kit (template/scripts/nested.sh) by its
# scripts/sync.sh: change it there. What is particular to this extension is in
# scripts/ext.conf, and its own commands and hooks are in scripts/nested.d/*.sh.
#
# The nested shell is a second GNOME Shell with its own session bus and Wayland
# display. It always runs headless (mutter has no windowed backend here); the
# mirror is a screencast of its virtual monitor, played on the real desktop
# through PipeWire, which both sessions share.
#
# Its settings are its own, never the real session's. GSettings uses the keyfile
# backend in an XDG_CONFIG_HOME of its own, kept between starts under
# ~/.local/state/gnome-extensions-nested/<slug>/ and reset by --clean, so the
# real dconf database is never opened, by the shell, its preferences window or
# 'run gsettings'. A new one starts with only this extension enabled and the real
# session's look (colour scheme, accent, fonts) copied in; under --stand-in, the
# stock look instead.
#
# --stand-in photographs a stand-in world, for pictures that go into a public
# repository: HOME is a scratch directory under the run directory, holding a
# copy of this checkout's src/ as the extension (nested_stand_in_stage may
# adjust it, at every stage) and whatever the repository's nested_stand_in hook
# puts there once per start (a demo library, stand-in logins); PATH is the
# system's only; settings start fresh, in GNOME's stock look. Commands named in
# EXT_STAND_IN_BINS are stand-ins overlaid on /usr/bin, in a user and mount
# namespace of the session's own. Variables named in EXT_STAND_IN_UNSET (one
# that points the extension at a real login, say) are removed from the
# session's environment, which otherwise is the caller's.
#
# Nothing is left behind: a shell started from a Claude Code session stops
# itself after NESTED_IDLE seconds (default 600, 0 = never) without a command
# here, and when that session ends (the SessionEnd hook runs 'session-end').
# Every name this script uses is this extension's own (run directory, Wayland
# display, settings), so the nested shells of several extensions can run at
# once without touching each other.
#
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SELF="$REPO_DIR/scripts/nested.sh"
DRIVER="$REPO_DIR/scripts/nested_driver.py"

info() { printf '\033[1;34m→\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

[[ -f "$REPO_DIR/scripts/ext.conf" ]] || die "scripts/ext.conf is missing: it names this extension for the kit's scripts."
EXT_STAND_IN_BINS=()
EXT_STAND_IN_UNSET=()
NESTED_STRAYS=()
# shellcheck source=/dev/null
source "$REPO_DIR/scripts/ext.conf"
: "${EXT_UUID:?scripts/ext.conf sets EXT_UUID}" "${EXT_NAME:?scripts/ext.conf sets EXT_NAME}"
EXT_SLUG="${EXT_SLUG:-${EXT_UUID%@*}}"

RUNTIME="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"
RUN_DIR="$RUNTIME/$EXT_SLUG-nested"
BUS_FILE="$RUN_DIR/bus"
PID_FILE="$RUN_DIR/pid"
LOG_FILE="$RUN_DIR/log"
GEOM_FILE="$RUN_DIR/geometry"
MODE_FILE="$RUN_DIR/mode"
X11_FILE="$RUN_DIR/x11-display"
XAUTH_FILE="$RUN_DIR/x11-auth"
SHELL_PID_FILE="$RUN_DIR/shell-pid"
MIRROR_PID_FILE="$RUN_DIR/mirror-pid"
MIRROR_LOG="$RUN_DIR/mirror-log"
WATCH_PID_FILE="$RUN_DIR/watchdog-pid"
ACTIVITY_FILE="$RUN_DIR/activity"
OWNER_FILE="$RUN_DIR/owner-session"
IDLE_FILE="$RUN_DIR/idle-seconds"
GUARD_OWNED_FILE="$RUN_DIR/owns-crash-guard"
# A profile with no database: anything that talks to dconf directly, rather
# than through GSettings, reads nothing and writes nowhere.
DCONF_NONE="$RUN_DIR/dconf-none"
# The nested session's own settings, kept between starts; --clean removes them.
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/gnome-extensions-nested/$EXT_SLUG"
KEPT_CONFIG="$STATE_DIR/config"
# Under --stand-in, everything of the session's own is under the run directory.
STAND_IN_DIR="$RUN_DIR/stand-in"
STAND_IN_HOME="$STAND_IN_DIR/home"
STAND_IN_BINS="$RUNTIME/$EXT_SLUG-stand-in-bin"
STAGE_DIR="$STAND_IN_HOME/.local/share/gnome-shell/extensions/$EXT_UUID"
WL_DISPLAY="$EXT_SLUG-dev"
# The shell, and the launchers it runs under, by the arguments they carry:
# anchored to those programs, so a command line that merely mentions the
# display (a grep, an agent's shell) is never taken for part of the session.
SESSION_PATTERN="^(gnome-shell|dbus-run-session|unshare) .*--wayland-display $WL_DISPLAY( |\$)"
# GNOME Shell creates this for its first 60 s; if the shell crashes while it
# exists, the systemd unit disables every extension. The nested shell shares the
# runtime dir, so it creates the REAL session's copy, and a stop inside those
# 60 s would leave it behind, armed for the user's next real crash. Whichever
# shell found it absent owns it, and only the owner's stop removes it.
CRASH_GUARD="$RUNTIME/gnome-shell-disable-extensions"
IDLE_SECS="${NESTED_IDLE:-600}"
# The real session's display and bus, captured before nested_env overrides them:
# the mirror window opens on the desktop the user is looking at.
HOST_WAYLAND_DISPLAY="${WAYLAND_DISPLAY:-wayland-0}"
HOST_BUS="${DBUS_SESSION_BUS_ADDRESS:-unix:path=$RUNTIME/bus}"

pid_alive() {
    [[ -f "$1" ]] || return 1
    local pid
    pid="$(cat "$1" 2>/dev/null)" || return 1
    [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

is_running()     { pid_alive "$PID_FILE"; }
mirror_running() { pid_alive "$MIRROR_PID_FILE"; }
stand_in()       { [[ "$(cat "$MODE_FILE" 2>/dev/null)" == stand-in ]]; }

require_running() {
    is_running || die "No nested shell running. Start one with: ./scripts/nested.sh start"
}

nested_bus() {
    [[ -s "$BUS_FILE" ]] || die "Nested shell has no session bus address yet."
    cat "$BUS_FILE"
}

config_dir() {
    if stand_in; then echo "$STAND_IN_DIR/config"; else echo "$KEPT_CONFIG"; fi
}

# The environment of the nested session: its bus, its displays, its settings,
# and under --stand-in its home, without EXT_STAND_IN_UNSET (env -u
# SESSION_UNSET). DISPLAY is the nested Xwayland's, or unset, never the real
# desktop's.
session_vars() {
    local name
    SESSION_UNSET=()
    SESSION_VARS=(
        XDG_CONFIG_HOME="$(config_dir)" GSETTINGS_BACKEND=keyfile DCONF_PROFILE="$DCONF_NONE"
        WAYLAND_DISPLAY="$WL_DISPLAY"
    )
    if stand_in; then
        for name in "${EXT_STAND_IN_UNSET[@]}"; do SESSION_UNSET+=(-u "$name"); done
        SESSION_VARS+=(
            HOME="$STAND_IN_HOME" PATH=/usr/local/bin:/usr/bin
            XDG_CACHE_HOME="$STAND_IN_HOME/.cache" XDG_DATA_HOME="$STAND_IN_HOME/.local/share"
            XDG_STATE_HOME="$STAND_IN_HOME/.local/state"
        )
    fi
}

nested_env() {
    local x11 xauth
    session_vars
    x11="$(cat "$X11_FILE" 2>/dev/null || true)"
    xauth="$(cat "$XAUTH_FILE" 2>/dev/null || true)"
    if [[ -n "$x11" && -n "$xauth" ]]; then
        env "${SESSION_UNSET[@]}" "${SESSION_VARS[@]}" DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" \
            DISPLAY="$x11" XAUTHORITY="$xauth" "$@"
    else
        env -u DISPLAY "${SESSION_UNSET[@]}" "${SESSION_VARS[@]}" DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" "$@"
    fi
}

# The settings a new nested session starts from: this extension alone enabled,
# and the real session's look, read with gsettings and never written back. With
# "stock" (--stand-in), none of the session's look: GNOME's defaults, whoever
# takes the pictures.
seed_settings() {
    local dir="$1/glib-2.0/settings" look="${2:-own}" key value
    mkdir -p "$dir"
    {
        echo "[org/gnome/shell]"
        echo "enabled-extensions=['$EXT_UUID']"
        echo "disable-user-extensions=false"
        echo "welcome-dialog-last-shown-version='999'"
        if [[ "$look" != stock ]]; then
            echo
            echo "[org/gnome/desktop/interface]"
            for key in color-scheme accent-color gtk-theme icon-theme cursor-theme font-name \
                       document-font-name monospace-font-name text-scaling-factor; do
                value="$(gsettings get org.gnome.desktop.interface "$key" 2>/dev/null)" && echo "$key=$value"
            done
        fi
    } > "$dir/keyfile"
    [[ "$look" == stock ]] && return 0
    # Read-only copies of what the session's look and folders come from; copies,
    # so a write in the nested session stays there.
    local real="${XDG_CONFIG_HOME:-$HOME/.config}" entry
    for entry in user-dirs.dirs user-dirs.locale fontconfig; do
        [[ -e "$real/$entry" ]] && cp -r "$real/$entry" "$1/"
    done
    return 0
}

# Under --stand-in: a scratch home with this checkout's src/ as the extension,
# entered through the development entry point so 'reload' picks up edits. The
# repository's nested_stand_in_stage hook (if any) adjusts that copy of src/
# (a stand-in module in place of a real one); it runs on every stage, 'reload'
# included.
stage_stand_in() {
    rm -rf "$STAGE_DIR"
    mkdir -p "$STAGE_DIR" "$STAND_IN_HOME/.cache" "$STAND_IN_HOME/.local/state"
    cp -r "$REPO_DIR/src/." "$STAGE_DIR/"
    find "$STAGE_DIR" \( -name CLAUDE.md -o -name __pycache__ -o -name gschemas.compiled \) -prune -exec rm -rf {} +
    cp "$REPO_DIR/scripts/dev-extension.js" "$STAGE_DIR/extension.js"
    "$REPO_DIR/scripts/dev.sh" dev-config > "$STAGE_DIR/dev-extension.json"
    glib-compile-schemas "$STAGE_DIR/schemas" || die "The schema does not compile."
    if declare -F nested_stand_in_stage >/dev/null; then
        nested_stand_in_stage "$STAGE_DIR" || die "The staged copy could not be adjusted (nested_stand_in_stage)."
    fi
}

# The repository's stand-in data in the scratch home (a demo library, stand-in
# logins): its nested_stand_in hook, once per start, not on every reload.
make_stand_in_data() {
    if declare -F nested_stand_in >/dev/null; then
        nested_stand_in "$STAND_IN_HOME" "$STAGE_DIR" || die "The stand-in data could not be made (nested_stand_in)."
    fi
}

# Stand-in commands to overlay on /usr/bin: each only ever looked for, never run.
make_stand_in_bins() {
    local cli
    rm -rf "$STAND_IN_BINS"
    mkdir -p "$STAND_IN_BINS"
    for cli in "${EXT_STAND_IN_BINS[@]}"; do
        printf '#!/bin/sh\n# A stand-in, for screenshots.\nexit 0\n' > "$STAND_IN_BINS/$cli"
        chmod +x "$STAND_IN_BINS/$cli"
    done
}

geometry() { cat "$GEOM_FILE" 2>/dev/null || echo '1600x900'; }

driver() {
    nested_env NESTED_GEOMETRY="$(geometry)" NESTED_RUN_DIR="$RUN_DIR" \
        NESTED_SHOT_DIR="$REPO_DIR/dist" python3 "$DRIVER" "$@"
}

nested_state() {
    nested_env gnome-extensions info "$EXT_UUID" 2>/dev/null | sed -n 's/^ *State: *//p'
}

# Poll until the extension reaches STATE, up to about 6 seconds.
wait_state() {
    local tries=0
    while [[ "$(nested_state)" != "$1" ]] && (( tries < 60 )); do
        sleep 0.1
        tries=$((tries + 1))
    done
    [[ "$(nested_state)" == "$1" ]]
}

touch_activity() {
    if [[ -d "$RUN_DIR" ]]; then touch "$ACTIVITY_FILE" 2>/dev/null || true; fi
}

# The nested mutter's own X11 display (Xwayland, started on demand), found from
# the listening socket it holds, and the cookie X11 clients need for it: the
# newest $XDG_RUNTIME_DIR/.mutter-Xwaylandauth.* not older than this run. The
# shell's pid is kept too: it is what its X11 locks hold.
record_x11() {
    local shell_pid display newest
    shell_pid="$(pgrep -f -- "^gnome-shell .*--wayland-display $WL_DISPLAY( |\$)" | head -1 || true)"
    [[ -n "$shell_pid" ]] || return 0
    echo "$shell_pid" > "$SHELL_PID_FILE"
    display="$({ ss -xlp 2>/dev/null | grep -F "pid=$shell_pid," | grep -oE '/tmp/\.X11-unix/X[0-9]+' \
        | head -1 | sed 's|.*/X|:|'; } || true)"
    newest="$(find "$RUNTIME" -maxdepth 1 -name '.mutter-Xwaylandauth.*' -newer "$GEOM_FILE" -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2- || true)"
    echo "$display" > "$X11_FILE"
    echo "$newest" > "$XAUTH_FILE"
}

cmd_start() {
    # Mirrored by default: the point of driving the extension is that the user
    # can see what is being tried.
    local mirror=1 clean=0 standin=0 monitors=1 geometry=1600x900
    while (( $# )); do
        case "$1" in
            --headless|--no-mirror) mirror=0 ;;
            --mirror) mirror=1 ;;
            --clean) clean=1 ;;
            --stand-in|--demo) standin=1 ;;
            --monitors) monitors="${2:-}"; shift ;;
            [0-9]*x[0-9]*) geometry="$1" ;;
            *) die "Unknown start option '$1'. Usage: start [--headless] [--clean] [--stand-in] [--monitors N] [WxH]" ;;
        esac
        shift
    done
    [[ "$geometry" =~ ^[0-9]+x[0-9]+$ ]] || die "Geometry must look like 1600x900, got '$geometry'."
    [[ "$monitors" =~ ^[1-9]$ ]] || die "--monitors takes a count from 1 to 9, got '$monitors'."

    if is_running; then
        info "Reusing the nested shell already running (pid $(cat "$PID_FILE"), $(geometry))."
        (( clean )) && warn "Its settings are not reset while it runs: 'stop', then 'start --clean'."
        (( standin )) && ! stand_in && warn "It runs over your own data: 'stop', then 'start --stand-in'."
        (( mirror )) && ! mirror_running && cmd_mirror on
        [[ "$(nested_state)" == "ACTIVE" ]] || enable_in_nested
        return 0
    fi

    command -v gnome-shell >/dev/null || die "'gnome-shell' not found."
    command -v dbus-run-session >/dev/null || die "'dbus-run-session' not found."

    # A crashed or killed run can leave a mirror, a watchdog or a helper behind
    # with no pid file pointing at it; clear those before starting over.
    kill_strays

    # A nested shell discovers UUIDs at its own startup, so the extension is
    # installed first. --no-enable: the link alone, never an enable or a reload
    # of the real shell.
    if (( ! standin )) && [[ ! -e "$HOME/.local/share/gnome-shell/extensions/$EXT_UUID" ]]; then
        warn "$EXT_UUID is not installed; linking it first (as 'make link', without enabling it here)."
        "$REPO_DIR/scripts/dev.sh" link --no-enable >/dev/null 2>&1 || true
    fi

    # A run that died without a 'stop' left its run directory behind, and in it
    # the mark that the crash guard is ours: cleared the way 'stop' clears it.
    remove_run_dir
    mkdir -p "$RUN_DIR"
    : > "$LOG_FILE"
    : > "$DCONF_NONE"
    # The monitors sit side by side, so what the driver and the mirror see is
    # all of them.
    echo "$(( ${geometry%x*} * monitors ))x${geometry#*x}" > "$GEOM_FILE"
    # Only a shell a Claude Code session started is that session's to clean up.
    [[ -n "${CLAUDE_CODE_SESSION_ID:-}" ]] && echo "$CLAUDE_CODE_SESSION_ID" > "$OWNER_FILE"

    if (( standin )); then
        echo stand-in > "$MODE_FILE"
        stage_stand_in
        make_stand_in_data
        seed_settings "$STAND_IN_DIR/config" stock
    else
        echo own > "$MODE_FILE"
        (( clean )) && rm -rf "$KEPT_CONFIG"
        [[ -s "$KEPT_CONFIG/glib-2.0/settings/keyfile" ]] || seed_settings "$KEPT_CONFIG"
    fi

    local mode_args=(--wayland --wayland-display "$WL_DISPLAY" --headless) i
    for (( i = 0; i < monitors; i++ )); do mode_args+=(--virtual-monitor "$geometry"); done
    session_vars
    # shellcheck disable=SC2016  # expanded by the inner shell
    local launch=(env -u DISPLAY "${SESSION_UNSET[@]}" "${SESSION_VARS[@]}" dbus-run-session -- bash -c '
        echo "$DBUS_SESSION_BUS_ADDRESS" > "$1"
        exec gnome-shell "${@:2}"
    ' _ "$BUS_FILE" "${mode_args[@]}")
    if (( standin )) && (( ${#EXT_STAND_IN_BINS[@]} )); then
        unshare --user --map-root-user true 2>/dev/null \
            || die "unshare cannot make a user namespace here; EXT_STAND_IN_BINS needs one."
        make_stand_in_bins
        # Root in a namespace of its own to mount the overlay, then back to the
        # user's own uid and gid, which D-Bus and Wayland check.
        # shellcheck disable=SC2016  # expanded by the inner shell
        launch=(unshare --user --map-root-user --mount -- bash -c '
            mount -t overlay nested-stand-in -o "lowerdir=$1:/usr/bin" /usr/bin || exit 1
            exec unshare --user --map-user="$2" --map-group="$3" -- "${@:4}"
        ' _ "$STAND_IN_BINS" "$(id -u)" "$(id -g)" "${launch[@]}")
    fi

    # Last before the shell starts, since the shell is what creates the guard.
    [[ -e "$CRASH_GUARD" ]] || touch "$GUARD_OWNED_FILE"

    info "Starting nested GNOME Shell (headless, $monitors x $geometry, $( (( standin )) && echo 'stand-in data' || echo 'its own settings')$( (( clean )) && echo ', reset'))..."
    # setsid: a process group of its own, so 'stop' takes the bus down with it.
    # The bus daemon hands its environment to everything it activates, the
    # preferences window among them.
    setsid "${launch[@]}" >>"$LOG_FILE" 2>&1 < /dev/null &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    local waited=0
    until [[ -s "$BUS_FILE" ]] && nested_env gdbus call --session \
            --dest org.gnome.Shell --object-path /org/gnome/Shell \
            --method org.freedesktop.DBus.Peer.Ping >/dev/null 2>&1; do
        if ! kill -0 "$pid" 2>/dev/null; then
            warn "Nested shell exited during startup. Last output:"
            filtered_log 20 >&2
            stop_session "" >/dev/null || true
            return 1
        fi
        if (( waited >= 200 )); then
            warn "Nested shell did not answer on D-Bus within 20s. Last output:"
            filtered_log 20 >&2
            stop_session "" >/dev/null || true
            return 1
        fi
        sleep 0.1
        waited=$((waited + 1))
    done
    ok "Nested shell up (pid $pid)."
    # The backstops from here on, so a start that fails below is still stopped
    # when idle or gone.
    touch_activity
    start_watchdog "$pid"
    record_x11

    # The shell enables what its settings list: this extension, unless it was
    # disabled in an earlier run, which the kept settings remember.
    if nested_env gsettings get org.gnome.shell enabled-extensions 2>/dev/null | grep -qF "'$EXT_UUID'"; then
        wait_state ACTIVE \
            || die "$EXT_NAME is $(nested_state) after startup -- check './scripts/nested.sh logs' for a JS error."
        ok "$EXT_NAME ACTIVE."
    else
        enable_in_nested
    fi
    if declare -F nested_started >/dev/null; then nested_started; fi
    (( mirror )) && cmd_mirror on
    return 0
}

enable_in_nested() {
    nested_env gnome-extensions enable "$EXT_UUID" 2>/dev/null || die "Could not enable $EXT_UUID in the nested shell."
    wait_state ACTIVE \
        || die "Enabled but $(nested_state) -- check './scripts/nested.sh logs' for a JS error."
    ok "$EXT_NAME ACTIVE."
}

# Stops the nested shell after IDLE_SECS without a command, and cleans up (the
# mirror above all) if the shell dies on its own. Only for shells a Claude Code
# session started: a person watching the mirror sends no commands.
start_watchdog() {
    [[ -s "$OWNER_FILE" ]] || return 0
    [[ "$IDLE_SECS" =~ ^[0-9]+$ ]] || IDLE_SECS=600
    echo "$IDLE_SECS" > "$IDLE_FILE"
    # shellcheck disable=SC2016  # expanded by the inner shell
    setsid bash -c '
        self=$1 activity=$2 idle=$3 shell_pid=$4
        while kill -0 "$shell_pid" 2>/dev/null; do
            sleep 5
            [[ -f "$activity" ]] || exit 0
            if (( idle > 0 )); then
                age=$(( $(date +%s) - $(stat -c %Y "$activity" 2>/dev/null || date +%s) ))
                (( age >= idle )) && exec "$self" stop --idle
            fi
        done
        exec "$self" stop
    ' _ "$SELF" "$ACTIVITY_FILE" "$IDLE_SECS" "$1" >/dev/null 2>&1 < /dev/null &
    echo $! > "$WATCH_PID_FILE"
}

# Every process of the nested session, its process group or not: anything D-Bus
# activated or started with 'run' (a preferences window, a player) carries the
# nested bus address or display name in its environment.
all_session_pids() {
    local bus="" pid env
    bus="$(cat "$BUS_FILE" 2>/dev/null || true)"
    for env in /proc/[0-9]*/environ; do
        pid="${env#/proc/}"; pid="${pid%/environ}"
        [[ "$pid" == "$$" || "$pid" == "$BASHPID" ]] && continue
        [[ -r "$env" ]] || continue
        if { [[ -n "$bus" ]] && grep -qaF "DBUS_SESSION_BUS_ADDRESS=$bus" "$env" 2>/dev/null; } \
            || grep -qaF "WAYLAND_DISPLAY=$WL_DISPLAY" "$env" 2>/dev/null; then
            echo "$pid"
        fi
    done
    pgrep -f -- "$SESSION_PATTERN" 2>/dev/null || true
}

# session_pids [GROUP]: all of them, or all but those in process group GROUP.
session_pids() {
    local pid
    if [[ -n "${1:-}" ]]; then
        all_session_pids | while read -r pid; do
            [[ "$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')" == "$1" ]] || echo "$pid"
        done
    else
        all_session_pids
    fi
}

# Anything of ours that outlived its pid file: mirror streams, watchdogs and the
# helpers in NESTED_STRAYS. Matched by this repository's own paths, so another
# extension's are left alone.
kill_strays() {
    local pid pattern patterns=("$DRIVER stream" "_ $SELF $ACTIVITY_FILE" "${NESTED_STRAYS[@]}")
    for pattern in "${patterns[@]}"; do
        for pid in $(pgrep -f -- "$pattern" 2>/dev/null); do
            [[ "$pid" == "$$" ]] && continue
            kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        done
    done
}

# TERM everything in the session, give it a moment, KILL what is left, and fail
# if anything still survives.
sweep_session() {
    local pids waited=0
    pids="$(session_pids "${1:-}" | sort -u | tr '\n' ' ')"
    [[ -z "${pids// }" ]] && return 0
    # shellcheck disable=SC2086
    kill -TERM $pids 2>/dev/null || true
    while (( waited < 30 )); do
        pids="$(for p in $pids; do kill -0 "$p" 2>/dev/null && echo "$p"; done | tr '\n' ' ')"
        [[ -z "${pids// }" ]] && return 0
        sleep 0.1; waited=$((waited + 1))
    done
    # shellcheck disable=SC2086
    warn "Still running after TERM, sending KILL: $(ps -o pid=,comm= -p "$(echo $pids | tr ' ' ',')" 2>/dev/null | tr -s ' ' | tr '\n' ';')"
    # shellcheck disable=SC2086
    kill -KILL $pids 2>/dev/null || true
    sleep 0.2
    pids="$(for p in $pids; do kill -0 "$p" 2>/dev/null && echo "$p"; done | tr '\n' ' ')"
    [[ -z "${pids// }" ]] || { warn "Could not stop: $pids"; return 1; }
}

cmd_stop() { stop_session "${1:-}"; }

# stop_session [--idle]: everything 'stop' does; --idle when the watchdog calls it.
stop_session() {
    [[ "$1" == "--idle" ]] && info "Idle for $(cat "$IDLE_FILE" 2>/dev/null)s; stopping the nested shell."
    # The watchdog first, so it does not race this stop, unless this stop IS the
    # watchdog, which exec'd into it.
    if pid_alive "$WATCH_PID_FILE"; then
        local wpid
        wpid="$(cat "$WATCH_PID_FILE")"
        [[ "$wpid" != "$$" ]] && { kill -TERM "-$wpid" 2>/dev/null || kill -TERM "$wpid" 2>/dev/null || true; }
    fi
    mirror_running && cmd_mirror off
    if declare -F nested_stopping >/dev/null && is_running; then nested_stopping || true; fi
    # Helpers and preferences windows first, while the bus they hang off is still
    # up to be named in their environment.
    local stranded=0 group
    group="$(cat "$PID_FILE" 2>/dev/null || true)"
    [[ -s "$BUS_FILE" ]] && { sweep_session "${group:-0}" || stranded=1; }
    if is_running; then
        local pid waited=0
        pid="$(cat "$PID_FILE")"
        info "Stopping nested shell (pid $pid)..."
        kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
        while kill -0 "$pid" 2>/dev/null && (( waited < 50 )); do
            sleep 0.1
            waited=$((waited + 1))
        done
        if kill -0 "$pid" 2>/dev/null; then
            warn "Did not exit on TERM; sending KILL."
            kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
        fi
    else
        info "No nested shell running."
    fi
    kill_strays
    sweep_session || stranded=1
    remove_run_dir
    if (( stranded )) || [[ -n "$(session_pids)" ]]; then
        warn "Something of the nested session is still running:"
        ps -o pid=,args= -p "$(session_pids | sort -u | paste -sd,)" 2>/dev/null >&2 || true
        return 1
    fi
    ok "Nested shell stopped; nothing of its session is left running."
}

# The run directory and what it accounts for outside itself: the crash guard
# (only if this run's shell made it), the X11 cookie, socket and lock, the
# Wayland socket and lock, and the stand-in commands. Called once nothing of the
# session runs, or before a start.
remove_run_dir() {
    [[ -e "$GUARD_OWNED_FILE" ]] && rm -f "$CRASH_GUARD"
    [[ -s "$XAUTH_FILE" ]] && rm -f "$(cat "$XAUTH_FILE")"
    # Mutter reserves two X11 displays and locks both with the shell's pid; a
    # shell that was killed leaves the locks and sockets behind. Only those of
    # this run's shell, and only once it is gone.
    local shell_pid lock
    shell_pid="$(cat "$SHELL_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$shell_pid" ]] && ! kill -0 "$shell_pid" 2>/dev/null; then
        # And the lib/ stages dev-extension.js made for it.
        rm -rf "$RUNTIME/$EXT_SLUG/shell-$shell_pid"
        for lock in /tmp/.X[0-9]*-lock; do
            [[ -f "$lock" && "$(tr -dc 0-9 < "$lock")" == "$shell_pid" ]] || continue
            lock="${lock#/tmp/.X}"
            rm -f "/tmp/.X$lock" "/tmp/.X11-unix/X${lock%-lock}"
        done
    fi
    if ! pgrep -f -- "$SESSION_PATTERN" >/dev/null 2>&1; then
        rm -f "$RUNTIME/$WL_DISPLAY" "$RUNTIME/$WL_DISPLAY.lock"
    fi
    rm -rf "$STAND_IN_BINS" "$RUN_DIR"
}

# SessionEnd hook: stop the nested shell only if the ending session started it.
# Reads the hook's JSON from stdin.
cmd_session_end() {
    [[ -s "$OWNER_FILE" ]] || return 0
    local ending
    ending="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("session_id",""))' 2>/dev/null || true)"
    [[ -n "$ending" && "$ending" == "$(cat "$OWNER_FILE")" ]] || return 0
    stop_session "" >/dev/null 2>&1
}

cmd_do() {
    require_running
    [[ $# -gt 0 ]] || die "Usage: ./scripts/nested.sh do \"say Opening it\" \"click 800 450\" \"wait 1\" shot"
    driver batch "$@"
}

cmd_step() {
    require_running
    driver step "$@"
}

# Disable, wait for the disable to land (an enable before it is a silent no-op
# that leaves the extension INACTIVE), enable. The development entry point
# stages lib/ afresh after an edit, so the new code runs.
cmd_reload() {
    require_running
    if stand_in; then
        stage_stand_in
    else
        glib-compile-schemas "$REPO_DIR/src/schemas" || die "The schema does not compile."
    fi
    info "Reloading $EXT_UUID inside the nested shell..."
    nested_env gnome-extensions disable "$EXT_UUID" 2>/dev/null || true
    wait_state INACTIVE || true
    nested_env gnome-extensions enable "$EXT_UUID" || die "Could not enable $EXT_UUID in the nested shell."
    wait_state ACTIVE \
        || die "Enabled but not ACTIVE -- check './scripts/nested.sh logs' for a JS error."
    ok "Reloaded."
}

cmd_preview() {
    is_running || cmd_start --mirror
    local shot="$REPO_DIR/dist/preview.png"
    cmd_do "wait 0.5" "shot $shot" >/dev/null
    ok "Screenshot: $shot"
}

# The live mirror: the driver screencasts the nested monitor to a PipeWire node
# and runs a GStreamer viewer against the REAL desktop that plays it in a window.
# Closing the window ends the cast; 'mirror off', 'stop', or the nested shell
# going away all close the window.
cmd_mirror() {
    case "${1:-}" in
        on)
            require_running
            if mirror_running; then
                info "Mirror already open (pid $(cat "$MIRROR_PID_FILE"))."
                return 0
            fi
            command -v gst-launch-1.0 >/dev/null || die "'gst-launch-1.0' not found; install gstreamer and gst-plugin-pipewire."
            local geom w h waited=0
            geom="$(geometry)"
            w="${geom%x*}"; h="${geom#*x}"
            : > "$MIRROR_LOG"
            # Not through nested_env: a function in the background is a subshell,
            # and $! would be that rather than the stream 'stop' has to find.
            env DBUS_SESSION_BUS_ADDRESS="$(nested_bus)" WAYLAND_DISPLAY="$WL_DISPLAY" \
                setsid python3 "$DRIVER" stream "$w" "$h" \
                env WAYLAND_DISPLAY="$HOST_WAYLAND_DISPLAY" DBUS_SESSION_BUS_ADDRESS="$HOST_BUS" \
                    gst-launch-1.0 -q pipewiresrc path='{node}' ! videoconvert ! autovideosink \
                >>"$MIRROR_LOG" 2>&1 < /dev/null &
            echo $! > "$MIRROR_PID_FILE"
            while (( waited < 50 )) && ! grep -q "pipewire node" "$MIRROR_LOG" 2>/dev/null; do
                if ! mirror_running; then
                    warn "Mirror failed to start:"; tail -5 "$MIRROR_LOG" >&2; rm -f "$MIRROR_PID_FILE"; return 1
                fi
                sleep 0.1; waited=$((waited + 1))
            done
            ok "Mirror window open on the desktop ($geom)."
            ;;
        off)
            if ! mirror_running; then
                rm -f "$MIRROR_PID_FILE"
                return 0
            fi
            local pid waited=0
            pid="$(cat "$MIRROR_PID_FILE")"
            kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
            while kill -0 "$pid" 2>/dev/null && (( waited < 30 )); do
                sleep 0.1; waited=$((waited + 1))
            done
            kill -0 "$pid" 2>/dev/null && { kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true; }
            rm -f "$MIRROR_PID_FILE"
            ok "Mirror closed."
            ;;
        *) die "Usage: ./scripts/nested.sh mirror on|off" ;;
    esac
}

cmd_run() {
    require_running
    [[ $# -gt 0 ]] || die "Nothing to run. Usage: ./scripts/nested.sh run gnome-extensions list"
    # The driver's variables go too, so 'run python3 scripts/nested_driver.py ...'
    # behaves as 'do' does.
    nested_env NESTED_GEOMETRY="$(geometry)" NESTED_RUN_DIR="$RUN_DIR" \
        NESTED_SHOT_DIR="$REPO_DIR/dist" "$@"
}

# The shell's log is mostly the bus daemon announcing activations and services a
# throwaway session lacks, which buries the lines about the extension.
filtered_log() {
    grep -Ev "^\s*$|Activating (via systemd: )?service name=|Successfully activated service|Activated service 'org.freedesktop.systemd1' failed|RealtimeKit|AT-SPI|atk-bridge|discover_other_daemon|gnome-shell-calendar-server|libecal|Error loading calendars|No entry for geolocation" \
        "$LOG_FILE" | tail -n "$1"
}

cmd_logs() {
    [[ -f "$LOG_FILE" ]] || die "No nested shell log at $LOG_FILE."
    local n=40 all=0 arg
    for arg in "$@"; do
        case "$arg" in
            --all) all=1 ;;
            *[!0-9]*|"") die "Usage: ./scripts/nested.sh logs [N] [--all]" ;;
            *) n="$arg" ;;
        esac
    done
    if (( all )); then tail -n "$n" "$LOG_FILE"; else filtered_log "$n"; fi
}

cmd_status() {
    if is_running; then
        local state idle="" secs
        state="$(nested_state || true)"
        secs="$(cat "$IDLE_FILE" 2>/dev/null || echo 0)"
        pid_alive "$WATCH_PID_FILE" && (( secs > 0 )) && idle=", stops after ${secs}s idle"
        echo "nested:    running (pid $(cat "$PID_FILE")), $(geometry)$idle"
        echo "mirror:    $(mirror_running && echo "open on the desktop" || echo "closed -- 'mirror on' to watch")"
        echo "extension: ${state:-not registered in the nested shell}"
        if stand_in; then
            echo "settings:  its own, fresh for this run ($(config_dir))"
            echo "data:      stand-in (HOME $STAND_IN_HOME)"
        else
            echo "settings:  its own, kept between starts ($(config_dir)); 'start --clean' resets them"
            echo "data:      your own"
        fi
        echo "x11:       $(cat "$X11_FILE" 2>/dev/null || true) $(cat "$XAUTH_FILE" 2>/dev/null || true)"
        echo "log:       $LOG_FILE"
        if declare -F nested_status >/dev/null; then nested_status; fi
    else
        echo "nested:    not running"
        local left
        left="$(session_pids | sort -u | paste -sd, || true)"
        [[ -n "$left" ]] && echo "strays:    $left -- './scripts/nested.sh stop' sweeps them"
    fi
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
    overridden="$( (cat "$REPO_DIR"/scripts/nested.d/*.sh 2>/dev/null || true) | sed -n 's/^cmd_\([a-z_]*\)().*/\1/p' | tr _ - | tr '\n' ' ')"
    # shellcheck disable=SC2086  # a list of words
    help_of "$SELF" $overridden
    for file in "$REPO_DIR"/scripts/nested.d/*.sh; do
        [[ -f "$file" ]] || continue
        help_of "$file"
    done
    return 0
}

# This extension's own commands (cmd_NAME) and hooks: nested_stand_in HOME STAGE
# (stand-in data, once per start), nested_stand_in_stage STAGE (the staged src/,
# at every stage), nested_started, nested_stopping, nested_status. A cmd_
# defined there replaces the one above of the same name.
for extra in "$REPO_DIR"/scripts/nested.d/*.sh; do
    [[ -f "$extra" ]] || continue
    # shellcheck source=/dev/null
    source "$extra"
done

cmd="${1:-}"
[[ $# -gt 0 ]] && shift
case "$cmd" in
    start|stop|session-end|""|-h|--help|help) ;;
    *) touch_activity ;;
esac

case "$cmd" in
    session-end) cmd_session_end ;;
    shot|click|move|scroll|key|overview|say)
                 cmd_step "$cmd" "$@" ;;
    mirror)      cmd_mirror "${1:-}" ;;
    ""|-h|--help|help) usage ;;
    *)
        if [[ "$cmd" =~ ^[a-z][a-z0-9-]*$ ]] && declare -F "cmd_${cmd//-/_}" >/dev/null; then
            "cmd_${cmd//-/_}" "$@"
        else
            die "Unknown command '$cmd'. Run './scripts/nested.sh help'."
        fi
        ;;
esac
