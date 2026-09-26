import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {MediaLibrariesApp} from './lib/app.js';

export default class MediaLibrariesExtension extends Extension {
    enable() {
        this._app = new MediaLibrariesApp(this);
        this._app.enable();
    }

    disable() {
        this._app.disable();
        this._app = null;
    }
}
