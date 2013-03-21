/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
'use strict';

const base64 = require('sdk/base64');
const {mix} = require('sdk/core/heritage');
const Q = require('sdk/core/promise');
const {getBrowserForTab} = require('sdk/tabs/utils');
const {setTimeout} = require('sdk/timers');
const {descriptor} = require('toolkit/loader');

const {validateOptions} = require('sdk/deprecated/api-utils');
const {EventEmitter} = require('sdk/deprecated/events');
const {Trait} = require('sdk/deprecated/traits');

const {tabSandbox} = require('./sandbox');
const tabs = require('./tabs');
const {
    discardSTSInfo, getScreenshotCanvas, setAuthHeaders, removeAuthPrompt,
    getCookies, setCookies, Cookie
} = require('./utils');


const ListenerTrait = function() {
    // PhantomJS callback we can convert to events
    const EVENTS = [
        'callback',               // MAYBE
        'closing',
        'error',
        'initialized',
        'loadFinished',
        'loadStarted',
        'navigationRequested',    // TODO
        'pageCreated',            // TODO
        'resourceRequested',
        'resourceReceived',
        'urlChanged'              // TODO
    ];

    let trait = {};

    let getName = function(v) {
        return 'on' + v[0].toUpperCase() + v.substr(1);
    };

    let callbackListener = function(v) {
        // This function create a listener that tries to call a callback
        // when triggered
        this.on(v, function() {
            let args = Array.prototype.slice.call(arguments);
            let name = args.shift();
            if (typeof(this[name]) === 'function') {
                this[name].apply(this, args);
            }
        }.bind(this, getName(v)));
    };

    let redirectListener = function(from, to) {
        // Some events are direct to TabTrait events, then we use this function
        // to bind webpage events to TabTrait ones.
        to = to || from;
        this.trait.on(from, function() {
            let args = [to].concat(Array.prototype.slice.call(arguments));
            this._emit.apply(this, args);
        }.bind(this));
    };

    // Add null callbacks
    EVENTS.forEach(function(v) {
        trait[getName(v)] = null;
    });

    trait._registerListeners = function() {
        // Make callbacks based event listeners
        EVENTS.forEach(callbackListener.bind(this));

        // Some redirects
        let redir = redirectListener.bind(this);

        redir('error');
        redir('openReady', 'initialized');
        redir('init', 'loadInit');
        redir('start', 'loadStarted');
        redir('ready', 'loadContent');
        redir('resourceRequested');
        redir('resourceReceived');

        // loadFinished
        this.trait.on('fullLoad', function() {
            this._emit('loadFinished', 'success');
        }.bind(this));
        this.trait.on('loadFail', function() {
            this._emit('loadFinished', 'fail');
        }.bind(this));
    };

    // Default onError callback
    trait.onError = function(e) {
        console.error('ERROR');
        console.exception(e);
    };

    return trait;
};


const WindowEventTrait = function() {
    // PhantomJS window events callbacks
    const CALLBACKS = {
        onAlert: function(msg) {},
        onConfirm: function(msg) {},
        onConsoleMessage: function(msg, lineNum, sourceId) {},
        onPrompt: function(msg, defaultVal) {}
    };

    let trait = {};

    let callbackMethod = function(k, v) {
        this[k] = v;
        this['_' + k] = function() {
            if (typeof(this[k]) === 'function') {
                return this[k].apply(this, arguments);
            }
        }.bind(this);
    };

    for (let i in CALLBACKS) {
        trait[i] = null;
    }

    trait._windowEvents = function() {
        return {
            alert: this._onAlert,
            confirm: this._onConfirm,
            prompt: this._onPrompt,
            console: {
                __noSuchMethod__: function(id, args) {
                    return this._onConsoleMessage(id, args);
                }.bind(this),
                __exposedProps__: {__noSuchMethod__: 'r'}
            },
            dump: this._onConsoleMessage.bind(this),

            // Other events we block
            back: function() {},
            close: function() {},
            forward: function() {},
            home: function() {},
            open: function() {},
            openDialog: function() {},
            print: function() {},
            showModalDialog: function() {}
        };
    };

    trait._registerWindowEvents = function() {
        // Make window events callbacks
        for (let i in CALLBACKS) {
            callbackMethod.bind(this)(i, CALLBACKS[i]);
        }

        // Window object modifications
        this.trait.on('start', function() {
            Object.defineProperties(
                this._tab.linkedBrowser.contentWindow.wrappedJSObject,
                descriptor(this._windowEvents())
            );
        }.bind(this));

        // Default console message
        this.onConsoleMessage = function(id, args) {
            if (id === 'log') {
                id = 'info';
            }
            dump(id + ': ' + args.join(' ') + '\n');
        };
    };

    return trait;
};


