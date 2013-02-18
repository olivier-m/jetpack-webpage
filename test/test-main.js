"use strict";

const Q = require("sdk/core/promise");
const {URL} = require("sdk/url");
const {readBinaryURI, registerFile, startServer} = require("net-log/test/utils");

const webpage = require("webpage");

const port = 8099;

let srv = startServer(port, URL("fixtures/", module.uri).toString(), [
    "base.html",
    "lorem.txt",
    "window-events.html",
    "js/base.js",
    "js/included.js"
]);
srv.registerPathHandler("/cookie", function(request, response) {
    response.setStatusLine(request.httpVersion, 200, "OK");
    response.setHeader("Content-Type", "text/plain; charset=UTF-8", false);
    response.setHeader("Set-Cookie", "myCookie=foo-bar; path=/cookie", false);
    response.processAsync();
    response.write("test");
    response.finish();
});

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
            if (v.name == "Authorization") {
                this.push(v.value);
            }
        }.bind(this));
    };

    let p1 = webpage.create();
    let auth1 = [];

    p1.settings.userName = "foo";
    p1.settings.password = "bar";

    p1.on('resourceRequested', grabAuth.bind(auth1));

    let prom1 = p1.open(pageURL("/base.html")).then(p1.close);

    let p2 = webpage.create();
    let auth2 = [];

    p2.on('resourceRequested', grabAuth.bind(auth2));

    let prom2 = p2.open(pageURL("/base.html")).then(p2.close);

    Q.promised(Array)(prom1, prom2).then(function() {
        assert.equal(auth1.length, 2);
        assert.equal(auth1[0], "Basic Zm9vOmJhcg==");
        assert.equal(auth1[1], "Basic Zm9vOmJhcg==");

        // On the same URL but without auth, it should not mix with p1
        assert.equal(auth2.length, 0);
        done();
    });
};

exports["test cookies"] = function(assert, done) {
    let grabCookies = function(request) {
        request.headers.forEach(function(v) {
            if (v.name === "Cookie") {
                this.push(v.value);
            }
        }.bind(this));
    };

    let p1 = webpage.create();
    let p2 = webpage.create();
    let p3 = webpage.create();

    assert.deepEqual(p1.cookies, []);

    assert.throws(function() {
        p1.addCookie({});
    });
    assert.throws(function() {
        p1.addCookie({
            name: "foo",
            value: "bar"
        });
    });

    p1.addCookie({
        name: "foo",
        value: "bar",
        domain: ".example.com"
    });
    assert.equal(p1.cookies.length, 1);

    p1.addCookie({
        name: "woot",
        value: "foo",
        domain: ".example.net"
    });
    assert.equal(p1.cookies.length, 2);
    assert.equal(p1.cookies[1].value, "foo");

    p1.addCookie({
        name: "woot",
        value: "foo2",
        domain: ".example.net"
    });
    assert.equal(p1.cookies.length, 2);
    assert.equal(p1.cookies[1].value, "foo2");

    assert.throws(function() {
        p1.cookies = [{name:"test"}];
    });
    assert.equal(p1.cookies.length, 2);

    p1.addCookie({
        name: "test",
        value: "cookieTest",
        domain: "localhost"
    });

    let c1 = [];
    p1.on("resourceRequested", grabCookies.bind(c1));
    let prom1 = p1.open(pageURL("/base.html")).then(p1.close);

    let c2 = [];
    p2.on("resourceRequested", grabCookies.bind(c2));
    let prom2 = p2.open(pageURL("/base.html")).then(p2.close);

    let prom3 = p3.open(pageURL("/cookie")).then(p3.close);

    Q.promised(Array)(prom1, prom2, prom3).then(function() {
        assert.equal(c1.length, 2);
        assert.equal(c1[0], p1.cookies[2].name + "=" + p1.cookies[2].value);
        assert.equal(c1[1], p1.cookies[2].name + "=" + p1.cookies[2].value);

        assert.equal(c2.length, 0);

        assert.equal(p3.cookies.length, 1);
        assert.equal(p3.cookies.toString(), "myCookie=foo-bar; domain=localhost; path=/cookie");
        done();
    });
};


require("test").run(exports);
