"use strict";

const Q = require("sdk/core/promise");
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
    return "http://localhost:" + port + path;
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

exports["test options"] = function(assert, done) {
    let p = webpage.create({startTimeout: 0});

    p.open(pageURL("/base.html"))
    .then(function(status) {
        assert.equal(status, "fail");
        p.close().then(done);
    });
};

exports["test auth"] = function(assert, done) {
    let grabAuth = function(request) {
        request.headers.forEach(function(v) {
            if (v[0] == "Authorization") {
                this.push(v[1]);
            }
        }.bind(this));
    };

    let p1 = webpage.create();
    let auth1 = [];

    p1.settings.userName = "foo";
    p1.settings.password = "bar";

    p1.on('resourceRequested', grabAuth.bind(auth1));

    let prom1 = p1.open(pageURL("/base.html"))
    .then(function(status) {
        assert.equal(auth1.length, 2);
        assert.equal(auth1[0], "Basic Zm9vOmJhcg==");
        assert.equal(auth1[1], "Basic Zm9vOmJhcg==");
        p1.close();
    });

    let p2 = webpage.create();
    let auth2 = [];

    p2.on('resourceRequested', grabAuth.bind(auth2));

    let prom2 = p2.open(pageURL("/base.html"))
    .then(function(status) {
        // On the same URL but without auth, it should not mix with p1
        assert.equal(auth2.length, 0);
        p2.close();
    });

    Q.promised(Array)(prom1, prom2).then(function() {
        done();
    });
};

exports["test cookies"] = function(assert, done) {
    let p = webpage.create();

    assert.deepEqual(p.cookies, []);

    assert.throws(function() {
        p.addCookie({});
    });
    assert.throws(function() {
        p.addCookie({
            name: "foo",
            value: "bar"
        });
    });

    p.addCookie({
        name: "foo",
        value: "bar",
        domain: ".example.com"
    });
    assert.equal(p.cookies.length, 1);

    p.addCookie({
        name: "woot",
        value: "foo",
        domain: ".example.net"
    });
    assert.equal(p.cookies.length, 2);
    assert.equal(p.cookies[1].value, "foo");

    p.addCookie({
        name: "woot",
        value: "foo2",
        domain: ".example.net"
    });
    assert.equal(p.cookies.length, 2);
    assert.equal(p.cookies[1].value, "foo2");

    assert.throws(function() {
        p.cookies = [{name:"test"}];
    });
    assert.equal(p.cookies.length, 2);

    p.addCookie({
        name: "test",
        value: "cookieTest",
        domain: "localhost"
    });

    p.open(pageURL("/base.html"))
    .then(function() {
        done();
    });
};

require("test").run(exports);
