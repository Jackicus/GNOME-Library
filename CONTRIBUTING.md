# Contributing

Thanks for helping. Bug reports, fixes and ideas are all welcome; for anything bigger than
a small fix, open or pick an issue first so the approach can be agreed before the work.
Everyone taking part is expected to follow the
[GNOME Code of Conduct](https://conduct.gnome.org).

This file is the same in each of these GNOME Shell extensions. What is particular to this
one (what it needs installed, its own make targets, how it is built) is in its
[README](README.md) and [CLAUDE.md](CLAUDE.md).

## Setting up

You need a GNOME Shell session of a version `src/metadata.json` lists, and `make`,
`glib-compile-schemas` (part of GLib), `gjs`, and Node.js with npm for the lint. Anything
else the checks need is listed one package per line in `.github/ci-packages`, by its Arch
Linux name. The development tools some commands use (a demo library's Pillow, a virtual
pad's evdev, VLC, glslang) are `EXT_TOOLS` in `scripts/ext.conf`; with the
[kit](https://github.com/Jackicus/GNOME-EXTENSIONS) beside the repository,
`../scripts/setup.sh --tools` lists what this machine lacks and the command to install it.

```bash
# Arch Linux
sudo pacman -S --needed make glib2 gjs nodejs npm
# Fedora
sudo dnf install make glib2 gjs nodejs npm
```

## Build, run and check

```bash
make help      # every target
make link      # install as a link to src/, so edits are picked up
make reload    # load your edits into the running shell
make nested    # a throwaway GNOME Shell with this extension, off your desktop
make logs      # follow the shell's log, filtered to this extension
make check     # the lint, the settings schema and the offline checks: what CI runs
```

The first install needs a log out and back in: a Wayland session cannot load an extension
it has never seen. A change to `extension.js` or `metadata.json` still needs one.

Try changes in the nested shell (`make nested`) rather than your own session: it has its
own session bus, so a throw or a freeze there cannot take down the desktop you are working
in. Its settings are its own too, kept between starts and never your real ones;
`./scripts/nested.sh start --clean` resets them, and `./scripts/nested.sh help` lists the
rest.

## Conventions

The design and the traps are in CLAUDE.md and `.claude/rules/`, and the rules shared by
all these extensions in the [GNOME-EXTENSIONS](https://github.com/Jackicus/GNOME-EXTENSIONS)
repository's CLAUDE.md and `.claude/rules/`. In short:

- Follow the [GNOME HIG](https://developer.gnome.org/hig/): the shell's own widgets and
  style, your accent colour, sizes in `em`.
- `extension.js` and what it imports run inside GNOME Shell (St, Clutter, Meta, Shell);
  `prefs.js` runs in its own process (Gtk 4 and libadwaita) and never imports the shell's
  modules.
- `disable()` undoes everything `enable()` did; nothing is created before `enable()`.
- Never block the shell: no synchronous file, process or network calls on its main loop.
- GObject type names, CSS classes and settings carry the extension's own prefix.
- `make check` must pass: [gjs.guide](https://gjs.guide/)'s ESLint configuration.
- Comments describe the code as it is; history belongs to git.

## Privacy

The repository is public. Never commit personal data: no home folder paths, usernames,
account names, tokens or keys, and no real libraries or usage figures. Screenshots are
taken in the nested shell with invented data. The same goes for logs pasted into issues.

## Pull requests

1. Branch from `main`. You do not need write access: fork the repository, push your branch
   to your fork and open the pull request from there. CI runs on it automatically.
2. Keep commits focused, one logical change each. A commit subject says what is now true
   ("The bar keeps its size on a second monitor"), not what was done.
3. Fill in the pull request template, link the issue with `Fixes #123`, and attach
   before-and-after screenshots for anything visible.
4. `main` is protected: nothing is pushed to it directly, and a pull request is merged
   only once its `make check` run has passed. Pull requests are squashed, so `main` keeps
   a linear history, and the branch is deleted after the merge.
