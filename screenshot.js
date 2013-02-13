/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */
"use strict";

const { Cc, Ci, Cu } = require("chrome");
const AppShellService = Cc["@mozilla.org/appshell/appShellService;1"].
                                                getService(Ci.nsIAppShellService);

const NS = "http://www.w3.org/1999/xhtml";
const COLOR = "rgb(255,255,255)";


const getScreenshotCanvas = function(window) {
    // TODO: resize window before screenshot and provides clipping and ratio
    let width = window.document.body.offsetWidth;
    let height = window.document.body.scrollHeight;// + window.scrollMaxY;

    let canvas = AppShellService.hiddenDOMWindow.document.createElementNS(NS, "canvas");

    canvas.mozOpaque = true;
    canvas.width = width;
    canvas.height = height;

    let ctx = canvas.getContext("2d");
    ctx.scale(1,1);
    ctx.drawWindow(window, window.scrollX, window.scrollY, width, height, COLOR);

    return canvas;
};
exports.getScreenshotCanvas = getScreenshotCanvas;
