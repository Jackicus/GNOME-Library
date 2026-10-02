import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {SECTIONS as LIBRARY_SECTIONS, openCommandKey, readSections} from './lib/library.js';
import {ACTIONS, NATIVE_KEYS, padLabel} from './lib/actions.js';

// A credential's `fields` are tab-joined in one slot of the `credentials` setting;
// a field's Import reads ~/Documents/keys/<service>/<field.file>.
const SOURCES = {
    tvmaze: {
        title: 'TVmaze',
        blurb: 'Free and keyless. Good TV coverage, including anime.',
        help: 'https://www.tvmaze.com/api',
        helpHint: 'tvmaze.com — no account needed',
    },
    tmdb: {
        title: 'TMDB',
        blurb: 'The richest source: posters, backdrops, taglines, runtimes, genres and ratings.',
        help: 'https://www.themoviedb.org/settings/api',
        helpHint: 'themoviedb.org → Settings → API (free for personal use)',
        service: 'TMDB',
        fields: [{title: 'API key', file: 'API KEY.txt'}],
    },
    wikipedia: {
        title: 'Wikipedia',
        blurb: 'Free and keyless. A poster and the lead paragraph, and little else.',
        help: 'https://www.wikipedia.org/',
        helpHint: 'wikipedia.org — no account needed',
    },
    steam: {
        title: 'Steam',
        blurb: 'Free and keyless. Valve\'s own store record and library artwork, for installed Steam games.',
        help: 'https://store.steampowered.com/',
        helpHint: 'steampowered.com — no account needed',
    },
    igdb: {
        title: 'IGDB',
        blurb: 'Covers, synopses and ratings for PS2 discs, which have no store record of their own.',
        help: 'https://dev.twitch.tv/console/apps',
        helpHint: 'dev.twitch.tv → Applications → Register (free)',
        service: 'IGDB',
        fields: [
            {title: 'Client ID', file: 'CLIENT ID.txt'},
            {title: 'Client secret', file: 'CLIENT SECRET.txt'},
        ],
    },
};
const FIELD_SEP = '\t';

const OPENER_HINT = 'The default plays in VLC full screen and closes it at the end. For example ' +
    '"mpv --fullscreen" instead; watched marks and resuming need a player that shows up ' +
    'in the media controls, which for mpv means mpv-mpris.';

const PAGES = {
    tv: {
        lower: 'TV shows', noun: 'shows', opener: true,
        layout: 'One folder per show. Seasons can be subfolders ("Season 2") or SxxEyy in the file names.',
        online: 'Where artwork, synopsis, genres and ratings come from.',
        sources: ['tvmaze', 'tmdb', 'wikipedia'],
    },
    films: {
        lower: 'films', noun: 'films', opener: true,
        layout: 'One folder or file per film, named "Title (Year)". The largest video in a folder is the feature.',
        online: 'Where posters, synopses, genres and ratings come from.',
        sources: ['tmdb', 'wikipedia'],
    },
    games: {
        lower: 'games', noun: 'games',
        layout: 'Installed Steam games come from Steam\'s own library files, libraries on other ' +
            'drives included. PS2 games come from the folders PCSX2.ini points at, and their ' +
            'covers from its covers folder.',
        paths: [
            {key: 'games-steam-path', title: 'Steam library', hint: 'Auto-detected — ~/.steam/steam, ~/.local/share/Steam or the flatpak install'},
            {key: 'games-pcsx2-path', title: 'PCSX2 configuration', hint: 'Auto-detected — ~/.config/PCSX2 or the flatpak install'},
        ],
        online: 'A game\'s source follows its platform: Steam games use Steam, PS2 discs use IGDB. ' +
            'The order decides which IGDB key is tried first.',
        sources: ['steam', 'igdb'],
    },
};

const SECTIONS = LIBRARY_SECTIONS.map(section => ({...section, ...PAGES[section.key]}));

const SHORTCUT_KEY = 'library-shortcut';

const PLACES = [['menu', 'Menu'], ['desktop', 'Desktop'], ['workspaces', 'Workspaces'], ['modal', 'Modal']];
const VIEWS = {
    desktop: 'Drawn straight onto the wallpaper of the workspace you are on, brought up by the button next to Show Apps and put away by it, Escape or its close button.',
    workspaces: 'Drawn straight onto the wallpaper of a workspace of its own, slid to by the button next to Show Apps and given up again when you close it.',
    menu: 'In the overview, beside your applications, opened from the button next to Show Apps.',
    modal: 'A panel over the desktop, opened from the button next to Show Apps. Escape, a click away, or the button again closes it.',
};
const DETAILS = {
    desktop: 'What you pick opens on the workspace you are already on.',
    workspaces: 'What you pick opens on a workspace of its own.',
    menu: 'What you pick pops up where you picked it, the way an app folder opens.',
    modal: 'What you pick opens in a panel over the desktop and stays up until Escape or a click away closes it.',
};
const TRACKING = {
    source: 'Every mark is kept on this computer, and each library folder also gets a copy of its own marks, so another computer using the same folder picks them up.',
    local: 'Marks are kept on this computer only. Switching from Folders removes the copies from the folders; switching back puts them back.',
    none: 'Nothing is marked as watched. What was marked before is kept, for when this is turned back on.',
};

