/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const file = require("sdk/io/file")
const sandbox = require("sdk/loader/sandbox");
const {readURISync} = require('sdk/net/url');
const {Request} = require("sdk/request");
const timers = require("sdk/timers");


const tabSandbox = function(tab) {
    let win = tab.linkedBrowser.contentWindow;
    this.sandbox = sandbox.sandbox(win, {
        sandboxPrototype: win,
        wantXrays: false,
        wantComponents: false
    });
};
tabSandbox.prototype = {
    rawEval: function(src) {
        return sandbox.evaluate(this.sandbox, src);
    },

    getCode: function(func) {
        let args = JSON.stringify(Array.prototype.slice.call(arguments).slice(1));
        return "(" + func.toSource() + ").apply(this, " + args + ")";
    },

    evaluate: function(func) {
        let code = this.getCode.apply(this, Array.prototype.slice.call(arguments));
        return this.rawEval(code);
    },

    evaluateAsync: function(func) {
        timers.setTimeout(function() {
            this.evaluate(func);
        }.bind(this), 0);
    },

    includeJS: function(url, callback) {
        Request({
            url: url,
            onComplete: function(response) {
                try {
                    this.rawEval(response.text);
                } catch(e) {
                    callback(e);
                    return;
                }
                callback();
            }.bind(this)
        }).get();
    },

    injectJS: function(filename) {
        let code = null;
        try {
            if (filename.indexOf("/") === 0) {
                filename = "file://" + filename;
            }
            code = readURISync(filename);
        } catch(e) {
            throw new Error("Unable to open file \"" + filename + "\".");
        }

        this.rawEval(code);
    }
};

exports.tabSandbox = tabSandbox;
