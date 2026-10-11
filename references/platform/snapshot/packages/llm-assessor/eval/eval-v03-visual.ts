import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { FakeClock } from "@infosec/platform";
import { TestSite } from "@infosec/test-site";
import { chromium, type Page } from "playwright";
import {
  BudgetExceeded,
  BudgetTracker,
  callMessages,
  parseModelJson,
  MAX_TOKENS,
  MODEL_ID,
  PROMPT_SET_ID,
  TEMPERATURE,
  V03_CLASSIFY_TEXT,
  V03_STATES,
  type V03State,
} from "../src/index.js";

/**
 * P3-5 visual pilot (descriptive, no gate — plan §2): capture the
 * four specified visual states of the local test site with a real
 * browser (P3-3 caliber), ask the model to classify each screenshot,
 * and compare against the page's own `data-state` ground truth.
 * The first call doubles as the image-input probe: if the endpoint
 * rejects image blocks, the pilot closes as "channel does not
 * accept image input" and no further calls are made.
 */
const OUT_DIR =
  process.env.EVAL_OUT_DIR ??
  fileURLToPath(new URL("../../eval-out/", import.meta.url));
const SHOTS = `${OUT_DIR}shots/`;

const ACCOUNTS = {
  ok: { username: "acct_ok", password: "test-pwd-correct" },
  nomfa: { username: "acct_nomfa", password: "test-pwd-nomfa" },
  wrong: "test-pwd-wrong",
};

async function pageState(page: Page): Promise<string | null> {
  return page.locator("main").first().getAttribute("data-state");
}

async function submitLogin(
  page: Page,
  username: string,
  password: string,
): Promise<void> {
  await page.fill('input[name="username"]', username);
  await page.fill('input[name="password"]', password);
  await page
    .locator('form[action="/login"]')
    .evaluate((f) => (f as HTMLFormElement).requestSubmit());
  await page.waitForLoadState("load");
}

interface Shot {
  expected: V03State;
  dataState: string | null;
  file: string;
}

async function capture(): Promise<Shot[]> {
  const clock = new FakeClock(1_700_000_000_000);
  const site = new TestSite(clock);
  const base = await site.start();
  const browser = await chromium.launch({ args: ["--no-sandbox"] });
  const shots: Shot[] = [];
  try {
    // blank: a fresh login form.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/login`);
      const file = `${SHOTS}blank.png`;
      await page.screenshot({ path: file });
      shots.push({ expected: "blank", dataState: await pageState(page), file });
      await ctx.close();
    }
    // credential-error: one wrong password for acct_nomfa.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/login`);
      await submitLogin(page, ACCOUNTS.nomfa.username, ACCOUNTS.wrong);
      const file = `${SHOTS}credential-error.png`;
      await page.screenshot({ path: file });
      shots.push({
        expected: "credential-error",
        dataState: await pageState(page),
        file,
      });
      await ctx.close();
    }
    // mfa-waiting: correct login for the MFA account.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      await page.goto(`${base}/login`);
      await submitLogin(page, ACCOUNTS.ok.username, ACCOUNTS.ok.password);
      const file = `${SHOTS}mfa-waiting.png`;
      await page.screenshot({ path: file });
      shots.push({
        expected: "mfa-waiting",
        dataState: await pageState(page),
        file,
      });
      await ctx.close();
    }
    // locked: acct_nomfa already has 1 failure; 4 more reach the
    // 5-failure lockout.
    {
      const ctx = await browser.newContext();
      const page = await ctx.newPage();
      let state: string | null = null;
      for (let i = 0; i < 5 && state !== "locked"; i++) {
        await page.goto(`${base}/login`);
        await submitLogin(page, ACCOUNTS.nomfa.username, ACCOUNTS.wrong);
        state = await pageState(page);
      }
      const file = `${SHOTS}locked.png`;
      await page.screenshot({ path: file });
      shots.push({ expected: "locked", dataState: state, file });
      await ctx.close();
    }
  } finally {
    await browser.close();
    await site.stop();
  }
  return shots;
}

function classify(
  budget: BudgetTracker,
  shot: Shot,
): { modelState: string | null; failure?: string } {
  const data = readFileSync(shot.file).toString("base64");
  try {
    const { text } = callMessages(budget, `v03-classify:${shot.expected}`, {
      model: MODEL_ID,
      max_tokens: MAX_TOKENS,
      temperature: TEMPERATURE,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data },
            },
            { type: "text", text: V03_CLASSIFY_TEXT },
          ],
        },
      ],
    });
    const parsed = parseModelJson(text);
    if (!parsed || typeof parsed.state !== "string") {
      return { modelState: null, failure: "unparseable model output" };
    }
    return { modelState: parsed.state };
  } catch (error) {
    if (error instanceof BudgetExceeded) throw error;
    return {
      modelState: null,
      failure: `call failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function main() {
  mkdirSync(SHOTS, { recursive: true });
  const budget = new BudgetTracker();
  const shots = await capture();
  const results: unknown[] = [];
  let probeAccepted: boolean | null = null;
  let probeFailed = false;
  let stoppedReason: string | undefined;
  // Probe with the credential-error screenshot first.
  const order = [
    ...shots.filter((s) => s.expected === "credential-error"),
    ...shots.filter((s) => s.expected !== "credential-error"),
  ];
  for (const shot of order) {
    if (probeFailed) break;
    try {
      const { modelState, failure } = classify(budget, shot);
      if (probeAccepted === null) {
        probeAccepted = failure === undefined || !failure.startsWith("call failed");
        if (!probeAccepted) {
          probeFailed = true;
          results.push({ ...shot, modelState, failure, probe: true });
          break;
        }
      }
      results.push({
        expected: shot.expected,
        dataState: shot.dataState,
        groundTruthAgrees: shot.dataState !== null,
        modelState,
        correct: modelState === shot.expected,
        validLabel: modelState !== null && (V03_STATES as readonly string[]).includes(modelState),
        failure: failure ?? null,
      });
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        stoppedReason = error.message;
        break;
      }
      throw error;
    }
  }
  const classified = (
    results as { correct?: boolean }[]
  ).filter((r) => typeof r.correct === "boolean");
  const report = {
    chain: "V03-visual-pilot",
    modelId: MODEL_ID,
    promptSetId: PROMPT_SET_ID,
    gateBar: null,
    probeAccepted,
    stoppedReason: stoppedReason ?? null,
    accuracy:
      classified.length === 0
        ? null
        : classified.filter((r) => r.correct).length / classified.length,
    results,
    budget: budget.snapshot(),
  };
  writeFileSync(
    `${OUT_DIR}v03-report.json`,
    JSON.stringify(report, null, 2),
    "utf8",
  );
  console.log(
    JSON.stringify({
      probeAccepted,
      accuracy: report.accuracy,
      classified: classified.length,
      calls: budget.calls,
      totalTokens: budget.totalTokens,
      stoppedReason: stoppedReason ?? null,
    }),
  );
}

main();