const webPage = EventEmitter.compose(ListenerTrait(), WindowEventTrait(),
{
    on: Trait.required,
    once: Trait.required,
    _emit: Trait.required,

    _assertTab: function() {
        if (!this._tab) {
            throw new Error('webpage not opened');
        }
    },
    get _tab() {
        return this.trait.tab;
    },

    get sandbox() {
        this._assertTab();
        if (this._sandbox === null) {
            this._sandbox = new tabSandbox(this._tab);

            // Adding global vars
            if (this._sandboxGlobals) {
                Object.defineProperties(this._sandbox.sandbox, descriptor(this._sandboxGlobals));
            }

            // Adding window events
            Object.defineProperties(this._sandbox.sandbox, descriptor(this._windowEvents()));
        }

        return this._sandbox;
    },

    get globals() {
        return this._sandboxGlobals;
    },
    set globals(value) {
        if (this._sandbox !== null) {
            throw new Error('Cannot add globals after the first evaluation call');
        }
        this._sandboxGlobals = value;
    },

    _cleanUp: function() {
        // Init & clean some vars
        this._plainText = '';
        this._sandbox = null;
    },

    constructor: function(options) {
        this.trait = tabs.Tab(options);
        this._state = 'closed';
        this._sandbox = null;
        this._sandboxGlobals = null;

        this._clipRect = null;
        this._cookies = [];
        this._settings = {
            javascriptEnabled: true,
            loadImages: true,
            localToRemoteUrlAccessEnabled: false,
            userAgent: null,
            userName: null,
            password: null,
            XSSAuditingEnabled: false,
            webSecurityEnabled: true
        };

        this._cleanUp();

        // Create event listeners
        this._registerListeners();

        // Create window events
        this._registerWindowEvents();

        // Adding event to capture page content
        this.on('resourceReceived', function(response) {
            if (response.id === 0 && response.stage === 'data') {
                this._plainText += response.data;
            }
        }.bind(this));

        this.trait.on('_request', function(request) {
            // Set authorization
            setAuthHeaders(request, this.url, this.settings.userName, this.settings.password);

            // Set cookies
            setCookies(request, this._cookies);
        }.bind(this));

        this.trait.on('_response', function(response) {
            // Remove STS information on each response for tab
            discardSTSInfo(response);

            // Add cookies to internal jar
            getCookies(response).forEach(function(cookie) {
                this.addCookie(cookie);
            }.bind(this));

            // Remove auth prompt
            if (response.responseStatus == 401) {
                setTimeout(removeAuthPrompt, 500);
            }
        }.bind(this));
    },

    foreground: function() {
        this._assertTab();
        let deferred = Q.defer();
        this.trait.once('select', function() {
            deferred.resolve();
        });
        this.trait.select();
        return deferred.promise;
    },

    addCookie: function(cookie) {
        cookie = Cookie(cookie);
        this._cookies = this._cookies.filter(function(v) {
            return v.name !== cookie.name;
        });

        this._cookies.push(cookie);
        return true;
    },
    clearCookies: function(cookie) {
        this._cookies = [];
    },
    deleteCookie: function(name) {
        this._cookies = this._cookies.filter(function(v) {
            return v.name !== cookie.name;
        });
    },
    get cookies() {
        return this._cookies;
    },
    set cookies(values) {
        values = Array.isArray(values) && values || [];
        let old = this._cookies;
        this.clearCookies();
        try {
            values.forEach(function(v) {
                this.addCookie(v);
            });
        }
        catch(e) {
            this._cookies = old;
            throw e;
        }
    },

    get clipRect() {
        return this._clipRect;
    },
    set clipRect(value) {
        let requirements = {
            top: {
                is: ['number'],
                ok: function(val) val >= 0,
                msg: 'top should be a positive integer'
            },
            left: {
                is: ['number'],
                ok: function(val) val >= 0,
                msg: 'left should be a positive integer'
            },
            width: {
                is: ['number'],
                ok: function(val) val > 0,
                msg: 'width should be a positive integer'
            },
            height: {
                is: ['number'],
                ok: function(val) val > 0,
                msg: 'height should be a positive integer'
            },
        }
        if (typeof(value) === 'object') {
            this._clipRect = validateOptions(value, requirements);
        }
        else {
            this._clipRect = null;
        }
    },

    close: function() {
        let deferred = Q.defer();
        if (this._tab) {
            this.evaluate(function() {
                window.onbeforeunload = null;
                window.onunload = null;
            });

            this.trait.once('close', function() {
                this._emit('closing', this);
                deferred.resolve(true);
            }.bind(this));
            this.trait.close();
        }
        else {
            // XXX: Don't know if it's a good idea to send event even if tab if closed.
            this._emit('closing', this);
            deferred.resolve(false);
        }
        this._cleanUp();
        this._state = 'closed';

        return deferred.promise;
    },

    evaluate: function(func) {
        this._assertTab();

        let s = this.sandbox;
        return s.evaluate.apply(s, Array.prototype.slice.call(arguments));
    },

    evaluateAsync: function(func) {
        this._assertTab();
        this.sandbox.evaluateAsync(func);
    },

    includeJS: function(url, callback) {
        this._assertTab();
        this.sandbox.includeJS(url, callback);
    },

    injectJS: function(filename) {
        this._assertTab();

        try {
            this.sandbox.injectJS(filename);
            return true;
        }
        catch(e) {
            this._emit('error', e);
            return false;
        }
    },

    open: function(url, callback) {
        if (this._state == 'transfer') {
            throw new Error('Transfer in progress');
        }
        this._cleanUp();
        this._state = 'transfer';

        let deferred = Q.defer();

        this.trait.once('fullLoad', function() {
            this._state = 'complete';
            deferred.resolve('success');
        }.bind(this));

        this.trait.once('loadFail', function(reason) {
            this._state = 'complete';
            deferred.resolve('fail');
        }.bind(this));

        this.trait.once('error', function() {
            this._state = 'complete';
            deferred.resolve('fail');
        }.bind(this));

        if (!this._tab) {
            this.trait.once('openReady', function() {
                this.trait.load(url);
            }.bind(this));
            this.trait.open();
        }
        else {
            this.trait.load(url);
        }

        deferred.promise.then(function(result) {
            this._emit('openFinished', result);
        }.bind(this));

        if (typeof(callback) === 'function') {
            deferred.promise.then(callback).then(null, function(e) {
                this._emit('error', e);
            }.bind(this));
        };

        return deferred.promise;
    },

    render: function(filename, ratio) {
        throw new Error('Not implemented yet');
    },

    renderBytes: function(format, ratio) {
        return base64.decode(this.renderBase64(format, ratio));
    },

    renderBase64: function(format, ratio) {
        this._assertTab();

        format = (format || 'png').toString().toLowerCase();
        let qual = undefined;
        if (format == 'png') {
            format = 'image/png';
        }
        else if (format == 'jpeg') {
            format = 'image/jpeg';
            qual = 0.8;
        }
        else {
            throw new Error('Render format "' + format + '" is not supported');
        }

        let window = getBrowserForTab(this._tab).contentWindow;

        let canvas = getScreenshotCanvas(window, this.clipRect, ratio);

        return canvas.toDataURL(format, qual).split(',', 2)[1];
    },

    get plainText() {
        this._assertTab();
        try {
            return this._plainText;
        }
        catch(e) {
            this._emit('error', e);
            return '';
        }
    },

    get settings() {
        return this._settings;
    },
    set settings(val) {
        if (typeof(val) === 'object') {
            this._settings = mix(this._settings, val);
        }
    },

    get url() {
        this._assertTab();
        return this._tab.linkedBrowser.contentWindow.location.href;
    }
});

exports.create = function(options) {
    return webPage(options);
};
