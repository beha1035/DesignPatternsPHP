// Unit tests for the central anti-SSRF guard. No network: DNS resolution is
// injected via a fake resolver, and the "base fetch" the guarded fetch would
// eventually call is a mock that must NEVER be invoked for a rejected URL.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isPrivateIPv4,
  isPrivateIPv6,
  isPrivateIp,
  assertAllowedUrlShape,
  assertSafeUrl,
  createGuardedFetch,
  SSRFError,
  ALLOWLIST_HOSTS,
} from "../lib/ssrf-guard.mjs";

test("isPrivateIPv4 flags loopback, RFC1918, link-local (cloud metadata), CGNAT", () => {
  assert.equal(isPrivateIPv4("127.0.0.1"), true);
  assert.equal(isPrivateIPv4("169.254.169.254"), true); // cloud metadata endpoint
  assert.equal(isPrivateIPv4("10.0.0.5"), true);
  assert.equal(isPrivateIPv4("172.16.0.1"), true);
  assert.equal(isPrivateIPv4("172.31.255.255"), true);
  assert.equal(isPrivateIPv4("172.32.0.1"), false); // just outside 172.16/12
  assert.equal(isPrivateIPv4("192.168.1.1"), true);
  assert.equal(isPrivateIPv4("100.64.0.1"), true);
  assert.equal(isPrivateIPv4("0.0.0.0"), true);
  assert.equal(isPrivateIPv4("8.8.8.8"), false);
  assert.equal(isPrivateIPv4("93.184.216.34"), false);
});

test("isPrivateIPv6 flags loopback, link-local, ULA, mapped-v4 private", () => {
  assert.equal(isPrivateIPv6("::1"), true);
  assert.equal(isPrivateIPv6("fe80::1"), true);
  assert.equal(isPrivateIPv6("fc00::1"), true);
  assert.equal(isPrivateIPv6("fd12:3456::1"), true);
  assert.equal(isPrivateIPv6("::ffff:127.0.0.1"), true);
  assert.equal(isPrivateIPv6("::ffff:8.8.8.8"), false);
  assert.equal(isPrivateIPv6("2001:4860:4860::8888"), false); // public (Google DNS)
});

test("isPrivateIp dispatches v4/v6 and fails closed on empty input", () => {
  assert.equal(isPrivateIp(""), true);
  assert.equal(isPrivateIp(null), true);
  assert.equal(isPrivateIp("10.1.1.1"), true);
  assert.equal(isPrivateIp("::1"), true);
});

test("assertAllowedUrlShape accepts every host in the OpenAPI x-outbound-allowlist", () => {
  for (const host of ALLOWLIST_HOSTS) {
    assert.doesNotThrow(() => assertAllowedUrlShape(`https://${host}/some/path?x=1`));
  }
});

test("assertAllowedUrlShape rejects a host outside the allowlist", () => {
  assert.throws(() => assertAllowedUrlShape("https://evil.example.com/"), SSRFError);
});

test("assertAllowedUrlShape rejects http:// (non-https) even for an allowlisted host", () => {
  assert.throws(() => assertAllowedUrlShape("http://tn.tunisiebooking.com/"), SSRFError);
});

test("assertAllowedUrlShape rejects file:// scheme", () => {
  assert.throws(() => assertAllowedUrlShape("file:///etc/passwd"), (e) => e instanceof SSRFError);
});

test("assertAllowedUrlShape rejects bare IP literals (metadata endpoint payload)", () => {
  assert.throws(() => assertAllowedUrlShape("https://169.254.169.254/latest/meta-data/"), SSRFError);
  assert.throws(() => assertAllowedUrlShape("http://127.0.0.1:80/"), SSRFError);
  assert.throws(() => assertAllowedUrlShape("https://[::1]/"), SSRFError);
});

test("assertAllowedUrlShape rejects userinfo host-confusion tricks (URL parser resolves the REAL host)", () => {
  // https://tn.tunisiebooking.com@evil.com/ -> hostname is evil.com, not the
  // allowlisted one; must be rejected.
  assert.throws(() => assertAllowedUrlShape("https://tn.tunisiebooking.com@evil.com/"), SSRFError);
});

test("assertAllowedUrlShape rejects a lookalike subdomain of an allowlisted host", () => {
  assert.throws(() => assertAllowedUrlShape("https://tn.tunisiebooking.com.evil.com/"), SSRFError);
  assert.throws(() => assertAllowedUrlShape("https://evil-tn.tunisiebooking.com/"), SSRFError);
});

test("assertSafeUrl rejects when the allowlisted hostname resolves to a private IP (DNS rebinding defense)", async () => {
  const fakeResolve = async () => ["169.254.169.254"];
  await assert.rejects(
    () => assertSafeUrl("https://tn.tunisiebooking.com/x", { resolveHostname: fakeResolve }),
    (e) => e instanceof SSRFError && e.reason === "private-ip"
  );
});

test("assertSafeUrl passes when DNS resolves to a public IP", async () => {
  const fakeResolve = async () => ["93.184.216.34"];
  const url = await assertSafeUrl("https://tn.tunisiebooking.com/x", { resolveHostname: fakeResolve });
  assert.equal(url.hostname, "tn.tunisiebooking.com");
});

test("createGuardedFetch never calls the base fetch for a disallowed URL", async () => {
  let called = false;
  const baseFetch = async () => {
    called = true;
    return { ok: true };
  };
  const guarded = createGuardedFetch(baseFetch, { resolveHostname: async () => ["93.184.216.34"] });
  await assert.rejects(() => guarded("https://169.254.169.254/"), SSRFError);
  assert.equal(called, false, "base fetch must never be invoked for a blocked URL");
});

test("createGuardedFetch calls the base fetch for an allowlisted, publicly-resolving URL", async () => {
  let called = false;
  const baseFetch = async (url) => {
    called = true;
    return { ok: true, url };
  };
  const guarded = createGuardedFetch(baseFetch, { resolveHostname: async () => ["93.184.216.34"] });
  const res = await guarded("https://tn.tunisiebooking.com/x");
  assert.equal(called, true);
  assert.equal(res.ok, true);
});