// The media keys' `custom-keybindings` also lists the shortcuts made in GNOME Settings.
const SYSTEM_KEYBINDINGS = [
    'org.gnome.desktop.wm.keybindings',
    'org.gnome.shell.keybindings',
    'org.gnome.mutter.keybindings',
    'org.gnome.mutter.wayland.keybindings',
    'org.gnome.settings-daemon.plugins.media-keys',
];
const MEDIA_KEYS = 'org.gnome.settings-daemon.plugins.media-keys';
const CUSTOM_KEYBINDING = 'org.gnome.settings-daemon.plugins.media-keys.custom-keybinding';

// GTK's table predates the keys xkbcommon gives a remote's evdev codes (0x10081xxx).
const REMOTE_KEYS = {
    0x10081160: 'OK',
    0x1008ffa0: 'Select',
    0x100810ae: 'Exit',
    0x1008ff18: 'Home',
    0x10081166: 'Info',
    0x10081192: 'Channel Up',
    0x10081193: 'Channel Down',
    0x100811b6: 'Context Menu',
};

function iconButton(icon, tooltip) {
    return new Gtk.Button({icon_name: icon, tooltip_text: tooltip, valign: Gtk.Align.CENTER, css_classes: ['flat']});
}

function toggles(settings, key, options) {
    const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
    for (const [name, label] of options)
        group.add(new Adw.Toggle({name, label}));
    settings.bind(key, group, 'active-name', Gio.SettingsBindFlags.DEFAULT);
    return group;
}

// The tick marks the schema's default.
function slider(settings, key, min, max) {
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1}),
        digits: 0,
        round_digits: 0,
        draw_value: true,
        value_pos: Gtk.PositionType.RIGHT,
        hexpand: true,
        width_request: 220,
        valign: Gtk.Align.CENTER,
    });
    scale.add_mark(settings.get_default_value(key).deep_unpack(), Gtk.PositionType.BOTTOM, null);
    settings.bind(key, scale.adjustment, 'value', Gio.SettingsBindFlags.DEFAULT);
    return scale;
}

function row(title, subtitle, ...suffixes) {
    const built = new Adw.ActionRow({title, subtitle: subtitle ?? ''});
    suffixes.forEach(suffix => built.add_suffix(suffix));
    return built;
}

// Rows rebuilt from a list-valued setting, or one insensitive row when it is empty.
function listRows(group, settings, key, build, empty) {
    const rows = [];
    const rebuild = () => {
        rows.splice(0).forEach(old => group.remove(old));
        const list = settings.get_strv(key);
        const fresh = list.length
            ? list.map((value, index) => build(value, index, list))
            : [new Adw.ActionRow({...empty, sensitive: false})];
        fresh.forEach(r => group.add(r));
        rows.push(...fresh);
    };
    settings.connect(`changed::${key}`, rebuild);
    rebuild();
}

