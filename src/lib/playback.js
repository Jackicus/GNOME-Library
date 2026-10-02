// Follows any MPRIS player; plays nothing (.claude/rules/tracking.md).

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_NAMESPACE = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';
const PROPERTIES = 'org.freedesktop.DBus.Properties';
const NO_TRACK = '/org/mpris/MediaPlayer2/TrackList/NoTrack';

// Only corrects drift and catches the threshold: the clock reckons between.
const POLL_SECONDS = 30;
const RESUME_WAIT = 60;
const MIN_POSITION = 30;

const clock = () => GLib.get_monotonic_time() / 1e6;

function isCancelled(e) {
    return e instanceof GLib.Error && e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

// A string operation, so safe on a share that is asleep.
function pathOf(url) {
    if (typeof url !== 'string' || !url.startsWith('file://'))
        return null;
    return Gio.File.new_for_uri(url).get_path();
}

class Player {
    constructor(owner) {
        this.owner = owner;
        this.path = null;
        this.trackId = null;
        this.length = 0;
        this.status = 'Stopped';
        this.rate = 1;
        this.canSeek = true;
        this.position = 0;
        this.readAt = clock();
        this.marked = false;
    }

    get now() {
        let position = this.position;
        if (this.status === 'Playing')
            position += (clock() - this.readAt) * this.rate;
        return this.length ? Math.min(position, this.length) : position;
    }

    read(position) {
        this.position = Math.max(0, position);
        this.readAt = clock();
    }

    settle() {
        this.read(this.now);
    }
}

export class PlaybackWatcher {
    constructor(settings, tracker) {
        this._settings = settings;
        this._tracker = tracker;
        this._bus = null;
        this._cancellable = null;
        this._subscriptions = [];
        // One process can hold two names (VLC takes a second per instance).
        this._players = new Map();
        this._names = new Map();
        this._pollId = 0;
        this._pending = null;
    }

    enable() {
        this._bus = Gio.DBus.session;
        this._cancellable = new Gio.Cancellable();
        const bus = this._bus;
        this._subscriptions = [
            bus.signal_subscribe('org.freedesktop.DBus', 'org.freedesktop.DBus', 'NameOwnerChanged',
                '/org/freedesktop/DBus', MPRIS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
                (_bus, _sender, _path, _iface, _signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (oldOwner)
                        this._dropName(name);
                    if (newOwner)
                        this._addName(name, newOwner);
                }),
            bus.signal_subscribe(null, PROPERTIES, 'PropertiesChanged', MPRIS_PATH, PLAYER,
                Gio.DBusSignalFlags.NONE,
                (_bus, sender, _path, _iface, _signal, params) => {
                    const player = this._players.get(sender);
                    if (player)
                        this._apply(player, params.recursiveUnpack()[1]);
                }),
            bus.signal_subscribe(null, PLAYER, 'Seeked', MPRIS_PATH, null, Gio.DBusSignalFlags.NONE,
                (_bus, sender, _path, _iface, _signal, params) => {
                    const player = this._players.get(sender);
                    if (!player)
                        return;
                    player.read(params.recursiveUnpack()[0] / 1e6);
                    this._check(player);
                }),
        ];

        bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'ListNames',
            null, new GLib.VariantType('(as)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (_bus, result) => {
                let names;
                try {
                    [names] = bus.call_finish(result).deep_unpack();
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`[Library] Could not list media players: ${e.message}`);
                    return;
                }
                for (const name of names.filter(n => n.startsWith(`${MPRIS_NAMESPACE}.`)))
                    this._lookUpOwner(name);
            });
    }

    disable() {
        // A lock lands here mid-file: keep where it is; the unlock picks it up.
        for (const player of this._players.values())
            this._keep(player);
        for (const id of this._subscriptions)
            this._bus.signal_unsubscribe(id);
        this._subscriptions = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
        this._players.clear();
        this._names.clear();
        this._pending = null;
        this._bus = null;
    }

    resumeNext(path) {
        const position = this._settings.get_boolean('resume-playback') ? this._tracker.positionOf(path) : 0;
        this._pending = position ? {path, position, until: clock() + RESUME_WAIT} : null;
    }

    _lookUpOwner(name) {
        this._bus.call('org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus', 'GetNameOwner',
            new GLib.Variant('(s)', [name]), new GLib.VariantType('(s)'), Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (bus, result) => {
                try {
                    const [owner] = bus.call_finish(result).deep_unpack();
                    this._addName(name, owner);
                } catch {
                    // Gone again already, or cancelled: nothing to follow.
                }
            });
    }

    _addName(name, owner) {
        this._names.set(name, owner);
        if (this._players.has(owner))
            return;
        const player = new Player(owner);
        this._players.set(owner, player);
        this._bus.call(owner, MPRIS_PATH, PROPERTIES, 'GetAll', new GLib.Variant('(s)', [PLAYER]),
            new GLib.VariantType('(a{sv})'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, result) => {
                let props;
                try {
                    [props] = bus.call_finish(result).recursiveUnpack();
                } catch {
                    return;
                }
                if (this._players.get(owner) === player)
                    this._apply(player, props);
            });
    }

    _dropName(name) {
        const owner = this._names.get(name);
        this._names.delete(name);
        if (!owner || [...this._names.values()].includes(owner))
            return;
        const player = this._players.get(owner);
        this._players.delete(owner);
        if (player)
            this._keep(player);
        this._schedulePoll();
    }

    _apply(player, props) {
        if ('Rate' in props) {
            player.settle();
            player.rate = props.Rate > 0 ? props.Rate : 1;
        }
        if ('CanSeek' in props)
            player.canSeek = !!props.CanSeek;
        if ('Metadata' in props) {
            const meta = props.Metadata ?? {};
            const path = pathOf(meta['xesam:url']);
            if (path !== player.path) {
                        this._keep(player);
                player.path = path;
                player.marked = false;
                player.read(0);
            }
            player.trackId = meta['mpris:trackid'] ?? null;
            player.length = (meta['mpris:length'] ?? 0) / 1e6;
        }
        if ('PlaybackStatus' in props && props.PlaybackStatus !== player.status) {
            player.settle();
            const was = player.status;
            player.status = props.PlaybackStatus;
            // A stopped player reports 0, so only a pause is worth a reading.
            if (was === 'Playing' && player.status === 'Paused')
                this._readPosition(player, () => this._keep(player));
            else if (player.status === 'Stopped')
                this._keep(player);
        }
        if ('Position' in props)
            player.read(props.Position / 1e6);

        this._resume(player);
        this._check(player);
        this._schedulePoll();
    }

    _readPosition(player, then) {
        const {path} = player;
        this._bus.call(player.owner, MPRIS_PATH, PROPERTIES, 'Get', new GLib.Variant('(ss)', [PLAYER, 'Position']),
            new GLib.VariantType('(v)'), Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (bus, result) => {
                if (this._players.get(player.owner) !== player || player.path !== path)
                    return;
                try {
                    player.read(bus.call_finish(result).recursiveUnpack()[0] / 1e6);
                } catch (e) {
                    if (isCancelled(e))
                        return;
                }
                then();
            });
    }

    _following(player) {
        return !!player.path && this._tracker.covers(player.path);
    }

    _check(player) {
        if (player.marked)
            return true;
        if (!player.length || !this._following(player))
            return false;
        if (player.now < player.length * this._settings.get_int('watched-threshold') / 100)
            return false;
        player.marked = true;
        this._tracker.setWatched(player.path, true);
        return true;
    }

    // Short of MIN_POSITION the kept place stands: a quick look at the start
    // must not cost it.
    _keep(player) {
        if (!this._following(player) || this._check(player))
            return;
        if (!this._settings.get_boolean('resume-playback')) {
            this._tracker.setPosition(player.path, 0);
            return;
        }
        const at = player.now;
        if (at >= MIN_POSITION)
            this._tracker.setPosition(player.path, at);
    }

    _resume(player) {
        const pending = this._pending;
        if (!pending || player.path !== pending.path || player.status !== 'Playing')
            return;
        this._pending = null;
        const target = pending.position - this._settings.get_int('resume-rewind');
        if (clock() > pending.until || !player.canSeek || target <= 0)
            return;
        const [method, args] = player.trackId && player.trackId !== NO_TRACK
            ? ['SetPosition', new GLib.Variant('(ox)', [player.trackId, Math.round(target * 1e6)])]
            : ['Seek', new GLib.Variant('(x)', [Math.round((target - player.now) * 1e6)])];
        this._bus.call(player.owner, MPRIS_PATH, PLAYER, method, args, null, Gio.DBusCallFlags.NONE, -1,
            this._cancellable, (bus, result) => {
                try {
                    bus.call_finish(result);
                } catch (e) {
                    if (!isCancelled(e))
                        console.warn(`[Library] Could not resume ${player.path}: ${e.message}`);
                }
            });
        player.read(target);
    }

    _schedulePoll() {
        const playing = () => [...this._players.values()].filter(p => p.status === 'Playing' && this._following(p));
        if (playing().length && !this._pollId) {
            this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
                const now = playing();
                for (const player of now)
                    this._readPosition(player, () => this._check(player));
                if (now.length)
                    return GLib.SOURCE_CONTINUE;
                this._pollId = 0;
                return GLib.SOURCE_REMOVE;
            });
        } else if (!playing().length && this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }
}
