import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {VideoLibraryApp} from './lib/app.js';

export default class VideoLibraryExtension extends Extension {
    enable() {
        this._app = new VideoLibraryApp(this);
        this._app.enable();
    }

    disable() {
        this._app.disable();
        this._app = null;
    }
}
