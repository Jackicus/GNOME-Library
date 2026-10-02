// How actions reach a library: .claude/rules/keyboard.md.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';

import {ACTIONS} from './actions.js';
import {note} from './log.js';

export const NAVIGATION_KEYS = [
    Clutter.KEY_Tab, Clutter.KEY_ISO_Left_Tab,
    Clutter.KEY_Up, Clutter.KEY_Down, Clutter.KEY_Left, Clutter.KEY_Right,
];

const REPEAT_DELAY = 400;
const REPEAT_INTERVAL = 110;
// Two thresholds, so a stick at the edge does not chatter.
const AXIS_ON = 0.6;
const AXIS_OFF = 0.35;

const DIRECTIONS = new Set(['up', 'down', 'left', 'right']);

// GTK stores these with the same values as Clutter.
const SHIFT = Clutter.ModifierType.SHIFT_MASK;
const CONTROL = Clutter.ModifierType.CONTROL_MASK;
const ALT = Clutter.ModifierType.MOD1_MASK;
const SUPER = Clutter.ModifierType.SUPER_MASK;

function keyId(keyval, state) {
    let mods = state & (SHIFT | CONTROL | ALT);
    if (state & (SUPER | Clutter.ModifierType.MOD4_MASK))
        mods |= SUPER;
    if (keyval >= 0x41 && keyval <= 0x5a)
        keyval += 0x20;
    return `${keyval}:${mods}`;
}

// The enabled instance, for the views' key handlers.
let current = null;

export function handleBoundKey(event) {
    return current?._onKey(event) ?? false;
}

export class Controls {
    constructor(settings, {isActive, onHome, onOpen, currentView}) {
        this._settings = settings;
        this._isActive = isActive;
        this._onHome = onHome;
        this._onOpen = onOpen;
        this._currentView = currentView;
        this._keys = new Map();
        this._pad = new Map();
        this._device = null;
        this._monitor = null;
        this._pads = new Set();
        this._axes = new Map();
        this._held = new Map();
        this._starting = null;
    }

    enable() {
        current = this;
        this._device = Clutter.get_default_backend().get_default_seat()
            .create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        for (const action of ACTIONS) {
            this._settings.connectObject(`changed::keys-${action.key}`, () => this._readKeys(), this);
            this._settings.connectObject(`changed::pad-${action.key}`, () => this._readPad(), this);
        }
        this._settings.connectObject('changed::gamepad-enabled', () => this._syncPads(), this);
        this._readKeys();
        this._readPad();
        this._syncPads();
    }

    disable() {
        if (current === this)
            current = null;
        this._settings.disconnectObject(this);
        this._stopPads();
        this._device = null;
    }

    // A replayed key bound by hand (Escape to Back) would replay itself forever.
    _readKeys() {
        this._keys.clear();
        const replayed = new Set(ACTIONS.filter(a => a.stands).map(a => Clutter[`KEY_${a.stands}`]));
        for (const action of ACTIONS) {
            for (const [keyval, mods] of this._settings.get_value(`keys-${action.key}`).deep_unpack()) {
                if (!(mods === 0 && replayed.has(keyval)))
                    this._keys.set(keyId(keyval, mods), action);
            }
        }
    }

    _readPad() {
        this._pad.clear();
        for (const action of ACTIONS) {
            for (const input of this._settings.get_strv(`pad-${action.key}`))
                this._pad.set(input, action);
        }
    }

    _onKey(event) {
        if (event.type() !== Clutter.EventType.KEY_PRESS)
            return false;
        const action = this._keys.get(keyId(event.get_key_symbol(), event.get_state()));
        if (!action)
            return false;
        this._do(action);
        return true;
    }

    _do(action) {
        if (action.stands) {
            this._press(Clutter[`KEY_${action.stands}`]);
            return;
        }
        switch (action.key) {
        case 'home':
            this._onHome();
            break;
        case 'page-previous':
            this._turnPage(-1);
            break;
        case 'page-next':
            this._turnPage(1);
            break;
        case 'watched':
            global.stage.get_key_focus()?.toggleWatched?.();
            break;
        }
    }

    _press(keyval) {
        const time = GLib.get_monotonic_time();
        this._device?.notify_keyval(time, keyval, Clutter.KeyState.PRESSED);
        this._device?.notify_keyval(time, keyval, Clutter.KeyState.RELEASED);
    }

