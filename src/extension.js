import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LibraryApp} from './lib/app.js';

export default class LibraryExtension extends Extension {
    enable() {
        this._app = new LibraryApp(this);
        this._app.enable();
    }

    disable() {
        this._app.disable();
        this._app = null;
    }
}
