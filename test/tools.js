/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Some useful functions for testing purpose

'use strict';

const {Cc, Ci} = require('chrome');

const Q = require('sdk/core/promise');
const {getBrowserForTab, getOwnerWindow} = require('sdk/tabs/utils');
const {startServerAsync} = require('sdk/test/httpd');
const {setTimeout, clearTimeout} = require('sdk/timers');
const {URL} = require('sdk/url');

const wm = Cc["@mozilla.org/appshell/window-mediator;1"].getService(Ci.nsIWindowMediator);

const readBinaryURI = function(uri) {
    let ioservice = Cc['@mozilla.org/network/io-service;1'].getService(Ci.nsIIOService);
    let channel = ioservice.newChannel(uri, 'UTF-8', null);
    let stream = Cc['@mozilla.org/binaryinputstream;1'].
                  createInstance(Ci.nsIBinaryInputStream);
    stream.setInputStream(channel.open());

    let data = '';
    while (true) {
        let available = stream.available();
        if (available <= 0)
            break;
        data += stream.readBytes(available);
    }
    stream.close();

    return data;
};
exports.readBinaryURI = readBinaryURI;


const registerFile = function(srv, rootURI, path) {
    srv.registerPathHandler('/' + path, function(request, response) {
        try {
            let ext = path.split('.').pop()
            let contentType = 'text/plain; charset=utf-8';
            if (ext in mimeTypes) {
                contentType = mimeTypes[ext];
            }

            let url = URL(path, rootURI);
            let data = readBinaryURI(url);

            response.setStatusLine(request.httpVersion, 200, 'OK');
            response.setHeader('Content-Type', contentType, false);
            response.processAsync();
            response.write(data);
            response.finish();
        } catch(e) {
            console.error(e);
            console.exception(e);
        }
    });
};
exports.registerFile = registerFile;


const startServer = function(port, rootURI, fileList) {
    let srv = startServerAsync(port);

    fileList.forEach(function(val) {
        registerFile(srv, rootURI, val);
    });

    return srv;
};
exports.startServer = startServer;


const mimeTypes = {
    'css': 'text/css; charset=utf-8',
    'html': 'text/html; charset=utf-8',
    'js': 'application/javascript; charset=utf-8',
    'png': 'image/png',
    'jpg': 'image/jpeg',
    'jpeg': 'image/jpeg',
    'gif': 'image/gif'
};


const openTab = function() {
    let win = wm.getMostRecentWindow('navigator:browser');
    let container = win.gBrowser.tabContainer;

    let d1 = Q.defer();
    container.addEventListener('TabOpen', function _open(evt) {
        container.removeEventListener('TabOpen', _open, true);
        d1.resolve({
            tab: evt.target,
            browser: getBrowserForTab(evt.target)
        });
    }, true);

    let tab = win.gBrowser.addTab();

    return d1.promise.then(function(result) {
        let {browser, tab} = result;

        let close = function() {
            let D = Q.defer();
            container.addEventListener('TabClose', function _close() {
                container.removeEventListener('TabClose', _close, true);
                D.resolve();
            }, true);
            getOwnerWindow(tab).gBrowser.removeTab(tab);

            return D;
        };

        let open = function(url) {
            let D = Q.defer();
            let timeout;

            function _load() {
                clearTimeout(timeout)
                browser.removeEventListener('load', _load, true);
                setTimeout(function() {
                    D.resolve({
                        url: url,
                        tab: tab,
                        browser: browser,
                        open: open,
                        close: close,
                        loadFailed:false
                    });
                }, 500);
            }

            // in case on no load event (error during a request for ex),
            // we should be able to continue tests
            timeout = setTimeout(function() {
                browser.removeEventListener('load', _load, true);
                D.resolve({
                    url: url,
                    tab: tab,
                    browser: browser,
                    open: open,
                    close: close,
                    loadFailed:true
                });
            }, 5000);

            browser.addEventListener('load', _load, true);

            browser.loadURI(url);

            return D.promise;
        }

        return {
            tab: tab,
            browser: browser,
            open: open,
            close: close
        }
    });
};
exports.openTab = openTab;
