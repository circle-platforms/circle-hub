# @infosec/harness-adapters

三家 harness 的薄适配与 L3 验证驱动（P3-4，依据 ADR 0018）。harness 本身是外部固定版本工具，本包不内嵌它们，只保存：脚本化模型端点（`src/scripted-llm.mjs`）、Circle 的 loader 驱动（`drivers/circle-driver.mjs`）、R06 接管序列与 R07 跨 harness 信封配对的编排脚本（`drivers/run-r06.mjs` / `run-r07.mjs`）。各 harness 的配置（OpenCode 的 `opencode.json`、Pi 的 `mcp.json`/`models.json`）由编排脚本按运行目录生成，内容以脚本为准。

## 固定版本（2026-10-10 集成时）

| harness | 固定点 | 获取方式 |
|---|---|---|
| OpenCode | 1.18.35 | `npm install opencode-ai@1.18.35`（或 npx 同版本） |
| Circle | 提交 `9b532727e4433f2d0fa6a0d222a4509daf7f15e4`（包版本 1.0.4） | 克隆 `qingshanfeihu/circle` 后 `npm install && npm run build`，`CIRCLE_DIST` 指向其 `dist/` |
| Pi | 1.1.0 | `npm install @earendil-works/pi-coding-agent@1.1.0`（或 npx 同版本） |

平台侧被测对象是 `packages/server-stub` 的 MCP 传输（先在其目录 `npm install && npm run build`，`STUB_ENTRY` 指向 `dist/mcp-server.js`）。stub 的状态文件、协商日志与审计日志由 `STUB_STATE_FILE` / `STUB_NEGOTIATION_LOG` / `STUB_AUDIT_LOG` / `STUB_PRINCIPAL` 环境变量开启（P3-4 为 MCP 传输补齐，与 CLI 传输共用同一状态格式）。

## 运行

```bash
STUB_ENTRY=<abs path to server-stub/dist/mcp-server.js> \
CIRCLE_DIST=<abs path to circle/dist> \
OPENCODE_BIN=<opencode binary> PI_BIN=<pi binary> \
node drivers/run-r06.mjs   # 接管序列，断言三方审计序列与协商记录
node drivers/run-r07.mjs   # 同场景三方信封配对，断言归一化后深度相等
```

注意（均在 P3-4 记录中有实测依据）：两家 harness 的无头模式都会读 stdin，驱动必须关 stdin；OpenCode 必须显式 `--model` 固定模型，否则配置的 provider 不可用时它会静默回退到内置免费模型；Pi 的 MCP 默认 exposure 是 codemode，平台工具需在配置里声明 `exposure: "direct"` 才对模型直接可见。
