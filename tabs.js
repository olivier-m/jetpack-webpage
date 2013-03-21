/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';

const {Cc, Ci} = require('chrome');

const {Class, mix} = require('sdk/core/heritage');
const {emit} = require('sdk/event/core');
const {EventTarget} = require('sdk/event/target');
const {getBrowserForTab, getOwnerWindow, getTabBrowserForTab} = require('sdk/tabs/utils');
const {setTimeout, clearTimeout} = require('sdk/timers');

const {validateOptions} = require('sdk/deprecated/api-utils');

const NetLog = require('net-log/net-log');
const PageProgress = require('net-log/page-progress');

const wm = Cc['@mozilla.org/appshell/window-mediator;1'].getService(Ci.nsIWindowMediator);

const LOAD_FLAGS = (
    Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE
    | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY
    | Ci.nsIWebNavigation.LOAD_FLAGS_FIRST_LOAD
    | Ci.nsIWebNavigation.LOAD_FLAGS_STOP_CONTENT
);

// Tab events definition
const E_OPEN = 'open';
const E_OPEN_READY = 'openReady';
const E_CLOSE = 'close';
const E_SELECT = 'select';

const E_INIT = 'init';
const E_START = 'start';
const E_LOAD_START = 'loadStart';
const E_READY = 'ready';
const E_LOAD = 'load';
const E_FULL_LOAD = 'fullLoad';
const E_REQUEST = '_request';
const E_RESPONSE = '_response';

const E_LOAD_FAIL = 'loadFail';
const E_RES_REQ = 'resourceRequested';
const E_RES_REC = 'resourceReceived';


const Tab = Class({
    extends: EventTarget,

    initialize: function(options) {
        let requirements = {
            startTimeout: {
                map: function(val) typeof(val) === 'number' ? parseInt(val) : 5000,
                ok: function(val) val >= 0
            },
            loadTimeout: {
                map: function(val) typeof(val) === 'number' ? parseInt(val) : 30000,
                ok: function(val) val >= 0
            },
            loadWait: {
                map: function(val) typeof(val) === 'number' ? parseInt(val) : 500,
                ok: function(val) val >= 0
            },
            captureTypes: {
                map: function(val) Array.isArray(val) && val || []
            }
        };
        this.options = validateOptions(options, requirements);

        this.mainWindow = wm.getMostRecentWindow('navigator:browser');
        this.container = this.mainWindow.gBrowser.tabContainer;
        this._browser = null;
        this._tab = null;
        this._timeout = null;

        // Unregister browser on load, loadFail and error
        this.on(E_FULL_LOAD, this._cleanUp);
        this.on(E_LOAD_FAIL, this._cleanUp);
        this.on('error', this._cleanUp);
    },

    get tab() {
        return this._tab;
    },
    get browser() {
        return this._browser;
    },

    _cleanUp: function() {
        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = null;
        }
        if (this.browser) {
            if (typeof(this.browser.stop) === 'function') {
                this.browser.stop();
            }
            NetLog.unregisterBrowser(this.browser);
            PageProgress.unregisterBrowser(this.browser);
        }
    },


    select: function() {
        if (this.tab === null) {
            return;
        }
        let gBrowser = getTabBrowserForTab(this.tab);
        let onSelect = function() {
            this.container.removeEventListener('TabSelect', onSelect, true);
            emit(this, E_SELECT);
        }.bind(this);

        if (gBrowser.selectedTab === this.tab) {
            emit(this, E_SELECT);
        }
        else {
            this.container.addEventListener('TabSelect', onSelect, true);
            gBrowser.selectedTab = this.tab;
        }
    },

    open: function() {
        let _onOpen = bindListener(this, function(evt) {
            this.container.removeEventListener('TabOpen', _onOpen, true);

            this._tab = evt.target;
            this._browser = getBrowserForTab(this.tab);

            emit(this, E_OPEN, this.tab);

            this.browser.addEventListener('DOMContentLoaded', _onOpenReady, true);
        });

        let _onOpenReady = bindListener(this, function(evt) {
            this.browser.removeEventListener('DOMContentLoaded', _onOpenReady, true);
            emit(this, E_OPEN_READY, this.tab);
        });

        this.container.addEventListener('TabOpen', _onOpen, true);
        this.mainWindow.gBrowser.addTab();
    },

    close: function() {
        let onClose = bindListener(this, function() {
            this.container.removeEventListener('TabClose', onClose, true);
            this._browser = null;
            this._tab = null;
            emit(this, E_CLOSE);
        });

        if (this.tab) {
            this._cleanUp();
            this.container.addEventListener('TabClose', onClose, true);
            getOwnerWindow(this.tab).gBrowser.removeTab(this.tab);
        }
        else {
            emit(this, E_CLOSE);
        }
    },

    load: function(url) {
        let _ready = bindListener(this, function() {
            this.browser.removeEventListener('DOMContentLoaded', _ready, true);
            _load();
        });

        let netLogOptions = {
            onRequest: function(request) {
                emit(this, E_RES_REQ, request);
            }.bind(this),

            onResponse: function(response) {
                emit(this, E_RES_REC, response);
            }.bind(this),

            onModifyRequest: function(subject) {
                emit(this, E_REQUEST, subject);
            }.bind(this),

            onExamineResponse: function(subject) {
                emit(this, E_RESPONSE, subject);
            }.bind(this)
        };


        let progressOptions = {
            onLoadStarted: function() {
                emit(this, E_LOAD_START);
            }.bind(this),

            onTransferStarted: function() {
                emit(this, E_START);
            }.bind(this),

            onContentLoaded: function(status) {
                if (this._timeout) {
                    clearTimeout(this._timeout);
                    this._timeout = null;
                }

                if (status) {
                    emit(this, E_READY);
                    this._timeout = setTimeout(loadWait, this.options.loadTimeout);
                }
            }.bind(this),

            onLoadFinished: function(status) {
                if (this._timeout) {
                    clearTimeout(this._timeout);
                    this._timeout = null;
                }

                if (!status) {
                    emit(this, E_LOAD_FAIL, 'Unable to open URL');
                }
                else {
                    emit(this, E_LOAD);
                    setTimeout(fullLoad, this.options.loadWait);
                }
            }.bind(this),

            onStateChange: function(progress, request, flags, status, isMain) {
                //if (isMain) console.log(this.debugFlags(flags))
            }
        };

        let startWait = function() {
            emit(this, E_LOAD_FAIL, 'Start timeout');
        }.bind(this);

        let loadWait = function() {
            emit(this, E_LOAD_FAIL, 'Load timeout');
        }.bind(this);

        let fullLoad = function() {
            emit(this, E_FULL_LOAD);
        }.bind(this);

        let _load = function() {
            NetLog.registerBrowser(this.browser, netLogOptions);

            this.browser.stop();
            this._timeout = setTimeout(startWait, this.options.startTimeout);
            PageProgress.registerBrowser(this.browser, progressOptions);

            // Load page
            emit(this, E_INIT);
            this.browser.loadURIWithFlags(url, LOAD_FLAGS, null, null, null);
        }.bind(this);

        this.browser.stop();
        this.browser.addEventListener('DOMContentLoaded', _ready, true);
        this.browser.loadURI('about:blank');
    }
});

exports.Tab = Tab;


const bindListener = function(obj, listener) {
    return function() {
        try {
            listener.apply(this, arguments);
        }
        catch(e) {
            emit(this, 'error', e);
        }
    }.bind(obj);
};
