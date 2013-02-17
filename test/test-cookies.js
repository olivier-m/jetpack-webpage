"use strict";

const {Cookie, parseCookie} = require("webpage/utils");

exports["test simple"] = function(assert) {
    let cookie = Cookie({
        name: "test",
        value: "1",
        domain: "example.com"
    });

    assert.equal(cookie.path, "/");
    assert.equal(cookie.httponly, true);
    assert.equal(cookie.secure, false);
    assert.equal(cookie.expires, null);
};

exports["test domain"] = function(assert) {
    let cookie = Cookie({
        name: "test",
        value: "1",
        domain: ".example.com"
    });

    assert.equal(cookie.check("http://www.example.com/"), true);
    assert.equal(cookie.check("http://images.example.com/"), true);
    assert.equal(cookie.check("http://www.testexample.com/"), false);
};

exports["test path"] = function(assert) {
    let cookie = Cookie({
        name: "test",
        value: 1,
        domain: "www.example.net",
        path: "/test/"
    });

    assert.equal(cookie.check("http://www.example.net/"), false);
    assert.equal(cookie.check("http://www.example.net/test/"), true);
    assert.equal(cookie.check("http://www.example.net/test/foo"), true);
};

exports["test perm"] = function(assert) {
    let cookie = Cookie({
        name: "test",
        value: "1",
        domain: "example.org"
    });

    assert.equal(cookie.check("http://www.example.org/"), false);
    assert.equal(cookie.check("http://example.org/"), true);
    assert.equal(cookie.check("http://example.org/foo"), true);
};

exports["test parser"] = function(assert) {
    let c, cookie;

    c = "PREF=ID=68:FF=0:TM=1; expires=Tue, 17-Feb-2015 23:01:18 GMT; path=/; domain=.example.org";
    cookie = parseCookie(c, "http://www.example.org/");

    assert.equal(cookie.name, "PREF");
    assert.equal(cookie.value, "ID=68:FF=0:TM=1");
    assert.equal(cookie.path, "/");
    assert.equal(cookie.domain, ".example.org");
    assert.equal(cookie.httponly, false);
    assert.equal(cookie.secure, false);
    assert.equal(cookie.expires.getFullYear(), 2015);

    c = "W=1; path=/test/; secure; HttpOnly";
    cookie = parseCookie(c, "https://www.example.org/");
    assert.equal(cookie.path, "/test/");
    assert.equal(cookie.domain, "www.example.org");
    assert.equal(cookie.httponly, true);
    assert.equal(cookie.secure, true);

    cookie = parseCookie(c, "http://www.example.org/");
    assert.equal(cookie.secure, false);
};

require("test").run(exports);
