#!/usr/bin/env bash
# SessionStart hook: brings the GNOME-EXTENSIONS kit up to date for this session.
#
# Beside the kit (the usual workspace, where Claude Code has already loaded ../CLAUDE.md
# and ../.claude/rules/), it pulls the kit and says when that changed anything. With no
# kit beside the repository (a cloud session, a fresh clone), it fetches the kit into the
# cache and prints its rules, which a SessionStart hook's output puts into the session.
#
# Copied from the kit (template/.claude/kit.sh) by its scripts/sync.sh: change it there.
# It never fails the session: every problem is one line of output and exit 0.

KIT_REPO=Jackicus/GNOME-EXTENSIONS
KIT_URL=https://github.com/$KIT_REPO.git
project=${CLAUDE_PROJECT_DIR:-$(pwd)}
parent=$(dirname "$project")

is_kit() {
    local url
    url=$(git -C "$1" remote get-url origin 2>/dev/null) || return 1
    case $url in
        *"$KIT_REPO" | *"$KIT_REPO.git" | *"$KIT_REPO/") return 0 ;;
        *) return 1 ;;
    esac
}

if [ -d "$parent/.git" ] && is_kit "$parent"; then
    old=$(git -C "$parent" rev-parse HEAD 2>/dev/null)
    branch=$(git -C "$parent" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if [ "$branch" != main ]; then
        echo "Kit: ../ is on ${branch:-a detached HEAD}, not main, so it was not pulled; its rules are as checked out."
        exit 0
    fi
    if ! err=$(timeout 15 git -C "$parent" pull --ff-only -q 2>&1); then
        echo "Kit: could not pull ../ (${err%%$'\n'*}); its rules are as last pulled."
        exit 0
    fi
    new=$(git -C "$parent" rev-parse HEAD 2>/dev/null)
    if [ "$old" != "$new" ]; then
        subjects=$(git -C "$parent" log --format='%s' "$old..$new" 2>/dev/null | paste -sd ';' -)
        echo "Kit updated ${old:0:7}..${new:0:7}: $subjects. ../CLAUDE.md and ../.claude/rules/ were loaded before this pull: re-read them."
    fi
    exit 0
fi

cache=${XDG_CACHE_HOME:-$HOME/.cache}/gnome-extensions-kit
if [ -d "$cache/.git" ]; then
    timeout 15 git -C "$cache" pull --ff-only -q >/dev/null 2>&1 \
        || echo "Kit: could not update $cache; using it as last fetched."
elif ! timeout 20 git clone -q --depth 1 "$KIT_URL" "$cache" >/dev/null 2>&1; then
    echo "Kit: no GNOME-EXTENSIONS kit beside this repository and none could be fetched; its shared rules are at https://github.com/$KIT_REPO (CLAUDE.md and .claude/rules/)."
    exit 0
fi

echo "# The GNOME-EXTENSIONS kit (fetched to $cache: no kit beside this repository)"
echo
echo "Its skills are not installed here; read them as playbooks when one applies: $cache/plugin/skills/<name>/SKILL.md (fix-bug, review-pass, nested-shell, release, doctor)."
for f in "$cache/CLAUDE.md" "$cache"/.claude/rules/*.md; do
    [ -f "$f" ] || continue
    echo
    echo "## ${f#"$cache"/}"
    echo
    cat "$f"
done
exit 0
