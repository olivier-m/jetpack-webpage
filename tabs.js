/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {Cc, Ci} = require("chrome");
const {getBrowserForTab, getOwnerWindow, getTabBrowserForTab} = require("sdk/tabs/utils");
const {setTimeout, clearTimeout} = require("sdk/timers");

const {validateOptions} = require("sdk/deprecated/api-utils");
const {EventEmitter} = require("sdk/deprecated/events");
const {Trait} = require("sdk/deprecated/traits");

const netLog = require("net-log");

const wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);

const loadFlags = (
    Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_CACHE
    | Ci.nsIWebNavigation.LOAD_FLAGS_BYPASS_HISTORY
    | Ci.nsIWebNavigation.LOAD_FLAGS_FIRST_LOAD
    | Ci.nsIWebNavigation.LOAD_FLAGS_STOP_CONTENT
);
const progressFlags = (
    Ci.nsIWebProgress.NOTIFY_STATE_DOCUMENT
    | Ci.nsIWebProgress.NOTIFY_STATE_WINDOW
);

netLog.startTracer();

// Tab events definition
const E_OPEN = "open";
const E_OPEN_READY = "openReady";
const E_CLOSE = "close";
const E_SELECT = "select";

const E_INIT = "init";
const E_START = "start";
const E_LOAD_START = "loadStart";
const E_READY = "ready";
const E_LOAD = "load";
const E_REQUEST = "_request";
const E_RESPONSE = "_response";

const E_LOAD_FAIL = "loadFail";
const E_RES_REQ = "resourceRequested";
const E_RES_REC = "resourceReceived";


const TabTrait = Trait.compose(EventEmitter, {
    on: Trait.required,
    once: Trait.required,
    _emit: Trait.required,

    constructor: function(options) {
        let requirements = {
            startTimeout: {
                map: function(val) typeof(val) === "number" ? parseInt(val) : 5000,
                ok: function(val) val >= 0
            },
            loadTimeout: {
                map: function(val) typeof(val) === "number" ? parseInt(val) : 30000,
                ok: function(val) val >= 0
            },
            loadWait: {
                map: function(val) typeof(val) === "number" ? parseInt(val) : 500,
                ok: function(val) val >= 0
            },
            captureTypes: {
                map: function(val) Array.isArray(val) && val || []
            }
        };
        this.options = validateOptions(options, requirements);

        this._onOpen = this._bindListener(this._onOpen);
        this._onOpenReady = this._bindListener(this._onOpenReady);
        this._onLoadStart = this._bindListener(this._onLoadStart);
        this._onReady = this._bindListener(this._onReady);
        this._onLoad = this._bindListener(this._onLoad);
        this._onFullLoad = this._bindListener(this._onFullLoad);
        this._onClose = this._bindListener(this._onClose);
        this._onSelect = this._bindListener(this._onSelect);

        this.mainWindow = wm.getMostRecentWindow("navigator:browser");
        this.container = this.mainWindow.gBrowser.tabContainer;
        this._browser = null;
        this._tab = null;
        this._plistener = null;
        this._timeout = null;

        // Unregister browser on load, loadFail and error
        this.on("load", this._cleanUp);
        this.on("loadFail", this._cleanUp);
        this.on("error", this._cleanUp);
    },

    get tab() {
        return this._tab;
    },
    get browser() {
        return this._browser;
    },

    _bindListener: function(listener) {
        return function() {
            try {
                listener.apply(this, arguments);
            } catch(e) {
                this._emit("error", e);
            }
        }.bind(this);
    },

    _cleanUp: function() {
        if (this.browser) {
            this.browser.stop();
            netLog.unregisterBrowser(this.browser);
            try {
                this.browser.removeProgressListener(this._plistener);
            } catch(e) {}
        }
    },

    _onOpen: function(evt) {
        this.container.removeEventListener("TabOpen", this._onOpen, true);

        this._tab = evt.target;
        this._browser = getBrowserForTab(this.tab);

        this._emit(E_OPEN, this.tab);

        this.browser.addEventListener("DOMContentLoaded", this._onOpenReady, true);
    },
    _onOpenReady: function(evt) {
        this.browser.removeEventListener("DOMContentLoaded", this._onOpenReady, true);
        this._emit(E_OPEN_READY, this.tab);
    },
    _onLoadStart: function() {
        let startTimeout = this._bindListener(function() {
            this.browser.removeEventListener("DOMContentLoaded", this._onReady, true);
            this._emit(E_LOAD_FAIL, "Start timeout");
        });
        this._timeout = setTimeout(startTimeout, this.options.startTimeout);
        this.browser.addEventListener("DOMContentLoaded", this._onReady, true);
    },
    _onReady: function() {
        this.browser.removeEventListener("DOMContentLoaded", this._onReady, true);
        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = null;
        }
        this._emit(E_READY);

        let loadTimeout = this._bindListener(function() {
            this.browser.contentWindow.removeEventListener("load", this._onLoad, true);
            this._emit(E_LOAD_FAIL, "Load timeout");
        });
        this._timeout = setTimeout(loadTimeout, this.options.loadTimeout);
        this.browser.contentWindow.addEventListener("load", this._onLoad, true);
    },
    _onLoad: function() {
        this.browser.contentWindow.removeEventListener("load", this._onLoad, true);
        try {
            this.browser.removeProgressListener(this._plistener);
        } catch(e) {}

        if (this._timeout) {
            clearTimeout(this._timeout);
            this._timeout = null;
        }

        setTimeout(this._onFullLoad, this.options.loadWait);
    },
    _onFullLoad: function() {
        this._emit(E_LOAD);
    },
    _onClose: function() {
        this.container.removeEventListener("TabClose", this._onClose, true);
        this._emit(E_CLOSE);
    },
    _onSelect: function() {
        this.tab.removeEventListener("TabSelect", this._onActivate, true);
        this._emit(E_SELECT);
    },

    _load: function(url) {
        // Register netLog
        registerBrowserNetLog(this);

        // Open URI
        this.browser.stop();
        this._emit(E_INIT);
        this.browser.loadURIWithFlags(url, loadFlags, null, null, null);

        // Add progress & start event listeners
        this.once("start", this._onLoadStart);
        this._plistener = new ProgressListener(this);
        this.browser.addProgressListener(this._plistener, progressFlags);
    },

    select: function() {
        if (this.tab === null) {
            return;
        }
        let gBrowser = getTabBrowserForTab(this.tab);
        if (gBrowser.selectedTab == this.tab) {
            this._emit(E_SELECT);
            return;
        }

        this.container.addEventListener("TabSelect", this._onSelect, true);
        gBrowser.selectedTab = this.tab;
    },

    open: function() {
        this.container.addEventListener("TabOpen", this._onOpen, true);
        this.mainWindow.gBrowser.addTab();
    },
    close: function() {
        if (this.tab) {
            this.browser.stop();
            this.container.addEventListener("TabClose", this._onClose, true);
            getOwnerWindow(this.tab).gBrowser.removeTab(this.tab);
        }
    },
    load: function(url) {
        // This wrapper will first replace current browser URL with about:blank
        // and then load the given URL.
        // There were some issues with a brutal URL switch.

        let _ready = this._bindListener(function() {
            this.browser.removeEventListener("DOMContentLoaded", _ready, true);
            this._load(url);
        });

        this.browser.stop();
        this.browser.addEventListener("DOMContentLoaded", _ready, true);
        this.browser.loadURI("about:blank");
    }
})
exports.TabTrait = TabTrait;