    _turnPage(delta) {
        let view = global.stage.get_key_focus();
        while (view && !view.pageBy)
            view = view.get_parent();
        (view ?? this._currentView())?.pageBy(delta);
    }

    _syncPads() {
        if (this._settings.get_boolean('gamepad-enabled'))
            this._startPads();
        else
            this._stopPads();
    }

    // libmanette is optional: the extension works without it.
    async _startPads() {
        if (this._monitor || this._starting)
            return;
        const starting = this._starting = {};
        let Manette;
        try {
            ({default: Manette} = await import('gi://Manette'));
        } catch {
            note('libmanette is not installed; game controllers are not read.');
            return;
        } finally {
            if (this._starting === starting)
                this._starting = null;
        }
        if (current !== this || !this._settings.get_boolean('gamepad-enabled') || this._monitor)
            return;
        this._monitor = new Manette.Monitor();
        this._monitor.connectObject('device-connected', (_monitor, device) => this._addPad(device), this);
        const devices = this._monitor.iterate();
        let device;
        while (([, device] = devices.next()) && device)
            this._addPad(device);
    }

    _stopPads() {
        this._starting = null;
        for (const pad of this._pads)
            pad.disconnectObject(this);
        this._pads.clear();
        this._monitor?.disconnectObject(this);
        this._monitor = null;
        this._axes.clear();
        for (const held of this._held.values()) {
            if (held.timer)
                GLib.source_remove(held.timer);
        }
        this._held.clear();
    }

    _addPad(device) {
        this._pads.add(device);
        device.connectObject(
            'button-press-event', (_d, event) => this._onButton(device, event, true),
            'button-release-event', (_d, event) => this._onButton(device, event, false),
            'absolute-axis-event', (_d, event) => {
                const [ok, axis, value] = event.get_absolute();
                if (ok)
                    this._onAxis(device, axis, value);
            },
            'hat-axis-event', (_d, event) => {
                const [ok, axis, value] = event.get_hat();
                if (ok)
                    this._onAxis(device, axis, value);
            },
            'disconnected', () => {
                device.disconnectObject(this);
                this._pads.delete(device);
                for (const [id, held] of this._held) {
                    if (held.device === device)
                        this._release(id);
                }
            },
            this);
    }

    // An unmapped pad reports its own codes, as the preferences recorded them.
    _onButton(device, event, pressed) {
        const [ok, button] = event.get_button();
        const input = `button:${ok ? button : event.get_hardware_code()}`;
        if (pressed)
            this._hold(device, input);
        else
            this._release(`${device.get_guid()}/${input}`);
    }

    _onAxis(device, axis, value) {
        const id = `${device.get_guid()}/${axis}`;
        const was = this._axes.get(id) ?? 0;
        let now = was;
        if (Math.abs(value) >= AXIS_ON)
            now = Math.sign(value);
        else if (Math.abs(value) < AXIS_OFF)
            now = 0;
        if (now === was)
            return;
        this._axes.set(id, now);
        if (was)
            this._release(`${device.get_guid()}/axis:${axis}${was < 0 ? '-' : '+'}`);
        if (now)
            this._hold(device, `axis:${axis}${now < 0 ? '-' : '+'}`);
    }

    _hold(device, input) {
        const action = this._pad.get(input);
        if (!action)
            return;
        if (!this._isActive()) {
            if (action.key === 'home')
                this._onOpen();
            return;
        }
        this._do(action);
        if (!DIRECTIONS.has(action.key))
            return;
        const id = `${device.get_guid()}/${input}`;
        this._release(id);
        const held = {device, timer: 0};
        this._held.set(id, held);
        held.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_DELAY, () => {
            held.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REPEAT_INTERVAL, () => {
                if (!this._isActive()) {
                    held.timer = 0;
                    this._held.delete(id);
                    return GLib.SOURCE_REMOVE;
                }
                this._do(action);
                return GLib.SOURCE_CONTINUE;
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    _release(id) {
        const held = this._held.get(id);
        if (!held)
            return;
        if (held.timer)
            GLib.source_remove(held.timer);
        this._held.delete(id);
    }
}
