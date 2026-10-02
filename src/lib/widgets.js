import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';

import {Duration, Ease, fadeTo} from './anim.js';
import {radiusStyle} from './shape.js';

// The radius must travel in the same inline style as the image to round it.
export function artworkStyle(path, part = 'art') {
    return `background-image: url("file://${encodeURI(path)}"); background-size: cover; ${radiusStyle(part)}`;
}

export function createLabel(text, styleClass, props = {}) {
    const label = new St.Label({text, style_class: styleClass, ...props});
    label.clutter_text.single_line_mode = true;
    label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
    return label;
}

export function createArtwork({path, title, icon, width, height, styleClass = 'ml-art', radius = 'art'}) {
    const art = new St.Widget({
        style_class: styleClass,
        width,
        height,
        layout_manager: new Clutter.BinLayout(),
        // Not clipped, for the focus ring's box-shadow. No expand, or the
        // placeholder's expanding stack would stretch the artwork.
        x_expand: false,
        y_expand: false,
    });
    if (path) {
        art.set_style(artworkStyle(path, radius));
        return art;
    }

    art.set_style(radiusStyle(radius));
    art.add_style_class_name('ml-art-placeholder');
    const stack = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
        clip_to_allocation: true,
        style_class: 'ml-art-placeholder-content',
    });
    // `width` is physical, `icon_size` logical (as js/ui/iconGrid.js converts).
    const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor;
    stack.add_child(new St.Icon({
        icon_name: icon,
        icon_size: Math.max(24, Math.round(width * 0.22 / scale)),
        style_class: 'ml-art-placeholder-icon',
        x_align: Clutter.ActorAlign.CENTER,
    }));
    if (title && width >= 120 * scale) {
        const label = new St.Label({
            text: title,
            style_class: 'ml-art-placeholder-title',
            x_align: Clutter.ActorAlign.CENTER,
            width: Math.round(width * 0.8),
        });
        label.clutter_text.line_wrap = true;
        label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        label.clutter_text.x_align = Clutter.ActorAlign.CENTER;
        label.height = Math.min(64 * scale, Math.round(height * 0.3));
        stack.add_child(label);
    }
    art.add_child(stack);
    return art;
}

// No St.Icon child and no size: the theme's `.icon-button StIcon` sizes the
// glyph in em, so it follows Large Text.
export function createIconButton(iconName, {accessibleName} = {}) {
    return new St.Button({
        style_class: 'icon-button',
        can_focus: true,
        track_hover: true,
        accessible_name: accessibleName,
        icon_name: iconName,
    });
}

export function createActionButton({label, icon, styleClass = 'button default ml-action'}) {
    const content = new St.BoxLayout({style_class: 'ml-action-content', y_align: Clutter.ActorAlign.CENTER});
    if (icon)
        content.add_child(new St.Icon({icon_name: icon, icon_size: 16, y_align: Clutter.ActorAlign.CENTER}));
    const text = new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER});
    content.add_child(text);
    const button = new St.Button({
        style_class: styleClass,
        can_focus: true,
        track_hover: true,
        child: content,
    });
    button.setLabel = value => {
        text.text = value;
    };
    return button;
}

function crossFade(label, text) {
    label.remove_all_transitions();
    label.ease({
        opacity: 0,
        duration: Duration.FAST / 2,
        mode: Ease.OUT,
        onComplete: () => {
            label.text = text;
            label.ease({opacity: 255, duration: Duration.FAST, mode: Ease.OUT});
        },
    });
}