export default class LibraryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);
        window.set_search_enabled(true);

        const state = {window, settings, counts: this._readCounts(), refreshCounts: [], padHandlers: []};
        window.add(this._generalPage(state));
        window.add(this._controlsPage(state));
        for (const section of SECTIONS)
            window.add(this._sectionPage(state, section));

        // The Extensions app outlives its windows: none of theirs may stay on a controller.
        window.connect('close-request', () => {
            state.padHandlers.splice(0).forEach(([object, id]) => object.disconnect(id));
            return false;
        });
    }

    _credential(settings, slot) {
        return settings.get_value('credentials').deep_unpack()[slot] ?? '';
    }

    _setCredential(settings, slot, value) {
        const all = settings.get_value('credentials').deep_unpack();
        if (value)
            all[slot] = value;
        else
            delete all[slot];
        settings.set_value('credentials', new GLib.Variant('a{ss}', all));
    }

    _fields(settings, slot, count) {
        const parts = this._credential(settings, slot).split(FIELD_SEP);
        return Array.from({length: count}, (_, i) => parts[i] ?? '');
    }

    _setField(settings, slot, index, value, count) {
        const parts = this._fields(settings, slot, count);
        parts[index] = value;
        this._setCredential(settings, slot, parts.some(Boolean) ? parts.join(FIELD_SEP) : '');
    }

    // A slot no list names is unreachable, so its key goes with the last row naming it.
    _pruneCredentials(settings) {
        const used = new Set(SECTIONS.flatMap(s => settings.get_strv(`${s.prefix}-sources`)));
        const all = settings.get_value('credentials').deep_unpack();
        const orphans = Object.keys(all).filter(slot => !used.has(slot));
        if (!orphans.length)
            return;
        orphans.forEach(slot => delete all[slot]);
        settings.set_value('credentials', new GLib.Variant('a{ss}', all));
    }

    _generalPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const view = new Adw.PreferencesGroup({title: 'View'});
        page.add(view);
        view.add(row('Library opens in', null, toggles(settings, 'library-opens-in', PLACES)));
        view.add(row('Items open in', null, toggles(settings, 'detail-opens-in', PLACES)));
        const play = new Adw.SwitchRow({
            title: 'Play on a new workspace',
            subtitle: 'The player opens on an empty workspace of its own, leaving the one you picked from as it was',
        });
        settings.bind('play-on-new-workspace', play, 'active', Gio.SettingsBindFlags.DEFAULT);
        view.add(play);
        const held = new Adw.ActionRow({
            title: 'Workspaces the library is using stay open',
            subtitle: 'A workspace opened for the library or for a picked item is held until you close ' +
                'it or go back from it, so GNOME does not fold it away. With a fixed number of ' +
                'workspaces, set enough in Settings → Multitasking.',
            sensitive: false,
        });
        view.add(held);

        page.add(this._shortcutGroup(state));

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(appearance);
        appearance.add(row('Rows', 'Covers down a page. Fewer means larger covers.', slider(settings, 'rows', 1, 3)));
        appearance.add(row('Columns',
            'Covers across a page. Fewer means larger covers. A small space — the grid in the overview, a small screen — fits fewer of either.',
            slider(settings, 'columns', 4, 10)));
        appearance.add(row('Align covers', 'Where a row that is not full sits',
            toggles(settings, 'grid-align', [['center', 'Centre'], ['start', 'Left']])));
        appearance.add(row('Corner radius', 'How rounded covers, tiles and the detail pane are, in pixels. 0 is square.',
            slider(settings, 'corner-radius', 0, 40)));
        const detailSize = row('Detail pop-up size', 'How much of the available room the pop-up fills, as a percentage',
            slider(settings, 'detail-size', 80, 120));
        appearance.add(detailSize);
        const accent = new Adw.ActionRow({
            title: 'Accent colour',
            subtitle: 'Follows Settings → Appearance → Accent Color',
            activatable: true,
        });
        accent.add_suffix(new Gtk.Image({icon_name: 'external-link-symbolic'}));
        accent.connect('activated', () => {
            try {
                Gio.Subprocess.new(['gnome-control-center', 'background'], Gio.SubprocessFlags.NONE);
            } catch (e) {
                console.warn(`[Library Menu] Could not open Settings: ${e.message}`);
            }
        });
        appearance.add(accent);

        // Under the group's heading rather than in the rows, which would squeeze the toggles.
        const syncView = () => {
            const mode = settings.get_string('library-opens-in');
            const detail = settings.get_string('detail-opens-in');
            view.description = `${VIEWS[mode]} ${DETAILS[detail]}`;
            held.visible = mode === 'workspaces' || detail === 'workspaces';
            detailSize.sensitive = detail === 'menu' || detail === 'modal';
        };
        settings.connect('changed::library-opens-in', syncView);
        settings.connect('changed::detail-opens-in', syncView);
        syncView();

        page.add(this._watchedGroup(settings));

        const library = new Adw.PreferencesGroup({
            title: 'Library',
            description: 'Folders, sources and API keys are on each section\'s own page.',
        });
        page.add(library);
        const rescan = row('Rescan everything', this._lastScanText(), this._scanButton(state, SECTIONS));
        state.refreshCounts.push(() => rescan.set_subtitle(this._lastScanText()));
        library.add(rescan);
        return page;
    }

    _watchedGroup(settings) {
        const group = new Adw.PreferencesGroup({title: 'Watched'});
        group.add(row('Keep marks in', null,
            toggles(settings, 'tracking', [['source', 'Folders'], ['local', 'Local'], ['none', 'Off']])));
        const threshold = row('Watched after',
            'How far through an episode or film playback has to get, as a percentage. Works with any player that shows up in the media controls, VLC included.',
            slider(settings, 'watched-threshold', 50, 100));
        group.add(threshold);
        const resume = new Adw.SwitchRow({
            title: 'Continue where you left off',
            subtitle: 'Playing something again from the library picks up where it stopped. Something marked watched starts from the beginning.',
        });
        settings.bind('resume-playback', resume, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(resume);
        const rewind = row('Rewind on resume', 'Seconds before where it stopped, so the moment it was left at is seen again',
            slider(settings, 'resume-rewind', 0, 60));
        settings.bind('resume-playback', rewind, 'sensitive', Gio.SettingsBindFlags.GET);
        group.add(rewind);
        const sync = () => {
            const mode = settings.get_string('tracking');
            group.description = TRACKING[mode];
            threshold.sensitive = mode !== 'none';
            resume.sensitive = mode !== 'none';
        };
        settings.connect('changed::tracking', sync);
        sync();
        return group;
    }

    _shortcutGroup(state) {
        const {settings} = state;
        const group = new Adw.PreferencesGroup({title: 'Keyboard Shortcut'});
        const label = new Adw.ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
        const clear = iconButton('edit-clear-symbolic', 'Remove this shortcut');
        clear.connect('clicked', () => settings.set_strv(SHORTCUT_KEY, []));
        const shortcut = row('Open the library',
            'From anywhere, wherever the library opens; the same shortcut again closes it. None is set to begin with.',
            label, clear);
        shortcut.activatable = true;
        shortcut.connect('activated', () => this._captureShortcut(state));
        const sync = () => {
            label.accelerator = settings.get_strv(SHORTCUT_KEY)[0] ?? '';
            clear.visible = label.accelerator !== '';
        };
        settings.connect(`changed::${SHORTCUT_KEY}`, sync);
        sync();
        group.add(shortcut);
        return group;
    }

    // GNOME Settings' rules, from cc-keyboard-shortcut-editor.c.
    _captureShortcut(state) {
        const {settings} = state;
        this._keyDialog(state, {
            title: 'Open the Library',
            description: 'Press the new shortcut. Esc cancels, Backspace removes it.',
            onKey: (keyval, mods) => {
                if (!mods && keyval === Gdk.KEY_Escape)
                    return true;
                if (!mods && keyval === Gdk.KEY_BackSpace) {
                    settings.set_strv(SHORTCUT_KEY, []);
                    return true;
                }
                const shown = keyLabel(keyval, mods);
                // Unmodified, only a function key or the XF86 range (media keys, a remote's) will do.
                const bare = !(mods & ~Gdk.ModifierType.SHIFT_MASK) &&
                    !(keyval >= Gdk.KEY_F1 && keyval <= Gdk.KEY_F35) && (keyval >>> 16) !== 0x1008;
                if (bare)
                    return `${shown} on its own would be taken from every window. Add Ctrl, Alt or Super to it, or use a function or media key.`;
                const accel = Gtk.accelerator_name(keyval, mods);
                const clash = shortcutClash(settings, accel, SHORTCUT_KEY);
                if (clash)
                    return `${shown} is already taken — ${clash}. Try another, or Esc to cancel.`;
                settings.set_strv(SHORTCUT_KEY, [accel]);
                return true;
            },
        });
    }

    // `onKey` answers true to close, or a line saying why the key will not do.
    // `anyKey` also takes the bare navigation keys GTK refuses, which a remote sends.
    _keyDialog(state, {heading = 'Set Shortcut', title, description, onKey, anyKey = false}) {
        const {window} = state;
        const status = new Adw.StatusPage({icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic', title, description});
        const toolbar = new Adw.ToolbarView({content: status});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: heading, content_width: 440, child: toolbar});

        const keys = new Gtk.EventControllerKey({propagation_phase: Gtk.PropagationPhase.CAPTURE});
        keys.connect('key-pressed', (_controller, keyval, _keycode, modifiers) => {
            let mods = modifiers & Gtk.accelerator_get_default_mod_mask() & ~Gdk.ModifierType.LOCK_MASK;
            let lower = Gdk.keyval_to_lower(keyval);
            if (lower === Gdk.KEY_ISO_Left_Tab)
                lower = Gdk.KEY_Tab;
            if (lower !== keyval)
                mods |= Gdk.ModifierType.SHIFT_MASK;
            if (!Gtk.accelerator_valid(lower, anyKey ? mods | Gdk.ModifierType.CONTROL_MASK : mods))
                return Gdk.EVENT_STOP;
            const answer = onKey(lower, mods);
            if (answer === true)
                dialog.close();
            else if (answer)
                status.description = answer;
            return Gdk.EVENT_STOP;
        });
        // On the dialog: its keys never pass through the window's capture phase.
        dialog.add_controller(keys);

        // As GNOME Settings does, so a key the system has taken still reaches the dialog.
        const surface = window.get_surface();
        surface.inhibit_system_shortcuts(null);
        dialog.connect('closed', () => surface.restore_system_shortcuts());
        dialog.present(window);
        return dialog;
    }

    _controlsPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'Controls', icon_name: 'input-gaming-symbolic'});

        const keys = new Adw.PreferencesGroup({
            title: 'Remote and Keyboard',
            description: 'The arrow keys, Enter and Escape always work. Add the keys a remote, a Pico or ' +
                'anything else that acts as a keyboard sends: they do these things while a ' +
                'library is on screen, and what they always did everywhere else.',
        });
        page.add(keys);
        for (const action of ACTIONS) {
            keys.add(this._bindingRow(settings, action, {
                key: `keys-${action.key}`,
                labels: () => settings.get_value(`keys-${action.key}`).deep_unpack().map(([k, m]) => keyLabel(k, m)),
                add: () => this._captureNavKey(state, action),
                addTip: 'Add a key',
            }));
        }
        keys.add(this._resetRow(settings, ACTIONS.map(a => `keys-${a.key}`)));

        const pads = new Adw.PreferencesGroup({
            title: 'Game Controller',
            description: 'Read only while a library is on screen, so games are left alone — except Home, ' +
                'which also opens the library when no window has the keyboard. Xbox, PlayStation ' +
                'and most other pads are ready as they are; anything else, a Pico running as a ' +
                'gamepad included, is set up by pressing its buttons here.',
        });
        page.add(pads);
        const use = new Adw.SwitchRow({title: 'Use game controllers'});
        settings.bind('gamepad-enabled', use, 'active', Gio.SettingsBindFlags.DEFAULT);
        pads.add(use);
        const connected = row('Connected', 'Looking…');
        const padRows = [connected, ...ACTIONS.map(action => this._bindingRow(settings, action, {
            key: `pad-${action.key}`,
            // A mapped pad's D-pad is buttons, an unmapped one's a hat: one name for both.
            labels: () => [...new Set(settings.get_strv(`pad-${action.key}`).map(padLabel))],
            subtitle: action.subtitle ?? null,
            add: () => this._capturePad(state, action),
            addTip: 'Add a button',
        })), this._resetRow(settings, ACTIONS.map(a => `pad-${a.key}`))];
        for (const padRow of padRows) {
            settings.bind('gamepad-enabled', padRow, 'sensitive', Gio.SettingsBindFlags.GET);
            pads.add(padRow);
        }
        this._watchPads(state, connected);
        return page;
    }

    _bindingRow(settings, action, {key, labels, add, addTip, subtitle = action.subtitle ?? 'Besides the arrow key'}) {
        const shown = new Gtk.Label({
            css_classes: ['dim-label'],
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 22,
            valign: Gtk.Align.CENTER,
        });
        const addButton = iconButton('list-add-symbolic', addTip);
        const clear = iconButton('edit-clear-symbolic', 'Remove them all');
        addButton.connect('clicked', add);
        clear.connect('clicked', () => settings.set_value(key,
            new GLib.Variant(settings.get_value(key).get_type_string(), [])));
        const binding = row(action.title, subtitle, shown, addButton, clear);
        binding.activatable_widget = addButton;
        const sync = () => {
            const names = labels();
            shown.label = names.length ? names.join(', ') : 'None';
            shown.tooltip_text = names.join(', ');
            clear.sensitive = names.length > 0;
        };
        settings.connect(`changed::${key}`, sync);
        sync();
        return binding;
    }

    _resetRow(settings, keys) {
        const button = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => keys.forEach(key => settings.reset(key)));
        return row('Put back the defaults', null, button);
    }

    _captureNavKey(state, action) {
        const {settings} = state;
        const key = `keys-${action.key}`;
        const matches = (keyval, mods) => ([k, m]) => k === keyval && m === mods;
        this._keyDialog(state, {
            heading: 'Add a Key',
            title: action.title,
            description: 'Press the key on the remote or keyboard. Esc cancels.',
            anyKey: true,
            onKey: (keyval, mods) => {
                if (!mods && keyval === Gdk.KEY_Escape)
                    return true;
                const shown = keyLabel(keyval, mods);
                if (!mods && NATIVE_KEYS.some(name => Gdk[`KEY_${name}`] === keyval))
                    return `${shown} already works in every library. Press another key, or Esc to cancel.`;
                const bound = settings.get_value(key).deep_unpack();
                if (bound.some(matches(keyval, mods)))
                    return true;
                const owner = ACTIONS.find(other => other !== action &&
                    settings.get_value(`keys-${other.key}`).deep_unpack().some(matches(keyval, mods)));
                if (owner)
                    return `${shown} is already ${owner.title}. Press another key, or Esc to cancel.`;
                const clash = shortcutClash(settings, Gtk.accelerator_name(keyval, mods), null);
                if (clash)
                    return `${shown} is taken by the system — ${clash} — and would never reach the library.`;
                settings.set_value(key, new GLib.Variant('a(uu)', [...bound, [keyval, mods]]));
                return true;
            },
        });
    }

    // An axis counts only once seen at rest, so a trigger resting at one end is not a press.
    async _capturePad(state, action) {
        const {settings, window} = state;
        const key = `pad-${action.key}`;
        const status = new Adw.StatusPage({
            icon_name: 'input-gaming-symbolic',
            title: action.title,
            description: 'Press the button, or push the stick or D-pad, on the controller. Esc cancels.',
        });
        const toolbar = new Adw.ToolbarView({content: status});
        toolbar.add_top_bar(new Adw.HeaderBar());
        const dialog = new Adw.Dialog({title: 'Set Controller Input', content_width: 440, child: toolbar});
        dialog.present(window);

        const handlers = [];
        dialog.connect('closed', () => handlers.splice(0).forEach(([object, id]) => object.disconnect(id)));
        const rest = new Map();
        const take = input => {
            const bound = settings.get_strv(key);
            if (bound.includes(input)) {
                dialog.close();
                return;
            }
            const owner = ACTIONS.find(other => other !== action && settings.get_strv(`pad-${other.key}`).includes(input));
            if (owner) {
                status.description = `${padLabel(input)} is already ${owner.title}. Press another, or Esc to cancel.`;
                return;
            }
            settings.set_strv(key, [...bound, input]);
            dialog.close();
        };
        const axis = (device, code, value, hat) => {
            const id = `${device.get_guid()}/${code}`;
            const was = rest.get(id) ?? (hat ? 0 : undefined);
            rest.set(id, Math.abs(value));
            if (Math.abs(value) >= 0.7 && was !== undefined && was < 0.3)
                take(`axis:${code}${value < 0 ? '-' : '+'}`);
        };
        const count = await watchDevices(handlers, (device, listen) => {
            listen(device, 'button-press-event', (_d, event) => {
                const [ok, button] = event.get_button();
                take(`button:${ok ? button : event.get_hardware_code()}`);
            });
            listen(device, 'absolute-axis-event', (_d, event) => {
                const [ok, code, value] = event.get_absolute();
                if (ok)
                    axis(device, code, value, false);
            });
            listen(device, 'hat-axis-event', (_d, event) => {
                const [ok, code, value] = event.get_hat();
                if (ok)
                    axis(device, code, value, true);
            });
        });
        if (count === null)
            status.description = 'libmanette is not installed, so controllers cannot be read.';
        else if (!count)
            status.description = 'No controller is connected. Connect one and press a button on it, or Esc to cancel.';
    }

    async _watchPads(state, connected) {
        const names = new Map();
        const sync = () => (connected.subtitle = names.size ? [...names.values()].join(', ') : 'None');
        const count = await watchDevices(state.padHandlers, (device, listen) => {
            names.set(device, device.get_name());
            listen(device, 'disconnected', () => {
                names.delete(device);
                sync();
            });
            sync();
        });
        if (count === null)
            connected.subtitle = 'libmanette is not installed, so controllers cannot be read.';
        else
            sync();
    }

    _sectionPage(state, section) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: section.title, icon_name: section.icon});

        const files = new Adw.PreferencesGroup({title: 'Files', description: section.layout});
        page.add(files);
        const enabled = new Adw.SwitchRow({
            title: `Show ${section.lower} in the library`,
            subtitle: `The ${section.title} tab, wherever the library opens`,
        });
        settings.bind(`${section.prefix}-enabled`, enabled, 'active', Gio.SettingsBindFlags.DEFAULT);
        files.add(enabled);
        if (section.paths)
            section.paths.forEach(spec => files.add(this._pathRow(state, spec)));
        else
            this._foldersGroup(state, section, files);

        page.add(this._sourcesGroup(state, section));
        if (section.opener)
            page.add(this._openerGroup(state, section));

        const library = new Adw.PreferencesGroup({title: 'Library'});
        page.add(library);
        const status = row('Indexed', this._countText(state.counts, section), this._scanButton(state, [section]));
        state.refreshCounts.push(() => status.set_subtitle(this._countText(state.counts, section)));
        library.add(status);
        return page;
    }

    _openerGroup(state, section) {
        const {settings} = state;
        const key = openCommandKey(section);
        const group = new Adw.PreferencesGroup({title: 'Opening'});
        const command = new Adw.EntryRow({title: 'Video player command', text: settings.get_string(key), show_apply_button: true});
        command.connect('apply', () => settings.set_string(key, command.get_text().trim()));
        group.add(command);
        group.add(new Adw.ActionRow({
            title: 'Leave empty for the system default',
            subtitle: `${OPENER_HINT} The file's path is added to the end. A program that is not installed falls back to the system default.`,
            sensitive: false,
        }));
        return group;
    }

    _sourcesGroup(state, section) {
        const {settings} = state;
        const key = `${section.prefix}-sources`;
        const group = new Adw.PreferencesGroup({title: 'Information sources', description: section.online});

        const online = new Adw.SwitchRow({
            title: 'Fetch artwork and descriptions online',
            subtitle: 'Off leaves this section with whatever is already cached.',
        });
        settings.bind(`${section.prefix}-online`, online, 'active', Gio.SettingsBindFlags.DEFAULT);
        group.add(online);

        const actions = new Gio.SimpleActionGroup();
        const add = new Gio.SimpleAction({name: 'add', parameter_type: new GLib.VariantType('s')});
        add.connect('activate', (_action, param) => this._addSource(state, section, param.unpack()));
        actions.add_action(add);
        group.insert_action_group('sources', actions);
        const menu = new Gio.Menu();
        section.sources.forEach(id => menu.append(SOURCES[id].title, `sources.add('${id}')`));
        group.set_header_suffix(new Gtk.MenuButton({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add a source',
            css_classes: ['flat'],
            menu_model: menu,
        }));

        // Refreshed rather than rebuilt for a key, so an entry being typed into keeps its cursor.
        const syncers = [];
        listRows(group, settings, key, (entry, index, list) => {
            if (index === 0)
                syncers.length = 0;
            const built = this._sourceRow(state, section, entry, index, list);
            syncers.push(built.sync);
            return built.row;
        }, {title: 'No sources', subtitle: `Nothing is looked up for ${section.lower}. Add one above.`});
        const refresh = () => syncers.forEach(sync => sync());
        settings.connect('changed::credentials', refresh);
        SECTIONS.filter(other => other.key !== section.key)
            .forEach(other => settings.connect(`changed::${other.prefix}-sources`, refresh));
        return group;
    }

    _sourceRow(state, section, entry, index, list) {
        const {settings, window} = state;
        const spec = SOURCES[sourceId(entry)];
        const slot = entry.includes('@') ? entry : null;
        const fields = spec?.fields ?? [];
        const source = new Adw.ExpanderRow({title: spec?.title ?? entry, tooltip_text: spec?.blurb ?? ''});

        const subtitle = () => {
            if (!spec)
                return 'Unknown source — remove it or fix the setting';
            if (!slot || !fields.length)
                return 'No key needed';
            const shared = SECTIONS.filter(other => other.key !== section.key &&
                settings.get_strv(`${other.prefix}-sources`).includes(entry)).map(other => other.title);
            const where = shared.length ? ` · shared with ${shared.join(' and ')}` : '';
            const set = this._fields(settings, slot, fields.length).every(value => value.trim() !== '');
            return `Key ${entry.split('@')[1]} ${set ? 'is set' : 'is not set — skipped'}${where}`;
        };
        source.subtitle = subtitle();

        const move = to => {
            const next = [...list];
            next.splice(to, 0, ...next.splice(index, 1));
            settings.set_strv(`${section.prefix}-sources`, next);
        };
        const remove = iconButton('list-remove-symbolic', 'Remove this source');
        remove.connect('clicked', () => {
            settings.set_strv(`${section.prefix}-sources`, list.filter((_, i) => i !== index));
            this._pruneCredentials(settings);
        });
        const down = iconButton('go-down-symbolic', 'Try this one later');
        down.sensitive = index < list.length - 1;
        down.connect('clicked', () => move(index + 1));
        const up = iconButton('go-up-symbolic', 'Try this one sooner');
        up.sensitive = index > 0;
        up.connect('clicked', () => move(index - 1));
        // An expander row packs each suffix ahead of the last: added back to front.
        for (const button of [remove, down, up])
            source.add_suffix(button);
        if (spec?.help) {
            const help = iconButton('help-about-symbolic', fields.length
                ? `Get a ${spec.title} key — ${spec.helpHint}`
                : `About ${spec.title} — ${spec.helpHint}`);
            help.connect('clicked', () => Gtk.show_uri(window, spec.help, Gdk.CURRENT_TIME));
            source.add_suffix(help);
        }

        if (!fields.length) {
            source.add_row(new Adw.PasswordEntryRow({title: spec ? `${spec.title} needs no key` : 'No key', sensitive: false}));
            return {row: source, sync: () => (source.subtitle = subtitle())};
        }

        const values = fields.map((field, i) => {
            const value = new Adw.PasswordEntryRow({
                title: field.title,
                text: this._fields(settings, slot, fields.length)[i],
                show_apply_button: true,
            });
            value.connect('apply', () => this._setField(settings, slot, i, value.get_text().trim(), fields.length));
            const drop = this._keyDropFile(spec.service, field.file);
            if (drop) {
                const importButton = new Gtk.Button({
                    label: 'Import',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: `Read it from ${drop}`,
                    css_classes: ['flat'],
                });
                importButton.connect('clicked', () => {
                    const imported = this._readKeyDrop(drop);
                    if (imported)
                        this._setField(settings, slot, i, imported, fields.length);
                });
                value.add_suffix(importButton);
            }
            source.add_row(value);
            return value;
        });

        return {
            row: source,
            sync: () => {
                const current = this._fields(settings, slot, fields.length);
                values.forEach((value, i) => {
                    // Not while typed into: the keys are in the row's text widget, so focus-within.
                    const typing = value.get_state_flags() & Gtk.StateFlags.FOCUS_WITHIN;
                    if (!typing && value.get_text() !== current[i])
                        value.set_text(current[i]);
                });
                source.subtitle = subtitle();
            },
        };
    }

    // A keyed source takes the lowest free slot; a keyless one is listed once.
    _addSource(state, section, id) {
        const {settings} = state;
        const key = `${section.prefix}-sources`;
        const list = settings.get_strv(key);
        let entry = id;
        if (SOURCES[id].fields) {
            let n = 1;
            while (list.includes(`${id}@${n}`))
                n++;
            entry = `${id}@${n}`;
        } else if (list.includes(id)) {
            return;
        }
        settings.set_strv(key, [...list, entry]);
    }

    // The value in the key drop, or '' if it cannot be read. Never logged.
    _readKeyDrop(path) {
        try {
            return new TextDecoder().decode(GLib.file_get_contents(path)[1]).trim();
        } catch (e) {
            console.warn(`[Library Menu] Could not read ${path}: ${e.message}`);
            return '';
        }
    }

    _keyDropFile(service, field) {
        const docs = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir();
        const path = GLib.build_filenamev([docs, 'keys', service, field]);
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : null;
    }

    // One folder that overrides auto-detection; empty is auto-detected.
    _pathRow(state, spec) {
        const {settings, window} = state;
        const reset = iconButton('edit-clear-symbolic', 'Back to auto-detection');
        const pick = iconButton('folder-open-symbolic', 'Choose folder');
        const path = row(spec.title, null, reset, pick);
        path.activatable = true;
        const choose = () => this._pickFolder(window, `Choose the ${spec.title.toLowerCase()}`,
            settings.get_string(spec.key) || null, chosen => settings.set_string(spec.key, chosen));
        pick.connect('clicked', choose);
        path.connect('activated', choose);
        reset.connect('clicked', () => settings.set_string(spec.key, ''));
        const sync = () => {
            const value = settings.get_string(spec.key);
            path.subtitle = value || spec.hint;
            reset.visible = value !== '';
            if (value)
                this._checkFolder(path, value, () => settings.get_string(spec.key) === value);
        };
        settings.connect(`changed::${spec.key}`, sync);
        sync();
        return path;
    }

    _foldersGroup(state, section, group) {
        const {settings, window} = state;
        const key = `${section.prefix}-folders`;
        const add = iconButton('list-add-symbolic', 'Add a folder');
        add.connect('clicked', () => {
            const current = settings.get_strv(key);
            this._pickFolder(window, `Add a ${section.title} folder`, current.at(-1) ?? null, path => {
                if (!current.includes(path))
                    settings.set_strv(key, [...current, path]);
            });
        });
        group.set_header_suffix(add);
        listRows(group, settings, key, (path, index, list) => {
            const remove = iconButton('list-remove-symbolic', 'Remove this folder');
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter((_, i) => i !== index)));
            const folder = row(list.length > 1 ? `Folder ${index + 1}` : 'Folder', path, remove);
            folder.activatable = true;
            this._checkFolder(folder, path, () => settings.get_strv(key)[index] === path);
            folder.connect('activated', () => {
                this._pickFolder(window, `Choose ${section.title} folder`, path, chosen => {
                    const next = settings.get_strv(key);
                    next[index] = chosen;
                    settings.set_strv(key, [...new Set(next)]);
                });
            });
            return folder;
        }, {title: 'No folder', subtitle: 'Nothing is scanned. Add a folder above.'});
    }

    // Asynchronous: a share that has idled out takes seconds to stat.
    _checkFolder(folderRow, path, stillCurrent) {
        const text = folderRow.get_subtitle();
        Gio.File.new_for_path(path).query_info_async('standard::type', Gio.FileQueryInfoFlags.NONE,
            GLib.PRIORITY_DEFAULT, null, (file, result) => {
                let found = false;
                try {
                    found = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
                } catch {
                    // Missing or unreachable: the row says the same either way.
                }
                if (!found && stillCurrent())
                    folderRow.set_subtitle(`${text}  — not found`);
            });
    }

    _pickFolder(window, title, initial, onChosen) {
        const dialog = new Gtk.FileDialog({
            title,
            modal: true,
            initial_folder: Gio.File.new_for_path(
                initial ?? GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir()),
        });
        dialog.select_folder(window, null, (source, result) => {
            try {
                onChosen(source.select_folder_finish(result).get_path());
            } catch {
                // Cancelled.
            }
        });
    }

    _readCounts() {
        const {sections, generated} = readSections();
        const counts = {generated};
        for (const s of SECTIONS)
            counts[s.key] = Array.isArray(sections[s.key]) ? sections[s.key].length : null;
        return counts;
    }

    _countText(counts, section) {
        const n = counts[section.key];
        return n === null || n === undefined ? 'Not scanned yet' : `${n} ${section.noun}`;
    }

    _lastScanText() {
        const {generated} = this._readCounts();
        if (!generated)
            return 'The library has not been scanned yet';
        return `Last scanned ${GLib.DateTime.new_from_unix_local(Math.floor(generated)).format('%-d %b %H:%M')}`;
    }

    // The scanner reads its settings itself; `--only` narrows it to `sections`.
    _scanButton(state, sections) {
        const content = new Adw.ButtonContent({label: 'Rescan', icon_name: 'view-refresh-symbolic'});
        const button = new Gtk.Button({child: content, valign: Gtk.Align.CENTER, css_classes: ['flat']});
        const done = failed => {
            button.sensitive = true;
            content.icon_name = failed ? 'dialog-warning-symbolic' : 'view-refresh-symbolic';
            content.label = failed ? 'Failed — see logs' : 'Rescan';
            state.counts = this._readCounts();
            state.refreshCounts.forEach(refresh => refresh());
        };
        button.connect('clicked', () => {
            const enabled = sections.filter(s => state.settings.get_boolean(`${s.prefix}-enabled`));
            if (!enabled.length) {
                content.label = 'Nothing enabled';
                return;
            }
            // One with no folder still runs if it has items left to clear.
            const ready = enabled.filter(s => s.launchers ||
                state.settings.get_strv(`${s.prefix}-folders`).length || state.counts[s.key]);
            if (!ready.length) {
                content.label = 'No folder set';
                return;
            }
            const argv = [gjsPath(), '-m', GLib.build_filenamev([this.path, 'backend', 'scanLibrary.js']),
                ...ready.flatMap(s => ['--only', s.key])];
            button.sensitive = false;
            content.label = 'Scanning…';
            content.icon_name = 'content-loading-symbolic';
            let proc;
            try {
                proc = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
            } catch (e) {
                console.error(`[Library Menu] Could not launch scanner: ${e.message}`);
                done(true);
                return;
            }
            proc.communicate_utf8_async(null, null, (p, result) => {
                try {
                    const [, , stderr] = p.communicate_utf8_finish(result);
                    if (!p.get_successful())
                        console.error(`[Library Menu] Scan failed: ${stderr}`);
                    done(!p.get_successful());
                } catch (e) {
                    console.error(`[Library Menu] Scan failed: ${e.message}`);
                    done(true);
                }
            });
        });
        return button;
    }
}

