/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const {Cc, Ci, Cu} = require("chrome");
const base64 = require("sdk/base64");

const AppShellService = Cc["@mozilla.org/appshell/appShellService;1"]
                        .getService(Ci.nsIAppShellService);
const ioService = Cc["@mozilla.org/network/io-service;1"]
                        .getService(Ci.nsIIOService);
const STS = Cc["@mozilla.org/stsservice;1"]
                        .getService(Ci.nsIStrictTransportSecurityService);

const NS = "http://www.w3.org/1999/xhtml";
const COLOR = "rgb(255,255,255)";


const getScreenshotCanvas = function(window, clip, ratio) {
    let scrollbarWidth = 0;
    scrollbarWidth = window.innerWidth - window.document.body.clientWidth;

    if (clip) {
        window.resizeTo(clip.width + scrollbarWidth, clip.height);
    }
    if (!ratio || (ratio && (ratio <= 0 || ratio > 1))) {
        ratio = 1;
    }

    let top = clip && clip.top || 0;
    let left = clip && clip.left || 0;
    let width = clip && clip.width;
    let height = clip && clip.height || window.document.body.scrollHeight;

    if (width === null) {
        width = window.document.body.clientWidth;
    }

    let canvas = AppShellService.hiddenDOMWindow.document.createElementNS(NS, "canvas");
    canvas.mozOpaque = true;
    canvas.width = Math.round(width * ratio);
    canvas.height = Math.round(height * ratio);

    let ctx = canvas.getContext("2d");
    ctx.fillStyle = COLOR;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.scale(ratio, ratio);
    ctx.drawWindow(window, left, top, width, height, COLOR);
    ctx.restore();

    return canvas;
};
exports.getScreenshotCanvas = getScreenshotCanvas;


const discardSTSInfo = function(request) {
    try {
        request.QueryInterface(Ci.nsIHttpChannel);
    } catch(e) {
        return;
    }

    if (STS.isStsHost(request.URI.host)) {
        STS.removeStsState(request.URI);
    }
};
exports.discardSTSInfo = discardSTSInfo;


const setAuthHeaders = function(request, originURL, username, password) {
    try {
        request.QueryInterface(Ci.nsIHttpChannel);
    } catch(e) {}

    // Remove auth info in any case
    request.setRequestHeader("Authorization", null, false);

    if (!username && !password) {
        return;
    }
    let auth = "Basic " + base64.encode(username + ":" + password);

    // No referer = original page, set it
    if (request.referrer === null) {
        request.setRequestHeader("Authorization", auth, false);
        return;
    }

    // Resources, test hostname and base path
    let url = ioService.newURI(originURL, null, null);
    if (url.host == request.URI.host &&
        url.port == request.URI.port &&
        url.scheme == request.URI.scheme
    ) {
        request.setRequestHeader("Authorization", auth, false);
    }
};
exports.setAuthHeaders = setAuthHeaders;
