#!/usr/bin/env bash
# SessionStart hook: brings the GNOME-EXTENSIONS kit, and this repository, up to date for
# this session.
#
# Beside the kit (the usual workspace, where Claude Code has already loaded ../CLAUDE.md
# and ../.claude/rules/), it pulls the kit and says when that changed anything; then it
# fast-forwards this repository if it is on a clean main, or says why it left it; then it
# starts the kit's scripts/pull.sh for the other extensions in the background, and reports
# what the previous background pull found. With no kit beside the repository (a cloud
# session, a fresh clone), it fetches the kit into the cache and prints its rules, which a
# SessionStart hook's output puts into the session.
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

# Pulls the kit beside this repository; one line when that changed anything or failed.
pull_kit() {
    local old new branch err subjects
    old=$(git -C "$parent" rev-parse HEAD 2>/dev/null)
    branch=$(git -C "$parent" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if [ "$branch" != main ]; then
        echo "Kit: ../ is on ${branch:-a detached HEAD}, not main, so it was not pulled; its rules are as checked out."
        return
    fi
    if ! err=$(timeout 15 git -C "$parent" pull --ff-only -q 2>&1); then
        echo "Kit: could not pull ../ (${err%%$'\n'*}); its rules are as last pulled."
        return
    fi
    new=$(git -C "$parent" rev-parse HEAD 2>/dev/null)
    if [ "$old" != "$new" ]; then
        subjects=$(git -C "$parent" log --format='%s' "$old..$new" 2>/dev/null | paste -sd ';' -)
        echo "Kit updated ${old:0:7}..${new:0:7}: $subjects. ../CLAUDE.md and ../.claude/rules/ were loaded before this pull: re-read them."
    fi
}

# Fast-forwards this repository when it is on a clean main; otherwise says what is stale.
# $1 is the exit status of the fetch that ran while the kit pulled.
pull_project() {
    local fetched=$1 branch dirty ahead behind old new subjects reread=
    if [ "$fetched" -ne 0 ]; then
        echo "This repository: could not fetch origin; it is as last pulled."
        return
    fi
    branch=$(git -C "$project" symbolic-ref --quiet --short HEAD 2>/dev/null)
    if [ "$branch" != main ]; then
        if git -C "$project" status -sb 2>/dev/null | head -1 | grep -q '\[gone\]'; then
            echo "This repository is on $branch, whose remote branch is gone (its pull request merged?): switch to main and pull (gnome-ext:pull)."
        fi
        return
    fi
    read -r ahead behind < <(git -C "$project" rev-list --left-right --count main...origin/main 2>/dev/null || echo "0 0")
    [ "$behind" -gt 0 ] || return
    dirty=$(git -C "$project" status --porcelain --untracked-files=no | wc -l)
    if [ "$dirty" -gt 0 ] || [ "$ahead" -gt 0 ]; then
        echo "This repository's main is $behind behind origin/main and was left alone: $dirty uncommitted change(s), $ahead unpushed commit(s)."
        return
    fi
    old=$(git -C "$project" rev-parse HEAD)
    if ! git -C "$project" merge -q --ff-only origin/main >/dev/null 2>&1; then
        echo "This repository's main is $behind behind origin/main; the fast-forward was refused."
        return
    fi
    new=$(git -C "$project" rev-parse HEAD)
    subjects=$(git -C "$project" log --format='%s' "$old..$new" | paste -sd ';' -)
    git -C "$project" diff --quiet "$old" "$new" -- CLAUDE.md .claude/rules \
        || reread=" CLAUDE.md or .claude/rules/ changed after they were loaded: re-read them."
    echo "This repository was $behind behind origin/main: pulled ${old:0:7}..${new:0:7}: $subjects.$reread"
}

# Pulls the other extensions in the background, detached so the session never waits for
# it; the next session reports what it found.
pull_others() {
    local pull=$parent/scripts/pull.sh
    local log=${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/gnome-extensions-pull.log
    [ -x "$pull" ] || return
    if [ -s "$log" ]; then
        echo "The last background pull of the other extensions: $(paste -sd ';' "$log")"
    fi
    command -v setsid >/dev/null && command -v flock >/dev/null || return
    # shellcheck disable=SC2016  # expanded by the inner bash, from its own arguments
    setsid -f bash -c 'exec 9>"$1.lock"; flock -n 9 || exit 0; "$2" --quiet --no-kit --skip "$3" >"$1" 2>&1' \
        _ "$log" "$pull" "$(basename "$project")" </dev/null >/dev/null 2>&1
}

if [ -d "$parent/.git" ] && is_kit "$parent"; then
    timeout 15 git -C "$project" fetch -q --prune origin >/dev/null 2>&1 &
    fetch=$!
    pull_kit
    wait "$fetch"
    pull_project $?
    pull_others
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
skills=$(cd "$cache/plugin/skills" 2>/dev/null && printf '%s\n' */ | tr -d / | paste -sd ',' - | sed 's/,/, /g')
echo "Its skills are not installed here; read them as playbooks when one applies: $cache/plugin/skills/<name>/SKILL.md ($skills)."
for f in "$cache/CLAUDE.md" "$cache"/.claude/rules/*.md; do
    [ -f "$f" ] || continue
    echo
    echo "## ${f#"$cache"/}"
    echo
    cat "$f"
done
exit 0
