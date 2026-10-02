import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Pango from 'gi://Pango';

import {SECTIONS as LIBRARY_SECTIONS, openCommandKey, readSections} from './lib/library.js';
import {ACTIONS, NATIVE_KEYS, padLabel} from './lib/actions.js';

// A key's Import reads ~/Documents/keys/<service>/<key.file>.
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
        key: {title: 'API key', file: 'API KEY.txt'},
    },
    wikipedia: {
        title: 'Wikipedia',
        blurb: 'Free and keyless. A poster and the lead paragraph, and little else.',
        help: 'https://www.wikipedia.org/',
        helpHint: 'wikipedia.org — no account needed',
    },
};

const VIDEO_OPENER = {
    title: 'Video player command',
    hint: 'The default plays in VLC full screen and closes it at the end. For example "mpv --fullscreen" instead; watched marks and resuming need a player that shows up in the media controls, which for mpv means mpv-mpris.',
};

const PAGES = {
    tv: {
        lower: 'TV shows', noun: 'shows',
        layout: 'One folder per show. Seasons can be subfolders ("Season 2") or SxxEyy in the file names.',
        online: 'Where artwork, synopsis, genres and ratings come from.',
        sources: ['tvmaze', 'tmdb', 'wikipedia'],
        opener: VIDEO_OPENER,
    },
    films: {
        lower: 'films', noun: 'films',
        layout: 'One folder or file per film, named "Title (Year)". The largest video in a folder is the feature.',
        online: 'Where posters, synopses, genres and ratings come from.',
        sources: ['tmdb', 'wikipedia'],
        opener: VIDEO_OPENER,
    },
};

const SECTIONS = LIBRARY_SECTIONS.map(section => ({...section, ...PAGES[section.key]}));

const SHORTCUT_KEY = 'library-shortcut';

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
// Libadwaita's from 1.8 (GNOME 49); GTK's, deprecated since, before that.
const ShortcutLabel = Adw.ShortcutLabel ?? Gtk.ShortcutLabel;

// What a remote's keys are called. GTK's table predates the keys xkbcommon
// gives a remote's evdev codes (0x10081xxx) and shows those as numbers.
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