// What already answers to `accel`, or null. Compared as GTK parses them, so
// "<Primary>" and "<Control>" are one modifier.
function shortcutClash(settings, accel, ownKey) {
    const normal = text => {
        const [ok, keyval, mods] = Gtk.accelerator_parse(text);
        return ok && keyval ? Gtk.accelerator_name(Gdk.keyval_to_lower(keyval), mods) : null;
    };
    const wanted = normal(accel);
    const source = Gio.SettingsSchemaSource.get_default();

    if (SHORTCUT_KEY !== ownKey && settings.get_strv(SHORTCUT_KEY).some(a => normal(a) === wanted))
        return 'Open the library';
    // A shortcut is grabbed everywhere, so it would swallow a remote's key.
    for (const action of ACTIONS) {
        const pairs = settings.get_value(`keys-${action.key}`).deep_unpack();
        if (pairs.some(([keyval, mods]) => normal(Gtk.accelerator_name(keyval, mods)) === wanted))
            return `${action.title}, on the Controls page`;
    }
    for (const id of SYSTEM_KEYBINDINGS) {
        const schema = source.lookup(id, true);
        if (!schema)
            continue;
        const system = new Gio.Settings({settings_schema: schema});
        for (const name of schema.list_keys()) {
            const key = schema.get_key(name);
            if (key.get_value_type().dup_string() === 'as' && system.get_strv(name).some(a => normal(a) === wanted))
                return key.get_summary() || name;
        }
    }
    const custom = source.lookup(CUSTOM_KEYBINDING, true);
    if (custom && source.lookup(MEDIA_KEYS, true)) {
        for (const path of new Gio.Settings({schema_id: MEDIA_KEYS}).get_strv('custom-keybindings')) {
            const entry = new Gio.Settings({settings_schema: custom, path});
            if (normal(entry.get_string('binding')) === wanted)
                return entry.get_string('name') || 'a custom shortcut';
        }
    }
    return null;
}

