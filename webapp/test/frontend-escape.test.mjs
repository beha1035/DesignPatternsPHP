// Unit tests for webapp/public/js/escape.js — pure, no DOM, no network.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, sanitizeUrl } from "../public/js/escape.js";

test("escapeHtml: escapes the five HTML-significant characters", () => {
  assert.equal(escapeHtml(`<img src=x onerror="alert(1)">`), "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  assert.equal(escapeHtml(`O'Brien & <b>`), "O&#39;Brien &amp; &lt;b&gt;");
  assert.equal(escapeHtml("`template`"), "&#96;template&#96;");
});

test("escapeHtml: handles null/undefined/number without throwing", () => {
  assert.equal(escapeHtml(null), "");
  assert.equal(escapeHtml(undefined), "");
  assert.equal(escapeHtml(42), "42");
});

test("sanitizeUrl: accepts http/https absolute URLs", () => {
  assert.equal(sanitizeUrl("https://tn.tunisiebooking.com/detail_hotel_354/"), "https://tn.tunisiebooking.com/detail_hotel_354/");
  assert.equal(sanitizeUrl("http://example.com/"), "http://example.com/");
});

test("sanitizeUrl: rejects javascript: URLs (XSS via a clickable link)", () => {
  assert.equal(sanitizeUrl("javascript:alert(1)"), null);
  assert.equal(sanitizeUrl("JavaScript:alert(document.cookie)"), null);
});

test("sanitizeUrl: rejects data:/vbscript:/file: URLs", () => {
  assert.equal(sanitizeUrl("data:text/html,<script>alert(1)</script>"), null);
  assert.equal(sanitizeUrl("vbscript:msgbox(1)"), null);
  assert.equal(sanitizeUrl("file:///etc/passwd"), null);
});

test("sanitizeUrl: rejects relative URLs, empty strings, and non-strings", () => {
  assert.equal(sanitizeUrl("/relative/path"), null);
  assert.equal(sanitizeUrl(""), null);
  assert.equal(sanitizeUrl(null), null);
  assert.equal(sanitizeUrl(undefined), null);
  assert.equal(sanitizeUrl(123), null);
});