const registerBrowserNetLog = function(trait) {
    netLog.registerBrowser(trait.browser, {
        captureTypes: trait.options.captureTypes,
        onRequest: function(request) {
            trait._emit(E_RES_REQ, request);
        },
        onResponse: function(response) {
            trait._emit(E_RES_REC, response);
        },
        _onRequest: function(subject) {
            trait._emit(E_REQUEST, subject);
        },
        _onResponse: function(subject) {
            trait._emit(E_RESPONSE, subject);
        }
    });
};


const ProgressListener = function(trait) {
    this.trait = trait;

    this.START = 1;
    this.INIT = 2;
    this.LOAD = 3;

    this.state = 0;
};
ProgressListener.prototype = {
    QueryInterface: function(aIID){
        if (aIID.equals(Ci.nsIWebProgressListener) ||
        aIID.equals(Ci.nsISupportsWeakReference) ||
        aIID.equals(Ci.nsISupports))
            return this;
       throw(Cr.NS_NOINTERFACE);
    },
    isStart: function(flags) {
        return (
            flags & Ci.nsIWebProgressListener.STATE_TRANSFERRING &&
            flags & Ci.nsIWebProgressListener.STATE_IS_DOCUMENT
        );
    },
    isLoaded: function(flags) {
        return (
            flags & Ci.nsIWebProgressListener.STATE_STOP &&
            flags & Ci.nsIWebProgressListener.STATE_IS_NETWORK &&
            flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW
        );
    },
    isLoading: function(flags) {
        return (
            flags & Ci.nsIWebProgressListener.STATE_START &&
            flags & Ci.nsIWebProgressListener.STATE_IS_WINDOW
        )
    },

    onStateChange: function(progress, request, flags, status) {
        try {
            if (this.isStart(flags) && this.state < this.START) {
                this.state = this.START;
                this.trait._emit(E_START);
                return;
            }
            if (this.isLoading(flags) && this.state == this.START && this.state < this.INIT) {
                this.state = this.INIT;
                this.trait._emit(E_LOAD_START);
                return;
            }
            if (this.isLoaded(flags) && this.state < this.START) {
                this.trait.browser.removeProgressListener(this);
                this.trait._emit(E_LOAD_FAIL, "Unable to open URL");
                return;
            }
        } catch(e) {
            this.trait._emit(E_LOAD_FAIL);
            console.exception(e);
            try {
                this.trait.browser.removeProgressListener(this);
            } catch(e) {
                console.exception(e);
            }
        }
    }
};
