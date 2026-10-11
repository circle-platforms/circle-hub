import { chromium } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { scenarios } from "../src/workflows.ts";
const base = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:4317/";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DEMO_BROWSER_EXECUTABLE
    ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE }
    : {}),
});
const results: { name: string; passed: boolean; error?: string }[] = [];
const errors: string[] = [];
fs.mkdirSync(".tmp", { recursive: true });
for (const scenario of scenarios) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(scenario.id + ": " + e.message));
  try {
    await page.goto(base);
    await page
      .getByLabel("演示角色", { exact: true })
      .selectOption(scenario.id === "commercial" ? "commercial" : "tester");
    assert.equal(
      await page.getByLabel("新会话 Agent", { exact: true }).count(),
      0,
    );
    assert.equal(await page.getByText("工作目录", { exact: true }).count(), 0);
    await page
      .getByLabel("Circle 消息输入", { exact: true })
      .fill(scenario.prompt);
    await page
      .getByLabel("Circle 附加材料", { exact: true })
      .setInputFiles({
        name: scenario.materials[0].name,
        mimeType: "text/plain",
        buffer: Buffer.from(scenario.materials[0].text),
      });
    await page.getByRole("button", { name: "发送消息", exact: true }).click();
    const current = async () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("circle-server-design-demo-v3")!)
            .tasks[0],
      );
    assert.equal((await current()).scenarioId, scenario.id);
    for (
      let guard = 0;
      guard < 10 && (await current()).phase !== "done";
      guard++
    ) {
      const task = await current();
      if (task.phase === "review") {
        await page
          .getByLabel("演示角色", { exact: true })
          .selectOption("approver");
        await page
          .getByRole("button", { name: "批准并继续", exact: true })
          .click();
        await page
          .getByLabel("演示角色", { exact: true })
          .selectOption("tester");
      } else if (task.phase === "waiting" && scenario.clarification) {
        await page
          .getByLabel("Circle 消息输入", { exact: true })
          .fill("合成补充：缺少的命令和通过阈值仍保持待确认。");
        await page
          .getByRole("button", { name: "发送消息", exact: true })
          .click();
      } else if (
        scenario.id === "review" &&
        !task.workflowState.appliedRevision
      ) {
        await page.locator(".conversation-result").click();
        const findings = page.locator(".conversation-finding");
        await findings
          .nth(0)
          .getByRole("button", { name: "采用这条建议", exact: true })
          .click();
        await findings
          .nth(1)
          .getByRole("button", { name: "采用这条建议", exact: true })
          .click();
        await page.screenshot({
          path: ".tmp/conversation-review.png",
          fullPage: true,
        });
        await page
          .getByRole("button", { name: "按本轮意见生成结果", exact: true })
          .click();
      } else if (
        scenario.id === "outline" &&
        !task.workflowState.artifactReceipt
      ) {
        await page.locator(".conversation-result").click();
        await page
          .getByRole("button", { name: "生成 Excel", exact: true })
          .click();
        await page
          .getByText("工作簿已生成并读回检查", { exact: true })
          .waitFor();
        await page.screenshot({
          path: ".tmp/conversation-outline.png",
          fullPage: true,
        });
      } else throw new Error("Unexpected interaction state: " + task.phase);
    }
    assert.equal((await current()).phase, "done");
    if (!(await page.locator(".conversation-artifact").count()))
      await page.locator(".conversation-result").click();
    const downloadPromise = page.waitForEvent("download");
    await page
      .getByRole("button", {
        name:
          scenario.id === "outline"
            ? "下载 Excel"
            : scenario.id === "review"
              ? "下载评审报告"
              : "保存结果",
        exact: true,
      })
      .click();
    const download = await downloadPromise;
    const path =
      ".tmp/chat-" +
      scenario.id +
      (scenario.id === "outline"
        ? ".xlsx"
        : scenario.id === "review"
          ? ".md"
          : ".json");
    await download.saveAs(path);
    if (scenario.id === "outline") {
      const xml = execFileSync("unzip", ["-p", path, "xl/workbook.xml"], {
        encoding: "utf8",
      });
      assert.ok(xml.includes("用例清单") && xml.includes("说明"));
    } else if (scenario.id !== "review")
      assert.equal(
        JSON.parse(fs.readFileSync(path, "utf8")).source,
        "synthetic-demo",
      );
    else assert.ok(fs.readFileSync(path, "utf8").includes("采用建议"));
    results.push({ name: scenario.title, passed: true });
    console.log("PASS " + scenario.title);
  } catch (e) {
    results.push({ name: scenario.title, passed: false, error: String(e) });
    console.log("FAIL " + scenario.title + " " + String(e).slice(0, 400));
    await page.screenshot({
      path: ".tmp/chat-failure-" + scenario.id + ".png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
}
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
try {
  await page.goto(base);
  await page
    .getByRole("button", { name: "把这份脑图整理成 Excel", exact: true })
    .click();
  await page.getByRole("button", { name: "发送消息", exact: true }).click();
  await page.locator(".conversation-result").click();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
    true,
  );
  await page.screenshot({
    path: ".tmp/conversation-mobile.png",
    fullPage: true,
  });
  results.push({
    name: "mobile conversation and contextual artifact",
    passed: true,
  });
} catch (e) {
  results.push({
    name: "mobile conversation and contextual artifact",
    passed: false,
    error: String(e),
  });
}
await context.close();
await browser.close();
fs.writeFileSync(
  ".tmp/workflows-browser-report.json",
  JSON.stringify({ base, results, pageErrors: errors }, null, 2),
);
console.log(
  JSON.stringify({
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    pageErrors: errors.length,
  }),
);
if (results.some((r) => !r.passed) || errors.length) process.exitCode = 1;
