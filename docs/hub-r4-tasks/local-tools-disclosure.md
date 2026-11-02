# 任务：任务包回答披露包号与本地工具（script-distribution 第二步）

依据：决定 35 第 12 问（本地工具下发：只读下载出口，客户端按包号核对后安装）；`docs/hub-r4-tasks/script-distribution.md` 第二步（`list_task_packs` 的每个包加 `digest`，带 `tools/` 的包另列本地工具的路径和 SHA-256，回答文字写一行安装命令不带令牌；`start_run` 的回答同样写这一行）；通用模型 T01 R[1]（规程随 start_run 下发、带摘要）。所有者 2026-11-02 要求 Circle 与 DeepSeek Harness 作为客户端完全兼容，DSH 侧没有 `circle-hub` CLI，模型必须能从 Hub 的回答里拿到包号和安装入口（会话 run_01m6dkfqfpq7561nvvphgr6kr0 卡在 `workbook_verified` 缺工作簿，正是缺这一步的披露）。

- 分支和工作树：`local-tools-disclosure`（从 hub-redesign `fda6a971c` 开出，目录 `~/circle-trees/local-tools-disclosure`）。
- 可以改的路径：
  - `contracts/src/run.ts`、`contracts/src/tools.ts` 及 `npm run gen:contracts` 重新生成的文件；
  - `hub/runs/packs/ports.ts`（`packSummary` 装配 digest 与 local_tools）及其测试；
  - `hub/server/tools.ts`（start_run 回答附加 answer 级 `local_tools`）；
  - `hub/server/text.ts`（list_task_packs 详情与 start_run 各加一行安装命令）及其测试；
  - `tests/acceptance/**` 新增验收；
  - `hub/server/README.md`（客户端中立契约一节）；
  - `docs/hub-r4-progress.md` 补记；
  - 本页。
- 不改：`hub/server/local-tools.ts` 与 `hub/server/cli-local-tools.ts` 的协议（Bearer、Content-Digest、逐文件核对、原子安装都已上线）；`RunSummary`（运行记录不因回答层新增字段而改写，历史运行没有该字段是合法的）；任何 `packs/**`（pack 文案中立化由 pack 分支做）；不加第七个 MCP 工具。

## 要做的（按提交拆分）

1. **提交 A（契约）**：`PackSummary` 加必填 `digest` 与可选 `local_tools`（`LocalToolsSummary`：count、files（path/sha256/size，只列 `tools/` 前缀）、install（钉到 id@version 和包号的安装命令，不带令牌））；`StartRunOutput` 加可选 answer 级 `local_tools`，带“run 缺席则不许出现”的 superRefine。跑 `npm run gen:contracts` 一并交生成物。
2. **提交 B（装配）**：`packSummary` 用 `info.digest` 与 `info.manifest.files` 里 `tools/` 前缀的文件装配 `local_tools`（无 `tools/` 的包不写该字段）；`startRun` handler 用本次冻结包的清单把 `local_tools` 附到回答（`deps.workflows.forUser`；包解析不到就省略，不猜）。测试：`ports.test.ts` 有/无 `tools/` 两种包；构造 `PackSummary` 字面量的既有测试补 `digest`。
3. **提交 C（文字）**：`packEntry` 详情加一行 `本地工具 <n> 个；安装：<install>`（无 `tools/` 的包不加）；`startText` 在 head 加同一行。测试：`text.test.ts`、`text-history.test.ts` 覆盖有/无、预算内、历史运行无该字段。
4. **提交 D（验收与记录）**：`tests/acceptance/**` 合成带 `tools/` 的包发布/分配 → list/start 回答含 digest 与安装行 → `/local-tools` 下载与 `local-tools install/verify` 全通；无 `tools/` 的包无该行。`docs/hub-r4-progress.md` 记录。
5. **提交 E（文档）**：`hub/server/README.md` 末尾“客户端中立契约”一节：端点、安装根（`~/.agents/skills/<pack>/`）、`%HUB_URL%`/`%HUB_TOKEN%` 占位符与脱敏、客户端本地结果只是预览、macOS/Linux。

## 规则

同仓库既定规则：不推送、不建 PR、不发布、不部署；测试只用合成数据；`git commit -s`，一条大写祈使句英文标题；只 stage 明确路径。令牌不进回答、测试与文档；`install` 字符串不携带令牌。
