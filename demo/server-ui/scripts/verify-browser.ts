import { chromium, type Page } from "playwright";
import assert from "node:assert/strict";
import fs from "node:fs";
const base = process.env.DEMO_BASE_URL ?? "http://127.0.0.1:4317/";
const browser = await chromium.launch({
  headless: true,
  ...(process.env.DEMO_BROWSER_EXECUTABLE
    ? { executablePath: process.env.DEMO_BROWSER_EXECUTABLE }
    : {}),
});
const results: { name: string; passed: boolean; error?: string }[] = [];
const pageErrors: string[] = [];
fs.mkdirSync(".tmp", { recursive: true });
async function scenario(
  name: string,
  fn: (p: Page) => Promise<void>,
  viewport = { width: 1440, height: 1000 },
) {
  const context = await browser.newContext({ viewport });
  const p = await context.newPage();
  p.on("pageerror", (e) => pageErrors.push(name + ": " + e.message));
  p.setDefaultTimeout(8000);
  try {
    await p.goto(base + "?view=server");
    await fn(p);
    results.push({ name, passed: true });
    console.log("PASS " + name);
  } catch (e) {
    results.push({ name, passed: false, error: String(e) });
    console.log("FAIL " + name + " " + String(e).slice(0, 700));
    await p.screenshot({
      path: ".tmp/failure-" + results.length + ".png",
      fullPage: true,
    });
  } finally {
    await context.close();
  }
}
const nav = async (p: Page, label: string) => {
  if (await p.locator(".mobile-menu").isVisible())
    await p.getByRole("button", { name: "打开导航" }).click();
  await p
    .locator("nav")
    .getByRole("button", { name: label, exact: false })
    .click();
};
const role = async (p: Page, value: string) =>
  p.getByLabel("演示角色", { exact: true }).selectOption(value);
const task = async (p: Page, title: string) => {
  await nav(p, "任务与运行");
  await p.getByRole("row").filter({ hasText: title }).first().click();
};

await scenario(
  "Agent draft, test, approval, publish and in-flight version",
  async (p) => {
    await p
      .locator(".agent-table")
      .getByRole("row")
      .filter({ hasText: "网络排障 Agent" })
      .click();
    await p.getByRole("tab", { name: "设置", exact: true }).click();
    await p.locator("textarea").fill("先核对两段 TLS，缺少证据时保留未知项");
    await p.getByRole("button", { name: "保存草稿", exact: true }).click();
    await p.getByRole("tab", { name: "版本与发布" }).click();
    await p.getByRole("button", { name: "发布 1.4.0", exact: true }).click();
    await p.getByRole("status").filter({ hasText: "发布前需要" }).waitFor();
    await p.getByRole("tab", { name: "测试", exact: true }).click();
    await p.getByRole("button", { name: "运行测试示例" }).click();
    await p.locator(".test-trace").getByRole("button").nth(3).click();
    assert.ok(
      (await p.locator(".trace-inspector").innerText()).includes(
        "deviceOperations",
      ),
    );
    await role(p, "approver");
    await p.getByRole("tab", { name: "版本与发布" }).click();
    await p.getByRole("button", { name: "批准当前草稿", exact: true }).click();
    await role(p, "expert");
    await p.getByRole("button", { name: "发布 1.4.0", exact: true }).click();
    await p
      .locator(".agent-detail-heading")
      .filter({ hasText: "当前版本 1.4.0" })
      .waitFor();
    await p.getByRole("tab", { name: "运行记录", exact: true }).click();
    assert.ok((await p.locator("tbody").innerText()).includes("1.3.0"));
    await p.screenshot({ path: ".tmp/agent-version.png", fullPage: true });
  },
);

await scenario(
  "Circle creates work using selected published Agent and retains it across disconnect",
  async (p) => {
    await role(p, "tester");
    await p
      .locator(".mode-switch")
      .getByRole("button", { name: "返回会话", exact: true })
      .click();
    await p.getByRole("button", { name: "新会话", exact: true }).click();
    await p
      .getByLabel("Circle 消息输入", { exact: true })
      .fill("评审这组用例，保留缺少依据的预期");
    await p.getByRole("button", { name: "发送消息", exact: true }).click();
    await p
      .locator(".conversation-header")
      .filter({ hasText: "评审这组用例" })
      .waitFor();
    assert.equal(
      await p.evaluate(
        () =>
          JSON.parse(localStorage.getItem("circle-server-design-demo-v3")!)
            .tasks[0].agentId,
      ),
      "AGT-003",
    );
    await p.getByRole("button", { name: "模拟断开连接", exact: true }).click();
    assert.equal(
      await p.getByLabel("Circle 消息输入", { exact: true }).isDisabled(),
      true,
    );
    await p
      .getByRole("button", { name: "重连同一组工作", exact: true })
      .click();
    assert.equal(
      await p.getByLabel("Circle 消息输入", { exact: true }).isDisabled(),
      false,
    );
    await p.screenshot({ path: ".tmp/circle.png", fullPage: true });
  },
);