function keyLabel(keyval, mods) {
    const named = REMOTE_KEYS[keyval];
    if (!named)
        return Gtk.accelerator_get_label(keyval, mods);
    // The modifiers' half of the label, off a key GTK does know.
    return mods ? Gtk.accelerator_get_label(Gdk.KEY_a, mods).slice(0, -1) + named : named;
}

// The gjs running these preferences, whatever PATH says.
function gjsPath() {
    try {
        return GLib.file_read_link('/proc/self/exe');
    } catch {
        return 'gjs';
    }
}

let manette = null;
function loadManette() {
    manette ??= import('gi://Manette').then(module => module.default, () => null);
    return manette;
}

// Every controller now and to come, each handed to `watch` with a `listen` that
// records its handler in `handlers`. The count of those already connected, or
// null without libmanette.
async function watchDevices(handlers, watch) {
    const Manette = await loadManette();
    if (!Manette)
        return null;
    const monitor = new Manette.Monitor();
    const listen = (object, signal, handler) => handlers.push([object, object.connect(signal, handler)]);
    listen(monitor, 'device-connected', (_m, device) => watch(device, listen));
    const devices = monitor.iterate();
    let device, count = 0;
    while (([, device] = devices.next()) && device) {
        watch(device, listen);
        count++;
    }
    return count;
}

// "tmdb@2" is the second TMDB key's slot; "wikipedia" takes none.
function sourceId(entry) {
    return entry.split('@')[0];
}