// Focus landing on a tab chooses it, so a remote's arrows alone switch sections.
function createTabs(sections, active, onSwitch) {
    const actor = new St.BoxLayout({style_class: 'ml-tabs', y_align: Clutter.ActorAlign.CENTER});
    const tabs = new Map();
    const setActive = key => {
        for (const [k, tab] of tabs)
            tab.checked = k === key;
    };
    for (const section of sections) {
        const tab = new St.Button({
            style_class: 'ml-tab',
            label: section.title,
            can_focus: true,
            // Tracked: the tab paints its own `:hover`.
            track_hover: true,
        });
        const choose = () => {
            if (tab.checked)
                return;
            setActive(section.key);
            onSwitch(section.key);
        };
        tab.connect('clicked', choose);
        tab.connect('key-focus-in', choose);
        tabs.set(section.key, tab);
        actor.add_child(tab);
    }
    setActive(active);
    return {actor, setActive, lit: () => [...tabs.values()].find(tab => tab.checked) ?? null};
}

// A bin, so the tabs sit centred however wide either side is: a bin aligns a
// child by its x_align only when it expands, and centres it otherwise.
export function createHeader({sections, active, onSwitch, onBack = null, end = []}) {
    const actor = new St.Widget({
        style_class: 'ml-header',
        layout_manager: new Clutter.BinLayout(),
        x_expand: true,
    });

    const start = new St.BoxLayout({
        style_class: 'ml-header-start',
        x_expand: true,
        x_align: Clutter.ActorAlign.START,
        y_align: Clutter.ActorAlign.CENTER,
    });
    const back = createIconButton('go-previous-symbolic', {accessibleName: 'Back'});
    back.y_align = Clutter.ActorAlign.CENTER;
    back.connect('clicked', () => onBack?.());
    back.hide();
    start.add_child(back);
    const single = sections.length < 2;
    const name = single ? sections[0]?.title ?? '' : '';
    const titles = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'ml-header-titles',
        y_align: Clutter.ActorAlign.CENTER,
        visible: single,
    });
    const titleLabel = createLabel(name, 'ml-header-title');
    const subtitleLabel = createLabel('', 'ml-header-subtitle');
    titles.add_child(titleLabel);
    titles.add_child(subtitleLabel);
    start.add_child(titles);
    actor.add_child(start);

    const tabs = single ? null : createTabs(sections, active, onSwitch);
    if (tabs) {
        tabs.actor.x_align = Clutter.ActorAlign.CENTER;
        actor.add_child(tabs.actor);
    }

    if (end.length) {
        const buttons = new St.BoxLayout({
            style_class: 'ml-header-end',
            x_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER,
        });
        for (const button of end) {
            button.y_align = Clutter.ActorAlign.CENTER;
            buttons.add_child(button);
        }
        actor.add_child(buttons);
    }

    const swap = (appearing, leaving, animate) => {
        for (const part of leaving) {
            if (animate) {
                fadeTo(part, 0, {duration: Duration.FAST});
            } else {
                part.remove_all_transitions();
                part.hide();
            }
        }
        for (const part of appearing) {
            if (animate) {
                fadeTo(part, 255);
            } else {
                part.remove_all_transitions();
                part.opacity = 255;
                part.show();
            }
        }
    };
    const say = (title, subtitle, animate) => {
        if (animate) {
            crossFade(titleLabel, title);
            crossFade(subtitleLabel, subtitle);
        } else {
            titleLabel.text = title;
            subtitleLabel.text = subtitle;
        }
    };

    return {
        actor,
        setActive: key => tabs?.setActive(key),
        focusTabs: () => {
            const tab = tabs?.lit();
            tab?.grab_key_focus();
            return !!tab;
        },
        setLibraryMode: (animate = false) => {
            if (tabs) {
                swap([tabs.actor], [back, titles], animate);
            } else {
                say(name, '', animate);
                swap([titles], [back], animate);
            }
        },
        setDetailMode: (title, animate = false) => {
            say(title, 'Back to library', animate);
            swap([back, titles], tabs ? [tabs.actor] : [], animate);
        },
    };
}

export function createPill(text, styleClass, style = null) {
    return new St.Label({text, style_class: styleClass, style, y_align: Clutter.ActorAlign.CENTER});
}

