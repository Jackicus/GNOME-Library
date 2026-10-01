# Video Library's own nested.sh hooks, sourced by the kit's scripts/nested.sh.
#
# 'start --stand-in' (or '--demo') runs the extension over the made-up library
# scripts/demo_library.py draws, written into the stand-in home's cache, which
# is the nested session's XDG_CACHE_HOME: the extension, its preferences and
# any scan run there read it and nothing of the user's. What the README's
# screenshots (docs/screenshots/) are taken of.

nested_stand_in() {
    python3 "$REPO_DIR/scripts/demo_library.py" "$1/.cache" >/dev/null
}