await scenario(
  "published knowledge stays pinned until explicit input revision",
  async (p) => {
    await nav(p, "知识库");
    await p.getByRole("tab", { name: "公司系统接入" }).click();
    await p
      .locator(".source-card")
      .filter({ hasText: "产品文档中心" })
      .getByRole("button", { name: "同步演示" })
      .click();
    await p.getByRole("tab", { name: "版本与发布" }).click();
    await p.getByRole("button", { name: "发布候选演示" }).click();
    await task(p, "支付网关间歇性 502");
    assert.ok(
      (await p.locator(".context-panel").innerText()).includes("KS-20261010.3"),
    );
    await p.getByRole("button", { name: "改用新快照并重新检查" }).click();
    await p.getByRole("tab", { name: "运行记录", exact: true }).click();
    const rows = await p.locator(".task-detail tbody").innerText();
    assert.ok(rows.includes("input-r3"));
    assert.ok(rows.includes("input-r4"));
  },
);

await scenario(
  "input revision preserves prior run and removes old approval",
  async (p) => {
    await role(p, "approver");
    await task(p, "支付网关间歇性 502");
    await p.getByRole("button", { name: "批准本次动作", exact: true }).click();
    await role(p, "tester");
    await p.getByRole("button", { name: "补充输入", exact: true }).click();
    await p
      .getByRole("dialog")
      .locator("textarea")
      .fill("只读调查，不调整配置");
    await p.getByRole("button", { name: "保存新修订" }).click();
    await p.getByRole("tab", { name: "运行记录", exact: true }).click();
    const text = await p.locator(".task-detail tbody").innerText();
    assert.ok(text.includes("input-r3"));
    assert.ok(text.includes("input-r4"));
    await p.screenshot({ path: ".tmp/task-runs.png", fullPage: true });
  },
);

await scenario(
  "ops and security identities do not read business or search snippets",
  async (p) => {
    for (const who of ["ops", "security"]) {
      await role(p, who);
      await nav(p, "知识库");
      await p
        .getByRole("heading", { name: "资料正文不在当前授权内" })
        .waitFor();
      await p
        .getByRole("button", { name: "搜索任务、资料和功能", exact: false })
        .click();
      await p.getByRole("dialog").getByRole("textbox").fill("支付网关");
      assert.equal(
        await p
          .locator(".search-results")
          .getByRole("button")
          .filter({ hasText: "支付网关间歇性 502" })
          .count(),
        0,
      );
      await p.getByRole("button", { name: "关闭对话框" }).click();
    }
  },
);

await scenario(
  "policy evaluator denies test operator in production and audit records are queryable",
  async (p) => {
    await role(p, "security");
    await nav(p, "组织权限");
    await p.getByRole("tab", { name: "资源授权" }).click();
    await p.getByLabel("权限测试角色", { exact: true }).selectOption("tester");
    await p
      .getByLabel("权限测试环境", { exact: true })
      .selectOption("production");
    await p.getByRole("button", { name: "查看授权示例" }).click();
    await p
      .locator(".policy-result")
      .filter({ hasText: "这个范围内拒绝" })
      .waitFor();
    await nav(p, "审计日志");
    await p.getByLabel("环境", { exact: true }).selectOption("production");
    await p.getByLabel("日志结果筛选", { exact: true }).selectOption("denied");
    assert.ok((await p.locator("tbody tr").count()) > 0);
    await p.locator("tbody tr").first().click();
    assert.ok((await p.getByRole("dialog").innerText()).includes("policy-r8"));
    await p.screenshot({ path: ".tmp/audit.png", fullPage: true });
  },
);

await scenario(
  "long task stops only after explicit simulated observation",
  async (p) => {
    await role(p, "tester");
    await nav(p, "自动化");
    await p.getByRole("tab", { name: "长期工作" }).click();
    await p.getByRole("button", { name: "请求停止", exact: true }).click();
    await p
      .locator(".long-task-card")
      .filter({ hasText: "停止核对中" })
      .waitFor();
    await p.getByRole("button", { name: "查看工作与证据" }).click();
    await p.getByRole("button", { name: "模拟现场核对" }).click();
    await p
      .locator(".detail-title")
      .filter({ hasText: "已确认停止" })
      .waitFor();
  },
);

