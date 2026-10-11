import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

/**
 * The Browser worker (ADR 0020, Playwright evaluated first): drives a
 * real Chromium against the local test site. Every task gets its own
 * BrowserContext — cookies, storage and credentials never cross
 * tasks (D-T04). Classifications come from the site's deterministic
 * data-state markers, read from the rendered page.
 */
export class BrowserWorker {
  #browser: Browser | undefined;

  async launch(): Promise<void> {
    this.#browser = await chromium.launch({ args: ["--no-sandbox"] });
  }

  async close(): Promise<void> {
    await this.#browser?.close();
    this.#browser = undefined;
  }

  async newTaskContext(): Promise<BrowserContext> {
    if (!this.#browser) throw new Error("browser not launched");
    return this.#browser.newContext();
  }

  async pageState(page: Page): Promise<string | undefined> {
    return (await page.locator("main").getAttribute("data-state")) ?? undefined;
  }

  private async waitState(page: Page, states: string[]): Promise<string> {
    await page.waitForFunction(
      (wanted) => wanted.includes(document.querySelector("main")?.dataset.state ?? ""),
      states,
      { timeout: 15_000 },
    );
    return (await this.pageState(page))!;
  }

  /** Fill and submit the real login form; returns the landing state. */
  async login(
    page: Page,
    baseUrl: string,
    username: string,
    password: string,
  ): Promise<string> {
    await page.goto(`${baseUrl}/login`);
    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');
    return this.waitState(page, ["home", "mfa-waiting", "login-error", "locked"]);
  }

  async submitMfa(page: Page, code: string): Promise<string> {
    await page.fill('input[name="code"]', code);
    await page.click('button[type="submit"]');
    return this.waitState(page, ["home", "mfa-error", "login", "login-mfa-timeout"]);
  }

  async sessionCookie(context: BrowserContext, baseUrl: string): Promise<string | undefined> {
    const cookies = await context.cookies(baseUrl);
    return cookies.find((c) => c.name === "ts_session")?.value;
  }
}
