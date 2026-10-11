import assert from "node:assert/strict";
import { mkdir, writeFile, readdir, readFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { chromium, type Page } from "playwright";
import { preview } from "vite";
import type { WorkbenchSnapshot } from "../src/platform/types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const output = path.join(root, "artifacts/browser");
await mkdir(output, { recursive: true });
await rm(path.join(output, "receipt.json"), { force: true });
const server = process.env.WORKBENCH_TEST_URL
  ? undefined
  : await preview({
      root,
      preview: { host: "127.0.0.1", port: 4191, strictPort: true },
    });
const base = process.env.WORKBENCH_TEST_URL ?? "http://127.0.0.1:4191";
const checks: string[] = [];
const errors: string[] = [];
const expectedRenderErrors: string[] = [];
const browser = await chromium.launch();
const sourceFiles: { path: string; sha256: string }[] = [];
async function recordFiles(relative: string) {
  for (const entry of await readdir(path.join(root, relative), {
    withFileTypes: true,
  })) {
    const file = path.join(relative, entry.name);
    if (entry.isDirectory()) await recordFiles(file);
    else
      sourceFiles.push({
        path: file,
        sha256: createHash("sha256")
          .update(await readFile(path.join(root, file)))
          .digest("hex"),
      });
  }
}
for (const directory of ["src", "test", "dist"]) await recordFiles(directory);
for (const file of [
  "package.json",
  "package-lock.json",
  "tsconfig.json",
  "vite.config.ts",
  "index.html",
])
  sourceFiles.push({
    path: file,
    sha256: createHash("sha256")
      .update(await readFile(path.join(root, file)))
      .digest("hex"),
  });
const snapshot = (page: Page) =>
  page.evaluate(
    () =>
      JSON.parse(
        localStorage.getItem("infosec.workbench.preview.v1") ?? "null",
      ) as WorkbenchSnapshot,
  );
async function route(page: Page, hash: string) {
  await page.evaluate((value) => {
    location.hash = value;
  }, hash);
  await page.waitForURL(`${base}/#${hash}`);
  await page
    .locator(`.workspace[data-route="${hash.split("?")[0]}"]`)
    .waitFor();
}
async function check(
  name: string,
  run: (page: Page) => Promise<void>,
  viewport = { width: 1512, height: 982 },
) {
  const context = await browser.newContext({
    viewport,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(`${name}: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") {
      if (
        name ===
          "A plugin render failure leaves the conversation and other plugins usable" &&
        message.text().includes("Cannot read properties of null")
      )
        expectedRenderErrors.push(message.text());
      else errors.push(`${name}: ${message.text()}`);
    }
  });
  try {
    await page.goto(base);
    await page.getByRole("heading", { name: "昨天那次连接中断" }).waitFor();
    await run(page);
    checks.push(name);
    console.log(`PASS ${name}`);
  } finally {
    await context.close();
  }
}
try {
  await check(
    "Harness and management render in light and dark themes",
    async (page) => {
      await page.screenshot({ path: path.join(output, "agent-light.png") });
      await page.getByRole("button", { name: "切换深色主题" }).click();
      assert.equal(
        await page.locator("html").getAttribute("data-theme"),
        "dark",
      );
      await page.screenshot({ path: path.join(output, "agent-dark.png") });
      await page.getByRole("link", { name: "平台管理", exact: true }).click();
      await page
        .getByRole("heading", { name: "知识与记录", exact: true })
        .waitFor();
      await page.screenshot({ path: path.join(output, "knowledge-dark.png") });
      for (const section of [
        "work",
        "execution",
        "capabilities",
        "audit",
        "settings",
      ]) {
        await route(page, `/manage/${section}`);
        await page.locator(".management-heading h1").waitFor();
        assert.ok(
          (await page.locator(".management-heading h1").innerText()).length > 0,
        );
      }
    },
  );
  await check(
    "Free input persists without inventing work or an agent reply",
    async (page) => {
      await page.getByRole("button", { name: "新会话", exact: true }).click();
      await page
        .getByRole("heading", { name: "新会话", exact: true })
        .waitFor();
      const input = page.getByRole("textbox", {
        name: "消息输入",
        exact: true,
      });
      const text =
        "先别分类。帮我核对这段设计，再说下一步。<script>window.injected=true</script>";
      await input.fill(text);
      const id = (await snapshot(page)).conversations[0].id;
      await route(page, "/manage/knowledge");
      await page.getByRole("link", { name: "Agent", exact: true }).click();
      await page.waitForURL(`${base}/#/agent/${id}`);
      await page
        .getByRole("heading", { name: "新会话", exact: true })
        .waitFor();
      assert.equal(await input.inputValue(), text);
      await page.reload();
      assert.equal(await input.inputValue(), text);
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const data = await snapshot(page);
      assert.equal(data.work.length, 3);
      assert.equal(data.conversations[0].messages.length, 1);
      assert.equal(data.conversations[0].messages[0].text, text);
      assert.equal(data.conversations[0].state, "waiting");
      assert.equal(await page.evaluate(() => "injected" in window), false);
      await page.getByRole("button", { name: "重命名会话" }).click();
      await page.getByLabel("会话名称").fill("设计核对");
      await page.getByRole("button", { name: "保存", exact: true }).click();
      await page.reload();
      await page
        .getByRole("heading", { name: "设计核对", exact: true })
        .waitFor();
    },
  );
  await check(
    "Older knowledge revisions are read-only until explicitly attached",
    async (page) => {
      await route(page, "/manage/knowledge?record=source-manual");
      await page.getByLabel("资料修订").selectOption("3");
      assert.equal(await snapshot(page), null);
      await page.getByRole("button", { name: "加入会话", exact: true }).click();
      const refs = (await snapshot(page)).conversations[0].context;
      assert.ok(
        refs.some(
          (ref) => ref.id === "source-manual@4" && ref.revision === "4",
        ),
      );
      assert.ok(
        refs.some(
          (ref) => ref.id === "source-manual@3" && ref.revision === "3",
        ),
      );
    },
  );
  await check(
    "Tool input and output open the associated owner record",
    async (page) => {
      await page
        .getByRole("button", { name: /knowledge.read 读取连接处理说明/ })
        .click();
      assert.match(
        await page.locator(".tool-detail").innerText(),
        /source-manual/,
      );
      assert.match(await page.locator(".tool-detail").innerText(), /revision/);
      await page
        .getByRole("button", { name: "打开关联记录", exact: true })
        .click();
      await page.getByRole("dialog").waitFor();
      assert.ok(page.url().includes("/manage/knowledge?record=source-manual"));
    },
  );
  await check(
    "Pausing A and requesting C pause do not claim D stopped",
    async (page) => {
      await page
        .getByRole("textbox", { name: "消息输入", exact: true })
        .fill("暂停之前先保存这句话。");
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      await page.getByRole("button", { name: "停止会话", exact: true }).click();
      let data = await snapshot(page);
      assert.equal(data.conversations[0].state, "paused");
      assert.equal(data.work[0].requested, "none");
      assert.equal(
        data.resources.find((resource) => resource.id === "resource-ssh")
          ?.status,
        "running",
      );
      await route(page, "/manage/work?record=work-218");
      await page.getByRole("button", { name: "请求暂停", exact: true }).click();
      data = await snapshot(page);
      assert.equal(data.work[0].requested, "pause");
      assert.equal(data.work[0].status, "running");
      assert.equal(
        data.resources.find((resource) => resource.id === "resource-ssh")
          ?.status,
        "running",
      );
    },
  );
  await check(
    "Capabilities load into the selected session without publishing candidates",
    async (page) => {
      await page
        .getByRole("link", { name: "这段说明和代码对不上", exact: true })
        .click();
      await page.getByRole("link", { name: "平台管理", exact: true }).click();
      await route(page, "/manage/capabilities");
      await page.reload();
      await page.getByText("这段说明和代码对不上", { exact: true }).waitFor();
      await page
        .getByRole("checkbox", { name: "加载 测试资料处理", exact: true })
        .check();
      const data = await snapshot(page);
      assert.ok(
        data.conversations
          .find((c) => c.id === "conversation-02")
          ?.capabilityIds.includes("cap-tests"),
      );
      assert.ok(
        !data.conversations
          .find((c) => c.id === "conversation-01")
          ?.capabilityIds.includes("cap-tests"),
      );
      assert.equal(
        data.capabilities.find((c) => c.id === "cap-network-next")?.status,
        "candidate",
      );
      assert.equal(
        await page
          .getByRole("checkbox", {
            name: "加载 网络调查 · 候选版本",
            exact: true,
          })
          .isDisabled(),
        true,
      );
      await page.getByRole("link", { name: "Agent", exact: true }).click();
      await page.waitForURL(`${base}/#/agent/conversation-02`);
      await page
        .getByRole("heading", { name: "这段说明和代码对不上", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "浏览器", exact: true }).click();
      await page
        .getByRole("heading", { name: "尚未关联浏览器", exact: true })
        .waitFor();
    },
  );
  await check(
    "Local attachments are preserved and truncation is disclosed",
    async (page) => {
      const chooser = page.waitForEvent("filechooser");
      await page
        .getByRole("button", { name: "添加本地文件", exact: true })
        .click();
      await (
        await chooser
      ).setFiles([
        {
          name: "synthetic-note.md",
          mimeType: "text/markdown",
          buffer: Buffer.from("# 本地测试\n只检查前端附件。"),
        },
        {
          name: "large-synthetic.txt",
          mimeType: "text/plain",
          buffer: Buffer.alloc(260_000, "a"),
        },
      ]);
      await page
        .getByRole("button", { name: "synthetic-note.md", exact: true })
        .waitFor();
      const refs = (await snapshot(page)).conversations[0].context;
      assert.equal(
        refs.find((ref) => ref.name === "synthetic-note.md")?.preview,
        "# 本地测试\n只检查前端附件。",
      );
      assert.match(
        refs.find((ref) => ref.name === "large-synthetic.txt")?.preview ?? "",
        /预览截取前 256 KB，完整文件未保存/,
      );
      await page.reload();
      await page
        .getByRole("button", { name: "synthetic-note.md", exact: true })
        .click();
      assert.match(
        await page.getByRole("dialog").innerText(),
        /只检查前端附件/,
      );
    },
  );
  await check(
    "Viewer and maintainer interactions follow the preview role boundary",
    async (page) => {
      await route(page, "/manage/settings");
      await page.getByRole("button", { name: "观察员 仅查看业务记录" }).click();
      await route(page, "/agent/conversation-01");
      assert.equal(
        await page
          .getByRole("textbox", { name: "消息输入", exact: true })
          .isDisabled(),
        true,
      );
      await route(page, "/manage/work?record=work-218");
      assert.equal(
        await page
          .getByRole("button", { name: "请求暂停", exact: true })
          .isDisabled(),
        true,
      );
      await page.keyboard.press("Escape");
      await route(page, "/manage/settings");
      await page
        .getByRole("button", { name: "平台运维 执行资源与平台维护" })
        .click();
      await route(page, "/manage/knowledge");
      await page
        .getByText("当前角色无法查看这里的内容", { exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: /连接处理说明/ }).count(),
        0,
      );
      await route(page, "/manage/execution");
      await page.getByRole("button", { name: /LAB-DEVICE-01/ }).waitFor();
    },
  );
  await check(
    "Command search opens records and a terminal command reports no execution",
    async (page) => {
      await page.keyboard.press("ControlOrMeta+k");
      await page.getByRole("dialog").waitFor();
      await page.getByRole("textbox", { name: "搜索内容" }).fill("回归记录");
      await page.getByRole("button", { name: /回归记录/ }).click();
      await page.waitForURL("**/manage/knowledge?record=source-report");
      await page.keyboard.press("Escape");
      await route(page, "/agent/conversation-01");
      await page.getByRole("button", { name: "终端", exact: true }).click();
      await page
        .getByRole("textbox", { name: "终端输入" })
        .fill("show version");
      await page.getByRole("textbox", { name: "终端输入" }).press("Enter");
      assert.match(
        await page.locator(".terminal-panel pre").innerText(),
        /未执行：尚未连接 D 的终端服务/,
      );
      assert.equal(await snapshot(page), null);
    },
  );
  await check(
    "Mobile navigation and context use bounded dialogs",
    async (page) => {
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.screenshot({ path: path.join(output, "agent-mobile.png") });
      await page
        .getByRole("button", { name: "打开会话侧栏", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "会话侧栏", exact: true })
        .waitFor();
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
      await page.keyboard.press("Escape");
      await page.getByRole("button", { name: "打开导航", exact: true }).click();
      await page
        .getByRole("dialog", { name: "导航", exact: true })
        .getByRole("link", { name: "平台管理", exact: true })
        .click();
      await page.locator(".management-heading h1").waitFor();
      assert.equal(await page.getByRole("dialog").count(), 0);
      assert.ok(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      );
    },
    { width: 390, height: 844 },
  );
  await check(
    "Disabling knowledge removes its entry points and retains pinned input",
    async (page) => {
      await page
        .getByRole("textbox", { name: "消息输入", exact: true })
        .fill("引用保留检查");
      const before = await snapshot(page);
      await route(page, "/manage/plugins");
      await page
        .getByRole("checkbox", { name: "启用 知识与记录 插件", exact: true })
        .uncheck();
      await route(page, "/manage/knowledge?record=source-manual");
      await page
        .getByRole("heading", { name: "这个插件已停用", exact: true })
        .waitFor();
      await route(page, "/agent/conversation-01");
      assert.equal(
        await page
          .getByRole("button", { name: "引用资料", exact: true })
          .count(),
        0,
      );
      await page
        .getByRole("button", { name: /knowledge.read 读取连接处理说明/ })
        .click();
      await page
        .getByRole("button", { name: "查看相关插件", exact: true })
        .waitFor();
      assert.match(
        await page.locator(".tool-detail").innerText(),
        /source-manual/,
      );
      await page.getByRole("button", { name: "全局搜索", exact: true }).click();
      await page
        .getByRole("textbox", { name: "搜索内容", exact: true })
        .fill("回归记录");
      await page.getByText("没有找到匹配内容。", { exact: true }).waitFor();
      await page.keyboard.press("Escape");
      assert.deepEqual(await snapshot(page), before);
      await route(page, "/manage/plugins");
      await page
        .getByRole("checkbox", { name: "启用 知识与记录 插件", exact: true })
        .check();
      await route(page, "/manage/knowledge?record=source-manual");
      await page.getByLabel("资料修订").waitFor();
    },
  );
  await check(
    "Circle and InfoSec compositions switch without losing conversations or execution facts",
    async (page) => {
      await page
        .getByRole("textbox", { name: "消息输入", exact: true })
        .fill("组合切换后继续");
      const before = await snapshot(page);
      await route(page, "/manage/plugins");
      await page.screenshot({ path: path.join(output, "plugins-light.png") });
      await page
        .getByRole("button", { name: "使用 Circle 工作台组合", exact: true })
        .click();
      await page.reload();
      assert.equal(
        await page.getByRole("checkbox", { checked: true }).count(),
        0,
      );
      await page.getByRole("link", { name: "Agent", exact: true }).click();
      await page
        .getByRole("heading", { name: "昨天那次连接中断", exact: true })
        .waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "消息输入", exact: true })
          .inputValue(),
        "组合切换后继续",
      );
      assert.equal(
        await page.getByRole("button", { name: "浏览器", exact: true }).count(),
        0,
      );
      assert.equal(
        await page
          .getByRole("heading", { name: "关联的长期工作", exact: true })
          .count(),
        0,
      );
      await page.screenshot({
        path: path.join(output, "circle-composition.png"),
      });
      await page.getByRole("button", { name: "发送消息", exact: true }).click();
      const after = await snapshot(page);
      assert.equal(
        after.conversations[0].messages.at(-1)?.text,
        "组合切换后继续",
      );
      assert.deepEqual(after.work, before.work);
      assert.deepEqual(after.resources, before.resources);
      await route(page, "/manage/plugins");
      await page
        .getByRole("button", { name: "使用 InfoSec 工作台组合", exact: true })
        .click();
      await route(page, "/agent/conversation-01");
      await page
        .getByRole("heading", { name: "关联的长期工作", exact: true })
        .waitFor();
      await page.getByRole("button", { name: "浏览器", exact: true }).waitFor();
    },
  );
  await check(
    "Disabling the active execution panel falls back to context and grants no extra access",
    async (page) => {
      await page.getByRole("button", { name: "浏览器", exact: true }).click();
      await route(page, "/manage/plugins");
      await page
        .getByRole("checkbox", { name: "启用 执行与资源 插件", exact: true })
        .uncheck();
      await route(page, "/agent/conversation-01");
      await page
        .getByRole("heading", { name: "会话上下文", exact: true })
        .waitFor();
      assert.equal(
        await page.getByRole("button", { name: "浏览器", exact: true }).count(),
        0,
      );
      await route(page, "/manage/settings");
      await page
        .getByRole("button", { name: "平台运维 执行资源与平台维护" })
        .click();
      await route(page, "/manage/plugins");
      await page
        .getByRole("button", { name: "使用 Circle 工作台组合", exact: true })
        .click();
      await page
        .getByRole("checkbox", { name: "启用 知识与记录 插件", exact: true })
        .check();
      await route(page, "/manage/knowledge");
      await page
        .getByRole("heading", {
          name: "当前角色无法查看这里的内容",
          exact: true,
        })
        .waitFor();
    },
  );
  await check(
    "A plugin render failure leaves the conversation and other plugins usable",
    async (page) => {
      await page
        .getByRole("textbox", { name: "消息输入", exact: true })
        .fill("隔离渲染故障");
      await page.evaluate(() => {
        const key = "infosec.workbench.preview.v1";
        const data = JSON.parse(localStorage.getItem(key)!);
        data.work = [null];
        localStorage.setItem(key, JSON.stringify(data));
      });
      await page.reload();
      await page.getByText("长期工作暂时无法显示", { exact: true }).waitFor();
      assert.equal(
        await page
          .getByRole("textbox", { name: "消息输入", exact: true })
          .isEnabled(),
        true,
      );
      await route(page, "/manage/work");
      await page.getByText("长期工作暂时无法显示", { exact: true }).waitFor();
      await route(page, "/manage/knowledge");
      await page
        .getByRole("heading", { name: "知识与记录", exact: true })
        .waitFor();
      await page.getByRole("button", { name: /连接处理说明/ }).waitFor();
      assert.ok(expectedRenderErrors.length >= 2);
    },
  );
  assert.deepEqual(
    errors,
    [],
    "Unexpected browser console and uncaught errors",
  );
  await writeFile(
    path.join(output, "receipt.json"),
    JSON.stringify(
      {
        testedAt: new Date().toISOString(),
        sourceFiles: sourceFiles.sort((a, b) => a.path.localeCompare(b.path)),
        base,
        browser: browser.version(),
        checks,
        errors,
        expectedRenderFailureCount: expectedRenderErrors.length,
        scope:
          "Synthetic frontend behavior only; no model, service, desktop host or device connected",
      },
      null,
      2,
    ) + "\n",
  );
  console.log(
    `PASS ${checks.length} browser scenarios; no unexpected browser errors`,
  );
} finally {
  await browser.close();
  await new Promise<void>((resolve, reject) =>
    server
      ? server.httpServer.close((error) => (error ? reject(error) : resolve()))
      : resolve(),
  );
}
