"use strict";

const {URL} = require("sdk/url");
const {readBinaryURI, registerFile, startServer} = require("net-log/test/utils");

const webpage = require("webpage");

const port = 8099;

startServer(port, URL("fixtures/", module.uri).toString(), [
    "base.html",
    "lorem.txt",
    "window-events.html",
    "js/base.js",
    "js/included.js"
]);

const pageURL = function(path) {
    return "http://127.0.0.1:" + port + path;
};


exports["test open"] = function(assert, done) {
    let p = webpage.create();
    p.open(pageURL("/lorem.txt"), function(status) {
        assert.equal(status, "success");
        assert.ok(p.plainText.indexOf("Lorem") === 0);

        p.close().then(done);
    });
};

exports["test open promise"] = function(assert, done) {
    let p = webpage.create();
    p.open(pageURL("/lorem.txt")).then(function(status) {
        assert.equal(status, "success");
        assert.equal(p.url, pageURL("/lorem.txt"));
    }).then(function() {
        p.close().then(done);
    });
};

exports["test evaluate"] = function(assert, done) {
    let p = webpage.create();
    p.open(pageURL("/base.html"), function(status) {
        p.globals = {
            "fooVar": "bar"
        };
        assert.equal(status, "success");
        let title = p.evaluate(function() {
            return document.title;
        });
        assert.equal(title, "Test page");
        assert.equal(p.url, pageURL("/base.html"));

        assert.equal(1, p.evaluate(function() { return testVar; }));
        assert.equal("bar", p.evaluate(function() { return fooVar; }));
        assert.throws(function() {
            p.globals = {"test": 1};
        });

        p.close().then(done);
    });
};

exports["test include"] = function(assert, done) {
    let p = webpage.create();
    p.open(pageURL("/base.html"))
    .then(function(status) {
        let included = pageURL("/js/included.js");
        p.includeJS(included, function() {
            assert.equal("bar", p.evaluate(function() { return varIncluded; }));
            p.close().then(done);
        });
    });
};

exports["test double load"] = function(assert, done) {
    let p = webpage.create();
    p.open(pageURL("/lorem.txt"))
    .then(function(status) {
        assert.equal(status, "success");
        assert.equal(p.evaluate(function() { return document.title; }), "");
        return p.open(pageURL("/base.html"));
    })
    .then(function(status) {
        assert.ok(p.plainText.indexOf("<!DOCTYPE HTML>") === 0);
        assert.equal(p.evaluate(function() { return document.title; }), "Test page");
        p.close().then(done);
    });
};

exports["test window events"] = function(assert, done) {
    let p = webpage.create();
    let events = {console: []};
    p.onAlert = function(msg) {
        events["alert"] = msg;
    };
    p.onConfirm = function(msg) {
        events["confirm"] = msg;
        return true;
    };
    p.onConsoleMessage = function(msg, lineNum, sourceId) {
        events["console"].push(msg);
    };
    p.onPrompt = function(msg, defaultVal) {
        events["prompt"] = msg;
        return "promptResponse";
    };

    p.open(pageURL("/window-events.html"))
    .then(function(status) {
        assert.equal(events["alert"], "Hello");
        assert.equal(events["confirm"], "Confirm box");
        assert.equal(events["prompt"], "Prompt dialog");
        assert.deepEqual(events["console"], ["Dump", "log"]);

        assert.equal(true, p.evaluate(function() { return _confirm; }));
        assert.equal("promptResponse", p.evaluate(function() { return _prompt; }));

        p.close().then(done);
    });
};

exports["tests options"] = function(assert, done) {
    let p = webpage.create({startTimeout: 0});

    p.open(pageURL("/base.html"))
    .then(function(status) {
        assert.equal(status, "fail");
        p.close().then(done);
    });
};

require("test").run(exports);
