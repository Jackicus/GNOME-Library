#!/usr/bin/env python3
"""Carry Video Library's and Games Library's settings, cache and watched marks into Library Menu.

    ./scripts/dev.sh import-settings [--force]

Development only, for the owner's own session; never shipped. Settings are read
with `dconf dump` from the two old extensions' paths and written with `dconf load`
under Library Menu's, keeping only keys its schema has. A key Library Menu already has
is left alone unless --force. Video Library's value wins where both had one;
Games Library's Steam and PCSX2 paths become games-steam-path and
games-pcsx2-path, its shortcut becomes library-shortcut if Library Menu has none, and
the two credential sets are merged.

The cache and watched marks are copied, not moved, only where Library Menu has none
yet: ~/.cache/video-library becomes ~/.cache/library-menu@jackicus with its paths
rewritten, Games Library's games and artwork are added to it, and
~/.local/share/video-library becomes ~/.local/share/library-menu@jackicus. Each library
folder's .video-library-watched.json is renamed .library-watched.json.
"""
import glob
import json
import os
import shutil
import subprocess
import sys
import xml.etree.ElementTree as ET

import gi
gi.require_version('GLib', '2.0')
from gi.repository import GLib  # noqa: E402

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OLD_VIDEO = '/org/gnome/shell/extensions/video-library/'
OLD_GAMES = '/org/gnome/shell/extensions/games-library/'
NEW = '/org/gnome/shell/extensions/library-menu/'
GAMES_RENAMED = {'steam-path': 'games-steam-path', 'pcsx2-path': 'games-pcsx2-path'}
CACHE = GLib.get_user_cache_dir()
DATA = GLib.get_user_data_dir()
# A folder can be a share that has idled out: every touch of one is bounded.
FOLDER_TIMEOUT = 15


def dump(path):
    """{key: GVariant text} of what is set under a dconf path."""
    out = subprocess.run(['dconf', 'dump', path], capture_output=True, text=True, check=True).stdout
    values = {}
    for line in out.splitlines():
        if '=' in line and not line.startswith('['):
            key, _, value = line.partition('=')
            values[key] = value
    return values


def schema_keys():
    path = glob.glob(os.path.join(REPO, 'src/schemas/*.gschema.xml'))[0]
    return {key.get('name') for key in ET.parse(path).getroot().iter('key')}


def credentials(text):
    return GLib.Variant.parse(GLib.VariantType('a{ss}'), text, None, None).unpack() if text else {}


def merged_settings(force):
    keys = schema_keys()
    video, games, current = dump(OLD_VIDEO), dump(OLD_GAMES), dump(NEW)
    wanted = {}
    for key, value in games.items():
        if key == 'games-shortcut':
            key = 'library-shortcut'
        key = GAMES_RENAMED.get(key, key)
        if key in keys:
            wanted[key] = value
    wanted.update({k: v for k, v in video.items() if k in keys})
    if 'credentials' in video or 'credentials' in games:
        both = {**credentials(games.get('credentials')), **credentials(video.get('credentials'))}
        wanted['credentials'] = GLib.Variant('a{ss}', both).print_(True)
    return {k: v for k, v in wanted.items() if force or k not in current}, current


def load(values):
    if not values:
        return
    keyfile = '[/]\n' + ''.join(f'{key}={value}\n' for key, value in sorted(values.items()))
    subprocess.run(['dconf', 'load', NEW], input=keyfile, text=True, check=True)


def rewrite(path, old, new):
    with open(path, encoding='utf-8') as f:
        text = f.read()
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text.replace(old, new))


def import_cache():
    old, games_old = os.path.join(CACHE, 'video-library'), os.path.join(CACHE, 'games-library')
    new = os.path.join(CACHE, 'library-menu@jackicus')
    library = os.path.join(new, 'library.json')
    if os.path.exists(library):
        print(f'cache: {library} exists, left as it is')
        return
    if os.path.isdir(old):
        shutil.copytree(old, new, dirs_exist_ok=True)
        for name in ('library.json', 'metadata/index.json'):
            if os.path.isfile(os.path.join(new, name)):
                rewrite(os.path.join(new, name), f'{old}/', f'{new}/')
        print(f'cache: copied {old}')
    games_library = os.path.join(games_old, 'library.json')
    if not os.path.isfile(games_library):
        return
    for folder in ('posters', 'backdrops'):
        os.makedirs(os.path.join(new, folder), exist_ok=True)
        for src in glob.glob(os.path.join(games_old, folder, '*')):
            dest = os.path.join(new, folder, os.path.basename(src))
            if not os.path.exists(dest):
                shutil.copy2(src, dest)
    with open(games_library, encoding='utf-8') as f:
        games = json.loads(f.read().replace(f'{games_old}/', f'{new}/'))
    data = {'version': 2, 'generated': games.get('generated'), 'sections': {}, 'scanned': {}}
    if os.path.isfile(library):
        with open(library, encoding='utf-8') as f:
            data = json.load(f)
    data['sections']['games'] = games.get('sections', {}).get('games', [])
    with open(library, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=1)
    index = os.path.join(new, 'metadata/index.json')
    games_index = os.path.join(games_old, 'metadata/index.json')
    if os.path.isfile(games_index):
        records = {}
        if os.path.isfile(index):
            with open(index, encoding='utf-8') as f:
                records = json.load(f)
        with open(games_index, encoding='utf-8') as f:
            records = {**json.load(f), **records}
        os.makedirs(os.path.dirname(index), exist_ok=True)
        with open(index, 'w', encoding='utf-8') as f:
            json.dump(records, f, indent=1)
    print(f'cache: added {len(data["sections"]["games"])} games from {games_old}')


def import_marks(folders):
    old, new = os.path.join(DATA, 'video-library'), os.path.join(DATA, 'library-menu@jackicus')
    if os.path.isdir(old) and not os.path.exists(new):
        shutil.copytree(old, new)
        print(f'marks: copied {old}')
    for folder in folders:
        src, dest = os.path.join(folder, '.video-library-watched.json'), os.path.join(folder, '.library-watched.json')
        try:
            # `mv -n` never replaces a mark file Library Menu has written since.
            done = subprocess.run(['sh', '-c', 'test -e "$1" && mv -n "$1" "$2"', 'mv', src, dest],
                                  timeout=FOLDER_TIMEOUT).returncode == 0
        except subprocess.TimeoutExpired:
            print(f'marks: {folder} did not answer; run this again when it is reachable')
            continue
        if done:
            print(f'marks: renamed {src}')


def folders(values):
    out = []
    for key in ('tv-shows-folders', 'films-folders'):
        if values.get(key):
            out += GLib.Variant.parse(GLib.VariantType('as'), values[key], None, None).unpack()
    return [os.path.expanduser(f) for f in out]


def main():
    force = '--force' in sys.argv[1:]
    if shutil.which('dconf') is None:
        sys.exit('import-settings needs dconf.')
    wanted, current = merged_settings(force)
    load(wanted)
    print(f'settings: {len(wanted)} key(s) written under {NEW}' +
          ('' if force else f' ({len(current)} already set there, kept)'))
    import_cache()
    import_marks(folders({**current, **wanted}))
    return 0


if __name__ == '__main__':
    sys.exit(main())
