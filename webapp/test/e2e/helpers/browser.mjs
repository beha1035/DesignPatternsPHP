// Playwright bootstrap for the e2e suite — mirrors the exact resolution
// strategy used by .claude/agents/tools/validate-rate.mjs: Playwright is
// installed GLOBALLY in this environment (not as a webapp/node_modules
// dependency), and Chromium is preinstalled under /opt/pw-browsers (do NOT
// run `playwright install`). We only ever navigate to our own local test
// server (127.0.0.1) — no external network is touched by these tests.

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

let chromium;
for (const p of ["/opt/node22/lib/node_modules/playwright", "playwright", "playwright-core"]) {
  try {
    ({ chromium } = require(p));
    break;
  } catch {
    /* try the next resolution path */
  }
}
if (!chromium) {
  throw new Error(
    "Playwright not found. This suite expects the environment's global install " +
      "(/opt/node22/lib/node_modules/playwright) — see .claude/agents/tools/validate-rate.mjs."
  );
}

// The known Chromium shipped with this environment (avoids a re-download).
const EXECUTABLE = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";

// Unlike .claude/agents/tools/validate-rate.mjs (which drives REAL external
// booking sites and therefore must honour HTTPS_PROXY), this e2e suite only
// ever navigates to its own local mock server (127.0.0.1) — there is no
// outbound network to proxy. The environment's HTTPS-only agent proxy (see
// /root/.ccr/README.md) rejects plain-HTTP loopback requests, so we launch
// Chromium with a clean environment (no *_PROXY vars) instead of trying to
// bypass a proxy it would otherwise auto-detect.
const childEnv = Object.fromEntries(
  Object.entries(process.env).filter(([k]) => !/^(https?|HTTPS?|no|NO)_proxy$/i.test(k) && !/_PROXY$/i.test(k))
);

export async function launchBrowser() {
  return chromium.launch({
    headless: true,
    executablePath: EXECUTABLE,
    env: childEnv,
    args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"],
  });
}

export { chromium };
