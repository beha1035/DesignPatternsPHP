// net-guard closes the SSRF gap where a parent's globalThis.fetch patch did not
// reach execFile children. These tests exercise the pure assertSafeUrl policy;
// the side-effect install is covered by importing the module.

import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSafeUrl, isAllowedHost } from "../lib/net-guard.mjs";

test("allows the allowlisted https hosts", () => {
  assert.ok(assertSafeUrl("https://tn.tunisiebooking.com/x"));
  assert.ok(assertSafeUrl("https://www.booking.com/hotel/tn/y.html?a=1"));
  assert.ok(assertSafeUrl("https://serpapi.com/search.json"));
});

test("blocks the cloud-metadata IP and other IP literals", () => {
  assert.throws(() => assertSafeUrl("https://169.254.169.254/latest/meta-data/"), /IP-literal/);
  assert.throws(() => assertSafeUrl("https://127.0.0.1/"), /IP-literal/);
  assert.throws(() => assertSafeUrl("https://[::1]/"), /IP-literal/);
});

test("blocks non-https and non-allowlisted hosts", () => {
  assert.throws(() => assertSafeUrl("http://tn.tunisiebooking.com/"), /non-https/);
  assert.throws(() => assertSafeUrl("https://evil.example.com/"), /allowlist/);
  assert.throws(() => assertSafeUrl("file:///etc/passwd"), /non-https|invalid/);
});

test("the global fetch patch is installed on import", () => {
  assert.equal(globalThis.__NET_GUARD__, true);
});

test("isAllowedHost matches the allowlist and rejects IP literals", () => {
  assert.equal(isAllowedHost("api.apify.com"), true);
  assert.equal(isAllowedHost("evil.example.com"), false);
  assert.equal(isAllowedHost("169.254.169.254"), false);
});