await scenario(
  "automation rule pause and overlap rejection preserve independent runs",
  async (p) => {
    await role(p, "tester");
    await nav(p, "自动化");
    const row = p.getByRole("row").filter({ hasText: "每日测试域配置巡检" });
    await row.getByRole("button", { name: "暂停", exact: true }).click();
    await row.filter({ hasText: "已暂停" }).waitFor();
    await row.getByRole("button", { name: "立即运行" }).click();
    await row.getByRole("button", { name: "立即运行" }).click();
    await p.getByRole("status").filter({ hasText: "已有实例" }).waitFor();
    await p.getByRole("tab", { name: "触发与运行历史" }).click();
    assert.equal(await p.locator("tbody tr").count(), 2);
  },
);

await scenario(
  "task deep link opens same session and modal shares browser state",
  async (p) => {
    await role(p, "tester");
    await task(p, "支付网关间歇性 502");
    await p.getByRole("button", { name: "查看关联现场" }).click();
    assert.equal(
      await p
        .getByRole("tab", { name: "当前现场" })
        .getAttribute("aria-selected"),
      "true",
    );
    await p
      .locator(".session-binding")
      .filter({ hasText: "OP-4107" })
      .waitFor();
    await p.getByRole("button", { name: "单独查看", exact: true }).click();
    await p
      .getByRole("dialog")
      .getByRole("button", { name: "演示下一步" })
      .click();
    assert.equal(
      await p
        .locator(".device-browser")
        .filter({ hasText: "配置回读样例" })
        .count(),
      2,
    );
    assert.ok((await p.getByRole("dialog").innerText()).includes("OP-4107"));
    await p.screenshot({ path: ".tmp/shared-browser.png", fullPage: true });
  },
);

await scenario(
  "viewer can observe but device control is rejected",
  async (p) => {
    await role(p, "viewer");
    await nav(p, "执行环境");
    await p.getByRole("tab", { name: "当前现场" }).click();
    await p.getByRole("button", { name: "接管现场", exact: true }).click();
    await p.getByRole("status").filter({ hasText: "没有这项权限" }).waitFor();
    assert.ok(
      (await p.locator(".session-binding").innerText()).includes("Agent"),
    );
  },
);

await scenario(
  "all management pages render for their intended identities without errors",
  async (p) => {
    for (const label of [
      "Agents",
      "任务与运行",
      "待我处理",
      "自动化",
      "知识库",
      "技能与工具",
      "执行环境",
      "研发交付",
    ]) {
      await role(p, "expert");
      await nav(p, label);
      await p.getByRole("heading", { level: 1 }).waitFor();
    }
    for (const label of ["运行观测", "部署与恢复"]) {
      await role(p, "ops");
      await nav(p, label);
      await p.getByRole("heading", { level: 1 }).waitFor();
    }
    for (const label of ["组织权限", "审计日志"]) {
      await role(p, "security");
      await nav(p, label);
      await p.getByRole("heading", { level: 1 }).waitFor();
    }
    await p.getByRole("button", { name: "了解系统设计", exact: false }).click();
    for (const label of [
      "产品信息结构",
      "四对象要素",
      "公司知识接入",
      "用户工作与长期执行",
      "调研与设计依据",
    ])
      await p.getByRole("tab", { name: label, exact: true }).click();
  },
);

await scenario(
  "mobile navigation and page containment",
  async (p) => {
    for (const label of [
      "Agents",
      "任务与运行",
      "自动化",
      "知识库",
      "组织权限",
    ]) {
      await nav(p, label);
      const bounds = await p.evaluate(() => ({
        width: innerWidth,
        documentWidth: document.documentElement.scrollWidth,
      }));
      assert.ok(
        bounds.documentWidth <= bounds.width + 1,
        label + " has document overflow " + JSON.stringify(bounds),
      );
    }
    await p.getByRole("button", { name: "了解系统设计", exact: false }).click();
    await p.getByRole("tab", { name: "四对象要素" }).click();
    await p.screenshot({ path: ".tmp/mobile.png", fullPage: true });
  },
  { width: 390, height: 844 },
);

await browser.close();
const receipt = {
  checkedAt: new Date().toISOString(),
  baseUrl: base,
  browser: "Existing isolated Chromium headless shell",
  scenarios: results,
  pageErrors,
  scope:
    "Frontend interactions and mock-model constraints only; not server authorization, model quality or device verification",
  modelCalls: 0,
  deviceConnections: 0,
};
fs.writeFileSync(
  ".tmp/browser-receipt.json",
  JSON.stringify(receipt, null, 2) + "\n",
);
assert.equal(
  results.filter((r) => !r.passed).length,
  0,
  "browser scenarios failed",
);
assert.equal(pageErrors.length, 0, "unexpected page errors");
console.log(
  JSON.stringify({ passed: results.length, pageErrors: pageErrors.length }),
);