export default class VideoLibraryPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(720, 640);
        window.set_search_enabled(true);

        const state = {
            window,
            settings,
            counts: this._readCounts(),
            refreshCounts: [],
            padMonitor: null,
            padHandlers: [],
        };

        window.add(this._generalPage(state));
        window.add(this._controlsPage(state));
        for (const section of SECTIONS)
            window.add(this._sectionPage(state, section));

        // The Extensions app outlives its windows: no handler of a closed one
        // may stay connected to a controller.
        window.connect('close-request', () => {
            for (const [object, id] of state.padHandlers)
                object.disconnect(id);
            state.padHandlers = [];
            state.padMonitor = null;
            return false;
        });
    }

    // A slot ("tmdb@1") is one key: sections naming the same slot share it.
    _credentials(settings) {
        return settings.get_value('credentials').deep_unpack();
    }

    _credential(settings, slot) {
        return this._credentials(settings)[slot] ?? '';
    }

    _setCredential(settings, slot, value) {
        const all = this._credentials(settings);
        if (value)
            all[slot] = value;
        else
            delete all[slot];
        settings.set_value('credentials', new GLib.Variant('a{ss}', all));
    }

    _credentialReady(settings, slot) {
        return this._credential(settings, slot).trim() !== '';
    }

    _pruneCredentials(settings) {
        const used = new Set();
        for (const section of SECTIONS) {
            for (const entry of settings.get_strv(`${section.prefix}-sources`))
                used.add(entry);
        }
        const all = this._credentials(settings);
        const orphans = Object.keys(all).filter(slot => !used.has(slot));
        if (!orphans.length)
            return;
        for (const slot of orphans)
            delete all[slot];
        settings.set_value('credentials', new GLib.Variant('a{ss}', all));
    }

    _sharedWith(settings, section, entry) {
        if (!entry.includes('@'))
            return [];
        return SECTIONS
            .filter(other => other.key !== section.key &&
                settings.get_strv(`${other.prefix}-sources`).includes(entry))
            .map(other => other.title);
    }

    _generalPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const view = new Adw.PreferencesGroup({title: 'View'});
        page.add(view);

        const PLACES = [
            ['menu', 'Menu'],
            ['desktop', 'Desktop'],
            ['workspaces', 'Workspaces'],
            ['modal', 'Modal'],
        ];
        const toggles = () => {
            // `can_shrink` off, so a label is never ellipsized to fit the row.
            const group = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
            for (const [name, label] of PLACES)
                group.add(new Adw.Toggle({name, label}));
            return group;
        };
        const modes = toggles();
        const viewRow = new Adw.ActionRow({title: 'Library opens in'});
        viewRow.add_suffix(modes);
        view.add(viewRow);

        const details = toggles();
        const detailRow = new Adw.ActionRow({title: 'Items open in'});
        detailRow.add_suffix(details);
        view.add(detailRow);

        const playRow = new Adw.SwitchRow({
            title: 'Play on a new workspace',
            subtitle: 'The player opens on an empty workspace of its own, leaving the one you picked from as it was',
        });
        settings.bind('play-on-new-workspace', playRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        view.add(playRow);

        const workspaces = new Adw.ActionRow({
            title: 'Workspaces Video Library is using stay open',
            subtitle: 'A workspace opened for the library or for a picked item is held until you close it or go back from it, so GNOME does not fold it away. With a fixed number of workspaces, set enough in Settings → Multitasking.',
            sensitive: false,
        });
        view.add(workspaces);

        page.add(this._shortcutsGroup(state));

        const appearance = new Adw.PreferencesGroup({title: 'Appearance'});
        page.add(appearance);

        // The tick marks the schema's default.
        const slider = (key, min, max) => {
            const scale = new Gtk.Scale({
                orientation: Gtk.Orientation.HORIZONTAL,
                adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: 1}),
                digits: 0,
                draw_value: true,
                value_pos: Gtk.PositionType.RIGHT,
                hexpand: true,
                width_request: 220,
                valign: Gtk.Align.CENTER,
            });
            scale.add_mark(settings.get_default_value(key).deep_unpack(), Gtk.PositionType.BOTTOM, null);
            scale.set_value(settings.get_int(key));
            scale.connect('value-changed', () => settings.set_int(key, Math.round(scale.get_value())));
            settings.connect(`changed::${key}`, () => {
                if (Math.round(scale.get_value()) !== settings.get_int(key))
                    scale.set_value(settings.get_int(key));
            });
            return scale;
        };

        const rowsRow = new Adw.ActionRow({
            title: 'Rows',
            subtitle: 'Covers down a page. Fewer means larger covers.',
        });
        rowsRow.add_suffix(slider('rows', 1, 3));
        appearance.add(rowsRow);

        const columnsRow = new Adw.ActionRow({
            title: 'Columns',
            subtitle: 'Covers across a page. Fewer means larger covers. A small space — the grid in the overview, a small screen — fits fewer of either.',
        });
        columnsRow.add_suffix(slider('columns', 4, 10));
        appearance.add(columnsRow);

        const align = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
        align.add(new Adw.Toggle({name: 'center', label: 'Centre'}));
        align.add(new Adw.Toggle({name: 'start', label: 'Left'}));
        align.set_active_name(settings.get_string('grid-align'));
        align.connect('notify::active-name', () => settings.set_string('grid-align', align.get_active_name()));
        settings.connect('changed::grid-align', () => {
            if (align.get_active_name() !== settings.get_string('grid-align'))
                align.set_active_name(settings.get_string('grid-align'));
        });
        const alignRow = new Adw.ActionRow({
            title: 'Align covers',
            subtitle: 'Where a row that is not full sits',
        });
        alignRow.add_suffix(align);
        appearance.add(alignRow);

        const radiusRow = new Adw.ActionRow({
            title: 'Corner radius',
            subtitle: 'How rounded covers, tiles and the detail pane are, in pixels. 0 is square.',
        });
        radiusRow.add_suffix(slider('corner-radius', 0, 40));
        appearance.add(radiusRow);

        const detailSizeRow = new Adw.ActionRow({
            title: 'Detail pop-up size',
            subtitle: 'How much of the available room the pop-up fills, as a percentage',
        });
        detailSizeRow.add_suffix(slider('detail-size', 80, 120));
        appearance.add(detailSizeRow);

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
        const chosen = key => settings.get_string(key);
        const syncView = () => {
            const mode = chosen('library-opens-in');
            const detail = chosen('detail-opens-in');
            if (modes.active_name !== mode)
                modes.active_name = mode;
            if (details.active_name !== detail)
                details.active_name = detail;
            // Under the heading, not in the rows, where it would squeeze the toggles.
            view.description = `${VIEWS[mode]} ${DETAILS[detail]}`;
            workspaces.visible = mode === 'workspaces' || detail === 'workspaces';
            detailSizeRow.sensitive = detail === 'menu' || detail === 'modal';
        };
        for (const [group, key] of [[modes, 'library-opens-in'], [details, 'detail-opens-in']]) {
            group.connect('notify::active-name', () => {
                if (group.active_name && group.active_name !== settings.get_string(key))
                    settings.set_string(key, group.active_name);
            });
            settings.connect(`changed::${key}`, syncView);
        }
        syncView();

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
                console.warn(`[Video Library] Could not open Settings: ${e.message}`);
            }
        });
        appearance.add(accent);

        const tracking = new Adw.PreferencesGroup({title: 'Watched'});
        page.add(tracking);
        const TRACKING = {
            source: 'Every mark is kept on this computer, and each library folder also gets a copy of its own marks, so another computer using the same folder picks them up.',
            local: 'Marks are kept on this computer only. Switching from Folders removes the copies from the folders; switching back puts them back.',
            none: 'Nothing is marked as watched. What was marked before is kept, for when this is turned back on.',
        };
        const where = new Adw.ToggleGroup({valign: Gtk.Align.CENTER, homogeneous: true, can_shrink: false});
        where.add(new Adw.Toggle({name: 'source', label: 'Folders'}));
        where.add(new Adw.Toggle({name: 'local', label: 'Local'}));
        where.add(new Adw.Toggle({name: 'none', label: 'Off'}));
        const trackingRow = new Adw.ActionRow({title: 'Keep marks in'});
        trackingRow.add_suffix(where);
        tracking.add(trackingRow);
        const syncTracking = () => {
            const mode = settings.get_string('tracking');
            if (where.active_name !== mode)
                where.active_name = mode;
            tracking.description = TRACKING[mode];
        };
        where.connect('notify::active-name', () => {
            if (where.active_name && where.active_name !== settings.get_string('tracking'))
                settings.set_string('tracking', where.active_name);
        });
        settings.connect('changed::tracking', syncTracking);
        syncTracking();

        const thresholdRow = new Adw.ActionRow({
            title: 'Watched after',
            subtitle: 'How far through an episode or film playback has to get, as a percentage. Works with any player that shows up in the media controls, VLC included.',
        });
        thresholdRow.add_suffix(slider('watched-threshold', 50, 100));
        tracking.add(thresholdRow);

        const resumeRow = new Adw.SwitchRow({
            title: 'Continue where you left off',
            subtitle: 'Playing something again from the library picks up where it stopped. Something marked watched starts from the beginning.',
        });
        settings.bind('resume-playback', resumeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        tracking.add(resumeRow);

        const rewindRow = new Adw.ActionRow({
            title: 'Rewind on resume',
            subtitle: 'Seconds before where it stopped, so the moment it was left at is seen again',
        });
        rewindRow.add_suffix(slider('resume-rewind', 0, 60));
        settings.bind('resume-playback', rewindRow, 'sensitive', Gio.SettingsBindFlags.GET);
        tracking.add(rewindRow);

        const syncPlayback = () => {
            const on = settings.get_string('tracking') !== 'none';
            thresholdRow.sensitive = on;
            resumeRow.sensitive = on;
        };
        settings.connect('changed::tracking', syncPlayback);
        syncPlayback();

        const library = new Adw.PreferencesGroup({
            title: 'Library',
            description: 'Folders, sources and API keys are on each section\'s own page.',
        });
        page.add(library);

        const rescan = new Adw.ActionRow({
            title: 'Rescan everything',
            subtitle: this._lastScanText(),
        });
        rescan.add_suffix(this._scanButton(state, SECTIONS));
        state.refreshCounts.push(() => rescan.set_subtitle(this._lastScanText()));
        library.add(rescan);

        return page;
    }

    _shortcutsGroup(state) {
        const {settings} = state;
        const group = new Adw.PreferencesGroup({title: 'Keyboard Shortcut'});
        const row = new Adw.ActionRow({
            title: 'Open the library',
            subtitle: 'From anywhere, wherever the library opens; the same shortcut again closes it. None is set to begin with.',
            activatable: true,
        });
        const label = new ShortcutLabel({disabled_text: 'Disabled', valign: Gtk.Align.CENTER});
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove this shortcut', css_classes: ['flat'],
        });
        clear.connect('clicked', () => settings.set_strv(SHORTCUT_KEY, []));
        row.add_suffix(label);
        row.add_suffix(clear);
        const sync = () => {
            const accel = settings.get_strv(SHORTCUT_KEY)[0] ?? '';
            label.accelerator = accel;
            clear.visible = accel !== '';
        };
        settings.connect(`changed::${SHORTCUT_KEY}`, sync);
        sync();
        row.connect('activated', () => this._captureShortcut(state));
        group.add(row);
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
                // Unmodified, only a function key or the XF86 range (media keys, and a
                // remote's 0x10081xxx) may be a shortcut.
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
        const status = new Adw.StatusPage({
            icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
            title,
            description,
        });
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

        // As GNOME Settings does: a key the system has taken reaches the dialog.
        const surface = window.get_surface();
        surface?.inhibit_system_shortcuts?.(null);
        dialog.connect('closed', () => surface?.restore_system_shortcuts?.());
        dialog.present(window);
        return dialog;
    }

    _controlsPage(state) {
        const {settings} = state;
        const page = new Adw.PreferencesPage({title: 'Controls', icon_name: 'input-gaming-symbolic'});

        const keys = new Adw.PreferencesGroup({
            title: 'Remote and Keyboard',
            description: 'The arrow keys, Enter and Escape always work. Add the keys a remote, a Pico or anything else that acts as a keyboard sends: they do these things while a library is on screen, and what they always did everywhere else.',
        });
        page.add(keys);
        const pairs = action => settings.get_value(`keys-${action.key}`).deep_unpack();
        for (const action of ACTIONS) {
            keys.add(this._bindingRow(settings, action, {
                key: `keys-${action.key}`,
                labels: () => pairs(action).map(([keyval, mods]) => keyLabel(keyval, mods)),
                add: () => this._captureNavKey(state, action),
                addTip: 'Add a key',
            }));
        }
        keys.add(this._resetRow(settings, ACTIONS.map(a => `keys-${a.key}`)));

        const pads = new Adw.PreferencesGroup({
            title: 'Game Controller',
            description: 'Read only while a library is on screen, so games are left alone — except Home, which also opens the library when no window has the keyboard. Xbox, PlayStation and most other pads are ready as they are; anything else, a Pico running as a gamepad included, is set up by pressing its buttons here.',
        });
        page.add(pads);
        const use = new Adw.SwitchRow({title: 'Use game controllers'});
        settings.bind('gamepad-enabled', use, 'active', Gio.SettingsBindFlags.DEFAULT);
        pads.add(use);
        const connected = new Adw.ActionRow({title: 'Connected', subtitle: 'Looking…'});
        pads.add(connected);
        const padRows = [connected];
        for (const action of ACTIONS) {
            padRows.push(this._bindingRow(settings, action, {
                key: `pad-${action.key}`,
                // A mapped pad's D-pad is buttons, an unmapped one's a hat: one name for both.
                labels: () => [...new Set(settings.get_strv(`pad-${action.key}`).map(padLabel))],
                subtitle: action.subtitle ?? null,
                add: () => this._capturePad(state, action),
                addTip: 'Add a button',
            }));
        }
        padRows.push(this._resetRow(settings, ACTIONS.map(a => `pad-${a.key}`)));
        for (const row of padRows) {
            settings.bind('gamepad-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            if (row !== connected)
                pads.add(row);
        }
        this._watchPads(state, connected);

        return page;
    }

    _bindingRow(settings, action, {key, labels, add, addTip, subtitle = action.subtitle ?? 'Besides the arrow key'}) {
        const row = new Adw.ActionRow({title: action.title});
        if (subtitle)
            row.subtitle = subtitle;
        const shown = new Gtk.Label({
            css_classes: ['dim-label'],
            ellipsize: Pango.EllipsizeMode.END,
            max_width_chars: 22,
            valign: Gtk.Align.CENTER,
        });
        const addButton = new Gtk.Button({
            icon_name: 'list-add-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: addTip, css_classes: ['flat'],
        });
        const clear = new Gtk.Button({
            icon_name: 'edit-clear-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove them all', css_classes: ['flat'],
        });
        addButton.connect('clicked', add);
        clear.connect('clicked', () => settings.set_value(key,
            new GLib.Variant(settings.get_value(key).get_type_string(), [])));
        row.add_suffix(shown);
        row.add_suffix(addButton);
        row.add_suffix(clear);
        row.activatable_widget = addButton;
        const sync = () => {
            const names = labels();
            shown.label = names.length ? names.join(', ') : 'None';
            shown.tooltip_text = names.join(', ');
            clear.sensitive = names.length > 0;
        };
        settings.connect(`changed::${key}`, sync);
        sync();
        return row;
    }

    _resetRow(settings, keys) {
        const row = new Adw.ActionRow({title: 'Put back the defaults'});
        const button = new Gtk.Button({label: 'Reset', valign: Gtk.Align.CENTER});
        button.connect('clicked', () => keys.forEach(key => settings.reset(key)));
        row.add_suffix(button);
        return row;
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

        const Manette = await loadManette();
        if (!Manette) {
            status.description = 'libmanette is not installed, so controllers cannot be read.';
            return;
        }
        const monitor = new Manette.Monitor();
        const handlers = [];
        const listen = (object, signal, handler) => handlers.push([object, object.connect(signal, handler)]);
        const rest = new Map();
        const take = input => {
            const bound = settings.get_strv(key);
            if (bound.includes(input)) {
                dialog.close();
                return;
            }
            const owner = ACTIONS.find(other => other !== action &&
                settings.get_strv(`pad-${other.key}`).includes(input));
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
        const watch = device => {
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
        };
        listen(monitor, 'device-connected', (_m, device) => watch(device));
        const devices = monitor.iterate();
        let device, count = 0;
        while (([, device] = devices.next()) && device) {
            watch(device);
            count++;
        }
        if (!count)
            status.description = 'No controller is connected. Connect one and press a button on it, or Esc to cancel.';
        dialog.connect('closed', () => {
            for (const [object, id] of handlers)
                object.disconnect(id);
            handlers.length = 0;
        });
    }

    async _watchPads(state, row) {
        const Manette = await loadManette();
        if (!Manette) {
            row.subtitle = 'libmanette is not installed, so controllers cannot be read.';
            return;
        }
        const monitor = state.padMonitor = new Manette.Monitor();
        const listen = (object, signal, handler) =>
            state.padHandlers.push([object, object.connect(signal, handler)]);
        const names = new Map();
        const sync = () => {
            row.subtitle = names.size ? [...names.values()].join(', ') : 'None';
        };
        const add = device => {
            names.set(device, device.get_name());
            listen(device, 'disconnected', () => {
                names.delete(device);
                sync();
            });
            sync();
        };
        listen(monitor, 'device-connected', (_m, device) => add(device));
        const devices = monitor.iterate();
        let device;
        while (([, device] = devices.next()) && device)
            add(device);
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

        this._foldersGroup(state, section, files);

        page.add(this._sourcesGroup(state, section));

        page.add(this._openerGroup(state, section));

        const library = new Adw.PreferencesGroup({title: 'Library'});
        page.add(library);

        const status = new Adw.ActionRow({
            title: 'Indexed',
            subtitle: this._countText(state.counts, section),
        });
        status.add_suffix(this._scanButton(state, [section]));
        state.refreshCounts.push(() => status.set_subtitle(this._countText(state.counts, section)));
        library.add(status);

        return page;
    }

    _openerGroup(state, section) {
        const {settings} = state;
        const key = openCommandKey(section);
        const group = new Adw.PreferencesGroup({title: 'Opening'});

        const command = new Adw.EntryRow({
            title: section.opener.title,
            text: settings.get_string(key),
            show_apply_button: true,
        });
        command.connect('apply', () => settings.set_string(key, command.get_text().trim()));
        settings.connect(`changed::${key}`, () => {
            const value = settings.get_string(key);
            if (command.get_text().trim() !== value)
                command.set_text(value);
        });
        group.add(command);
        group.add(new Adw.ActionRow({
            title: 'Leave empty for the system default',
            subtitle: `${section.opener.hint} The file's path is added to the end. A program that is not installed falls back to the system default.`,
            sensitive: false,
        }));
        return group;
    }

    _sourcesGroup(state, section) {
        const {settings} = state;
        const key = `${section.prefix}-sources`;
        const offered = section.sources ?? [];

        const group = new Adw.PreferencesGroup({
            title: 'Information sources',
            description: section.online,
        });

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
        for (const id of offered)
            menu.append(SOURCES[id].title, `sources.add('${id}')`);
        group.set_header_suffix(new Gtk.MenuButton({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add a source',
            css_classes: ['flat'],
            menu_model: menu,
        }));

        const rows = [];
        const syncers = [];
        const rebuild = () => {
            for (const row of rows.splice(0))
                group.remove(row);
            syncers.length = 0;
            const list = settings.get_strv(key);
            if (!list.length) {
                const empty = new Adw.ActionRow({
                    title: 'No sources',
                    subtitle: `Nothing is looked up for ${section.lower}. Add one above.`,
                    sensitive: false,
                });
                group.add(empty);
                rows.push(empty);
                return;
            }
            list.forEach((entry, index) => {
                const built = this._sourceRow(state, section, entry, index, list);
                group.add(built.row);
                rows.push(built.row);
                if (built.sync)
                    syncers.push(built.sync);
            });
        };

        const refresh = () => syncers.forEach(sync => sync());
        settings.connect(`changed::${key}`, rebuild);
        // Refreshed, not rebuilt, so an entry being typed into keeps its cursor.
        settings.connect('changed::credentials', refresh);
        for (const other of SECTIONS) {
            if (other.key !== section.key)
                settings.connect(`changed::${other.prefix}-sources`, refresh);
        }
        rebuild();
        return group;
    }

    _sourceRow(state, section, entry, index, list) {
        const {settings} = state;
        const id = sourceId(entry);
        const spec = SOURCES[id];
        const slot = entry.includes('@') ? entry : null;
        const field = spec?.key ?? null;

        const row = new Adw.ExpanderRow({
            title: spec?.title ?? id,
            tooltip_text: spec?.blurb ?? '',
        });

        const sync = () => {
            if (!spec)
                row.set_subtitle('Unknown source — remove it or fix the setting');
            else if (!slot || !field)
                row.set_subtitle('No key needed');
            else {
                const shared = this._sharedWith(settings, section, entry);
                const which = `Key ${entry.split('@')[1]}`;
                const where = shared.length ? ` · shared with ${shared.join(' and ')}` : '';
                row.set_subtitle(this._credentialReady(settings, slot)
                    ? `${which} is set${where}`
                    : `${which} is not set — skipped${where}`);
            }
        };
        sync();

        const move = (to) => {
            const next = [...list];
            next.splice(to, 0, ...next.splice(index, 1));
            settings.set_strv(`${section.prefix}-sources`, next);
        };
        const remove = new Gtk.Button({
            icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Remove this source', css_classes: ['flat'],
        });
        remove.connect('clicked', () => {
            settings.set_strv(`${section.prefix}-sources`, list.filter((_, i) => i !== index));
            this._pruneCredentials(settings);
        });

        const down = new Gtk.Button({
            icon_name: 'go-down-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Try this one later', css_classes: ['flat'],
            sensitive: index < list.length - 1,
        });
        down.connect('clicked', () => move(index + 1));

        const up = new Gtk.Button({
            icon_name: 'go-up-symbolic', valign: Gtk.Align.CENTER,
            tooltip_text: 'Try this one sooner', css_classes: ['flat'],
            sensitive: index > 0,
        });
        up.connect('clicked', () => move(index - 1));

        let help = null;
        if (spec?.help) {
            help = new Gtk.Button({
                icon_name: 'help-about-symbolic',
                valign: Gtk.Align.CENTER,
                tooltip_text: field
                    ? `Get a ${spec.title} key — ${spec.helpHint}`
                    : `About ${spec.title} — ${spec.helpHint}`,
                css_classes: ['flat'],
            });
            help.connect('clicked', () => Gtk.show_uri(state.window, spec.help, Gdk.CURRENT_TIME));
        }

        // An expander row packs each suffix ahead of the last: added back to front.
        for (const button of [remove, down, up, help]) {
            if (button)
                row.add_suffix(button);
        }

        if (!field) {
            row.add_row(new Adw.PasswordEntryRow({
                title: spec ? `${spec.title} needs no key` : 'No key',
                sensitive: false,
            }));
            return {row, sync};
        }

        const value = new Adw.PasswordEntryRow({
            title: field.title,
            text: this._credential(settings, slot),
            show_apply_button: true,
        });
        value.connect('apply', () => {
            this._setCredential(settings, slot, value.get_text().trim());
            sync();
        });

        const dropFile = this._keyDropFile(spec.service, field.file);
        if (dropFile) {
            const importBtn = new Gtk.Button({
                label: 'Import',
                valign: Gtk.Align.CENTER,
                tooltip_text: `Read it from ${dropFile}`,
                css_classes: ['flat'],
            });
            importBtn.connect('clicked', () => {
                const imported = this._readKeyDrop(dropFile);
                if (!imported)
                    return;
                value.set_text(imported);
                this._setCredential(settings, slot, imported);
                sync();
            });
            value.add_suffix(importBtn);
        }
        row.add_row(value);

        return {
            row,
            sync: () => {
                const current = this._credential(settings, slot);
                // Not while typed into: the keys are in the row's text widget, so focus-within.
                const typing = value.get_state_flags() & Gtk.StateFlags.FOCUS_WITHIN;
                if (!typing && value.get_text() !== current)
                    value.set_text(current);
                sync();
            },
        };
    }

    _addSource(state, section, id) {
        const {settings} = state;
        const key = `${section.prefix}-sources`;
        const list = settings.get_strv(key);
        const spec = SOURCES[id];

        let entry = id;
        if (spec?.key) {
            let n = 1;
            while (list.includes(`${id}@${n}`))
                n++;
            entry = `${id}@${n}`;
        } else if (list.includes(id)) {
            return;   // a keyless source twice would only ask the same server twice
        }
        settings.set_strv(key, [...list, entry]);
    }

    // The value in the key drop, or '' if it cannot be read. Never logged.
    _readKeyDrop(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            return ok ? new TextDecoder().decode(bytes).trim() : '';
        } catch (e) {
            console.warn(`[Video Library] Could not read ${path}: ${e.message}`);
            return '';
        }
    }

    _keyDropFile(service, field) {
        if (!service || !field)
            return null;
        const docs = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) ?? GLib.get_home_dir();
        const path = GLib.build_filenamev([docs, 'keys', service, field]);
        return GLib.file_test(path, GLib.FileTest.IS_REGULAR) ? path : null;
    }

    _foldersGroup(state, section, group) {
        const {settings} = state;
        const key = `${section.prefix}-folders`;

        const add = new Gtk.Button({
            icon_name: 'list-add-symbolic',
            valign: Gtk.Align.CENTER,
            tooltip_text: 'Add a folder',
            css_classes: ['flat'],
        });
        add.connect('clicked', () => {
            const current = settings.get_strv(key);
            this._pickFolder(state.window, `Add a ${section.title} folder`, current.at(-1) ?? null, path => {
                if (!current.includes(path))
                    settings.set_strv(key, [...current, path]);
            });
        });
        group.set_header_suffix(add);

        const rows = [];
        const rebuild = () => {
            for (const row of rows.splice(0))
                group.remove(row);
            const list = settings.get_strv(key);
            if (!list.length) {
                const row = new Adw.ActionRow({
                    title: 'No folder',
                    subtitle: 'Nothing is scanned. Add a folder above.',
                    sensitive: false,
                });
                group.add(row);
                rows.push(row);
                return;
            }
            list.forEach((path, index) => {
                const row = new Adw.ActionRow({
                    title: list.length > 1 ? `Folder ${index + 1}` : 'Folder',
                    subtitle: path,
                    activatable: true,
                });
                this._checkFolder(row, path, () => settings.get_strv(key)[index] === path);
                const remove = new Gtk.Button({
                    icon_name: 'list-remove-symbolic',
                    valign: Gtk.Align.CENTER,
                    tooltip_text: 'Remove this folder',
                    css_classes: ['flat'],
                });
                remove.connect('clicked', () => {
                    settings.set_strv(key, settings.get_strv(key).filter((_, i) => i !== index));
                });
                row.add_suffix(remove);
                row.connect('activated', () => {
                    this._pickFolder(state.window, `Choose ${section.title} folder`, path, chosen => {
                        const next = settings.get_strv(key);
                        next[index] = chosen;
                        settings.set_strv(key, [...new Set(next)]);
                    });
                });
                group.add(row);
                rows.push(row);
            });
        };
        settings.connect(`changed::${key}`, rebuild);
        rebuild();
    }

    // <prefix>-path held a section's one folder before <prefix>-folders.
    // Asynchronous: a share that has idled out takes seconds to stat.
    _checkFolder(row, path, stillCurrent) {
        const text = row.get_subtitle();
        Gio.File.new_for_path(path).query_info_async(
            'standard::type', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_DEFAULT, null,
            (file, result) => {
                let found = false;
                try {
                    found = file.query_info_finish(result).get_file_type() === Gio.FileType.DIRECTORY;
                } catch {
                    // Missing or unreachable: the row says the same either way.
                }
                if (!found && stillCurrent())
                    row.set_subtitle(`${text}  — not found`);
            });
    }

    _pickFolder(window, title, initial, onChosen) {
        const dialog = new Gtk.FileDialog({
            title,
            modal: true,
            initial_folder: Gio.File.new_for_path(
                initial ??
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_VIDEOS) ?? GLib.get_home_dir()),
        });
        dialog.select_folder(window, null, (source, result) => {
            try {
                const file = source.select_folder_finish(result);
                if (file)
                    onChosen(file.get_path());
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
        if (n === null || n === undefined)
            return 'Not scanned yet';
        return `${n} ${section.noun}`;
    }

    _lastScanText() {
        const counts = this._readCounts();
        if (!counts.generated)
            return 'The library has not been scanned yet';
        const when = GLib.DateTime.new_from_unix_local(Math.floor(counts.generated));
        return `Last scanned ${when.format('%-d %b %H:%M')}`;
    }

    // The scanner reads its settings itself; `--only` narrows it to `sections`.
    _scanButton(state, sections) {
        const content = new Adw.ButtonContent({label: 'Rescan', icon_name: 'view-refresh-symbolic'});
        const button = new Gtk.Button({child: content, valign: Gtk.Align.CENTER, css_classes: ['flat']});

        button.connect('clicked', () => {
            const enabled = sections.filter(s => state.settings.get_boolean(`${s.prefix}-enabled`));
            if (!enabled.length) {
                content.set_label('Nothing enabled');
                return;
            }
            // One with no folder still runs if it has items left to clear.
            const ready = enabled.filter(s =>
                state.settings.get_strv(`${s.prefix}-folders`).length || state.counts[s.key]);
            if (!ready.length) {
                content.set_label('No folder set');
                return;
            }
            const argv = [
                gjsPath(), '-m',
                GLib.build_filenamev([this.path, 'backend', 'scanLibrary.js']),
                '--from-settings',
            ];
            for (const s of ready)
                argv.push('--only', s.key);

            button.set_sensitive(false);
            content.set_label('Scanning…');
            content.set_icon_name('content-loading-symbolic');
            try {
                const proc = Gio.Subprocess.new(
                    argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
                proc.communicate_utf8_async(null, null, (p, result) => {
                    let failed = false;
                    try {
                        const [, , stderr] = p.communicate_utf8_finish(result);
                        failed = !p.get_successful();
                        if (failed)
                            console.error(`[Video Library] Scan failed: ${stderr}`);
                    } catch (e) {
                        failed = true;
                        console.error(`[Video Library] Scan failed: ${e.message}`);
                    }
                    button.set_sensitive(true);
                    content.set_icon_name(failed ? 'dialog-warning-symbolic' : 'view-refresh-symbolic');
                    content.set_label(failed ? 'Failed — see logs' : 'Rescan');
                    state.counts = this._readCounts();
                    for (const refresh of state.refreshCounts)
                        refresh();
                });
            } catch (e) {
                console.error(`[Video Library] Could not launch scanner: ${e.message}`);
                button.set_sensitive(true);
                content.set_icon_name('dialog-warning-symbolic');
                content.set_label('Failed');
            }
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
            if (key.get_value_type().dup_string() !== 'as')
                continue;
            if (system.get_strv(name).some(a => normal(a) === wanted))
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

// "tmdb@2" is the second TMDB key's slot; "wikipedia" takes none.
function sourceId(entry) {
    return entry.split('@')[0];
}
