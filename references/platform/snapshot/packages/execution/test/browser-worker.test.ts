import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "@infosec/platform";
import { TestSite, TEST_ACCOUNTS, WRONG_PASSWORD } from "@infosec/test-site";
import { BrowserWorker } from "../src/browser-worker.js";

/**
 * D-T04 (browser part): two tasks log in through a real Chromium in
 * separate contexts; MFA, session expiry and a download are asserted
 * on the rendered pages and the actual bytes — the HTTP flow-level
 * path of P2-6 does not substitute for this. The SSH part of D-T04
 * follows the SSH responsibility plan separately.
 */
describe("D-T04 browser part: two isolated browser tasks against the test site", () => {
  const clock = new FakeClock(1_000_000);
  const site = new TestSite(clock);
  const worker = new BrowserWorker();
  let baseUrl = "";
  const outDir = mkdtempSync(join(tmpdir(), "infosec-browser-"));

  beforeAll(async () => {
    baseUrl = await site.start();
    await worker.launch();
  });

  afterAll(async () => {
    await worker.close();
    await site.stop();
  });

  it("two tasks log in concurrently in separate contexts; credentials, cookies and downloads never cross", async () => {
    const ctxA = await worker.newTaskContext();
    const ctxB = await worker.newTaskContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();

    // Task B (no MFA) goes straight home; task A stops at the MFA page.
    expect(await worker.login(pageB, baseUrl, "acct_nomfa", TEST_ACCOUNTS.acct_nomfa.password)).toBe("home");
    expect(await worker.login(pageA, baseUrl, "acct_ok", TEST_ACCOUNTS.acct_ok.password)).toBe("mfa-waiting");

    // Wrong MFA code is a visible page state, not a silent failure.
    expect(await worker.submitMfa(pageA, "000000")).toBe("mfa-error");
    // The right code comes only from the site-side simulator
    // (out-of-band), keyed by THIS context's session cookie.
    const sessionA = await worker.sessionCookie(ctxA, baseUrl);
    expect(sessionA).toBeTruthy();
    const code = site.simulatorMfaCode(sessionA!);
    expect(code).toBeTruthy();
    expect(await worker.submitMfa(pageA, code!)).toBe("home");

    // Sessions are distinct and each context only carries its own.
    const sessionB = await worker.sessionCookie(ctxB, baseUrl);
    expect(sessionB).toBeTruthy();
    expect(sessionB).not.toBe(sessionA);

    // Download in B yields B's own session report bytes.
    const downloadPromise = pageB.waitForEvent("download");
    await pageB.click('a[href="/download"]');
    const download = await downloadPromise;
    const path = join(outDir, "b-report.txt");
    await download.saveAs(path);
    const bytes = readFileSync(path, "utf8");
    expect(bytes).toContain("account=acct_nomfa");
    expect(bytes).toContain(`session=${sessionB}`);
    expect(bytes).not.toContain("acct_ok");

    // A screenshot is retained as raw channel evidence.
    const shot = join(outDir, "b-home.png");
    await pageB.screenshot({ path: shot });
    expect(existsSync(shot) && statSync(shot).size > 0).toBe(true);

    // Logging out in A does not disturb B's session.
    await pageA.click('form[action="/logout"] button[type="submit"]');
    await pageA.waitForFunction(
      () => document.querySelector("main")?.dataset.state === "login",
      undefined,
      { timeout: 15_000 },
    );
    await pageB.goto(`${baseUrl}/home`);
    expect(await worker.pageState(pageB)).toBe("home");

    await ctxA.close();
    await ctxB.close();
  });

  it("a credential error renders as an error state in the browser, and an MFA wait that times out is classified as timeout", async () => {
    const ctx = await worker.newTaskContext();
    const page = await ctx.newPage();
    expect(await worker.login(page, baseUrl, "acct_nomfa", WRONG_PASSWORD)).toBe("login-error");
    expect(await worker.login(page, baseUrl, "acct_ok", TEST_ACCOUNTS.acct_ok.password)).toBe("mfa-waiting");
    clock.advance(61_000); // beyond the site's 60s MFA window
    await page.reload();
    expect(await worker.pageState(page)).toBe("login-mfa-timeout");
    await ctx.close();
  });

  it("an expired session redirects /home back to the login page in the browser", async () => {
    const ctx = await worker.newTaskContext();
    const page = await ctx.newPage();
    expect(await worker.login(page, baseUrl, "acct_nomfa", TEST_ACCOUNTS.acct_nomfa.password)).toBe("home");
    clock.advance(31 * 60_000); // beyond the 30-minute session TTL
    await page.goto(`${baseUrl}/home`);
    expect(await worker.pageState(page)).toBe("login");
    await ctx.close();
  });
});