// `watched` null: nothing to track; true or false makes the disc a toggle.
export function createRow({index, title, subtitle, badges = [], size, icon = 'media-playback-start-symbolic', onActivate, watched = null, onWatched}) {
    const row = new St.Button({
        style_class: 'button flat ml-row',
        can_focus: true,
        track_hover: true,
        x_expand: true,
        style: radiusStyle(),
    });
    const content = new St.BoxLayout({x_expand: true, y_align: Clutter.ActorAlign.CENTER});

    // A label sized in CSS draws its text at the top, so the disc is a bin.
    const number = new St.Label({
        text: String(index),
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
    });
    if (watched === null) {
        content.add_child(new St.Bin({
            style_class: 'ml-row-index',
            y_align: Clutter.ActorAlign.CENTER,
            child: number,
        }));
    } else {
        // Its own button, so ticking an episode off does not also play it.
        const tick = new St.Icon({icon_name: 'object-select-symbolic', icon_size: 16});
        const face = new St.Widget({layout_manager: new Clutter.BinLayout()});
        face.add_child(number);
        face.add_child(tick);
        const disc = new St.Button({
            style_class: 'ml-row-index ml-row-watch',
            y_align: Clutter.ActorAlign.CENTER,
            toggle_mode: true,
            checked: watched,
            track_hover: true,
            accessible_name: 'Watched',
            child: face,
        });
        const sync = () => {
            number.visible = !disc.checked;
            tick.visible = disc.checked;
        };
        sync();
        disc.connect('clicked', () => {
            sync();
            onWatched(disc.checked);
        });
        row.setWatched = value => {
            disc.checked = value;
            sync();
        };
        // St's focus stops at the row: Mark watched reaches the disc here.
        row.toggleWatched = () => {
            disc.checked = !disc.checked;
            sync();
            onWatched(disc.checked);
        };
        content.add_child(disc);
    }

    const titleLabel = createLabel(title, 'ml-row-title', {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
    if (subtitle) {
        const text = new St.BoxLayout({orientation: Clutter.Orientation.VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER, style_class: 'ml-row-text'});
        text.add_child(titleLabel);
        text.add_child(createLabel(subtitle, 'ml-row-subtitle'));
        content.add_child(text);
    } else {
        titleLabel.add_style_class_name('ml-row-text');
        content.add_child(titleLabel);
    }

    for (const badge of badges)
        content.add_child(createPill(badge, 'ml-badge', radiusStyle('badge')));
    if (size)
        content.add_child(new St.Label({text: size, style_class: 'ml-row-size', y_align: Clutter.ActorAlign.CENTER}));

    content.add_child(new St.Icon({
        icon_name: icon,
        icon_size: 16,
        style_class: 'ml-row-icon',
        y_align: Clutter.ActorAlign.CENTER,
    }));

    row.set_child(content);
    row.connect('clicked', () => onActivate());
    return row;
}

export function createEmptyState({icon, title, hint, actionLabel, onAction}) {
    const box = new St.BoxLayout({
        orientation: Clutter.Orientation.VERTICAL,
        style_class: 'ml-empty',
        x_align: Clutter.ActorAlign.CENTER,
        y_align: Clutter.ActorAlign.CENTER,
        x_expand: true,
        y_expand: true,
    });
    box.add_child(new St.Icon({icon_name: icon, icon_size: 64, style_class: 'ml-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: title, style_class: 'ml-empty-title', x_align: Clutter.ActorAlign.CENTER}));
    box.add_child(new St.Label({text: hint, style_class: 'ml-empty-hint', x_align: Clutter.ActorAlign.CENTER}));
    if (actionLabel) {
        const button = createActionButton({label: actionLabel, icon: 'preferences-system-symbolic', styleClass: 'button ml-action-secondary'});
        button.x_align = Clutter.ActorAlign.CENTER;
        button.connect('clicked', () => onAction());
        box.add_child(button);
    }
    return box;
}
