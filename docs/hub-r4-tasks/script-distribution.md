# 任务：Hub 下发任务包的本地工具，客户端按包号和摘要核对后安装

依据：

- 决定 35“上真实台架”第 12 问（`docs/hub-r4-progress.md`）：这一轮由集成者把脚本放进所有者 Circle 的技能目录并核对摘要；Hub 的通用下发也做。
- 决定 26：生成在客户端，任务包随技能带确定性的生成脚本，Hub 回读解析、按生成规则重算比对。装在客户端的那一份只是方便，算数的是 Hub 的重算。
- 模型（`node tools/show-element.ts T01 T02 D06 R02 B04`；待定项用 `node tools/show-element.ts --pending`）：
  - T01 F[9]：本地工具，下发方式待你决定；T01 R[1]：本地工具要 Circle 能安装包内脚本，现有 6 项通用改进做不到；T01 R[0]：Circle 当本地脚本跑的只作预览，标“客户端预览”，只有 Hub 沙箱里的重跑算数；
  - 暂缓的待定项“人工接管受管会话的通道、块语言编辑界面、本地工具的下发”：等第一个需要它的工作流，case-compile 2.x 就是；
  - D06 R[1]：Circle 只做 6 项通用 MCP 改进，不出现 Hub 专用界面；
  - T02 R[5]、R[6] 和 B04 R[2]：按包分配，只授已发布、未下架的版本；下架后新运行不能用那一版；
  - R02 R[1]：无权和不存在同形；
  - `contracts/model.json` 的 `formatProposals.packFiles`：`tools/` 是“本地工具，下发方式待定”。
- 现状：
  - `contracts/generated/protocol.ts` 的 `PACK_FILE_PATHS` 允许 `tools/`。发布时它和别的文件一样存成内容寻址对象（`hub/runs/packs/README.md` 发布第 5 步），但没有任何检查，也没有出口。
  - case-compile 在 hub-case-workbook 分支上把源码目录 `scripts/` 原字节发布成 `tools/`（`packs/workflow/case-compile/pack-files.ts`）。它的 SKILL.md 写的是集成者按 `pack.json` 的摘要手工安装 `tools/`、`functions/`、`tables/` 和 `requirements.json`，工具按相对路径导入这些文件，只用 Node 内置模块。
  - `hub/ports.ts` 的 `WorkflowStore.forUser`：给出用户能用的版本（不存在、没分配、已下架都是同一个 null），带 `manifest` 和核过的只读目录 `pack.directory`。包号是清单的 RFC 8785 规范 JSON 的 SHA-256，规范的清单字节本身也存成对象（`hub/runs/packs/README.md` 发布第 2、5 步）。
  - `hub/server/app.ts` 的路由只有 `/mcp`、`/healthz` 和 `/console/**`；`hub/server/mcp.ts` 每次请求用 `records.principals.authenticate` 核 Bearer 令牌；`hub/server/assemble/secret-input.ts` 的 `readSecret` 从标准输入读密钥。
  - Circle 的 MCP 客户端（hub-mcp-client 分支）不处理 MCP 资源，所以下发不走 MCP，也不加工具。

- 分支和工作树：`local-tools`，目录 `circle-hub-local-tools`，从 hub-redesign 开，第一步现在就能开始；第二步等 kb-candidates 和 views-and-notes 合并以后，集成者通知。
- 可以改的路径：
  - 第一步：`hub/server/local-tools.ts`（新，下载出口）、`hub/server/cli-local-tools.ts`（新，安装和核对命令）和它们的测试；`hub/server/app.ts` 路由里加一处；`hub/server/cli.ts` 的内置命令表（`BUILT_IN`、`BUILT_IN_HANDLERS`）和用法加 `local-tools`；`hub/runs/packs/validate.ts`、`hub/runs/packs/imports.ts` 里 `tools/` 的发布检查和测试；`hub/server/README.md`、`hub/runs/packs/README.md` 末尾各加一节（console-results 也在改 server 的 README，合并排在它后面）。core-fixes 也改 `cli.ts` 的同几行（在 `BUILT_IN` 旁边加 `RESERVED_COMMAND_DESCRIPTIONS`，改写用法），review-output 带着它：集成者先合并 core-fixes，local-tools 再在合并后的主线上对齐 `cli.ts`。
  - 第二步：`contracts/src/run.ts` 的 `PackSummary`（跑 `npm run gen:contracts`，生成物一起交）；`hub/runs/packs/ports.ts` 的 `packSummary`；`hub/server/text.ts` 里 list_task_packs 和 start_run 的那两段。
  - 不改：`packs/**`（case-compile 改用这个命令由改它的分支做）、`contracts/model.json`、`hub/server/tools.ts`、`hub/server/fakes.ts`（console-results 在改，测试里自己搭桩）、`hub/server/cli-admin.ts`（hub-job-dispatch 和 plan-evidence 在改）。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - Hub 只核验，不生成内容、不调用模型：下发的是包作者发布的原字节，不改写，不重新打包；
  - 核心是通用的：核心代码只认 `tools/` 和清单，不出现任何包名、脚本名和产品的字；
  - 未知只能是过渡状态，写明缺的事实和下一步；
  - 枚举只来自生成的词表；
  - 令牌只从标准输入读，不进命令行参数，从不打印。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 'hub/server/**/*.test.ts' 'hub/runs/packs/**/*.test.ts'`。第二步再加 `node tools/gen-contracts.ts --check` 和 `node --test 'contracts/**/*.test.ts'`。

## 第一步

1. **发布时检查 `tools/`。**
   - `tools/` 下每个代码文件（`.ts`、`.mts`、`.js`、`.mjs`）照 `scanFunctions` 的静态扫描：ES 模块，Node 能去掉类型；只许导入包内文件和 Node 内置模块；任何包都不许，客户端没有 Hub 的 `node_modules`。
   - 内置模块不限（本地工具要读写文件），这一点和沙箱的政策（`SANDBOX_IMPORT_POLICY`）不同，README 写明。不查导出：工具是脚本，不是包内函数。
   - 不过就不发布；问题的 rule 用 `tools.*`，写明文件、行和改法。
   - 测试：只导入内置模块和包内文件的通过；导入 `zod` 被拒；导入包外的相对路径被拒；CommonJS 写法被拒；没有 `tools/` 的包照旧，现有的发布测试照过。

2. **下载出口**（`hub/server/local-tools.ts`，`app.ts` 加 `/local-tools/` 前缀的路由）。
   - `GET /local-tools/<包>@<版本>`：这个版本清单的规范 JSON 字节，它的 SHA-256 就是包号。
   - `GET /local-tools/<包>@<版本>/<路径>`：清单里那个文件的原字节。清单里的任何文件都能取，因为工具按相对路径导入 `functions/`、`tables/` 这些；包本来就对分到它的用户可见（架构第 5 节）。
   - 两种回答都带 `Content-Digest: sha-256=:<base64>:`（RFC 9530）和 `ETag`。回答之前重算一遍 SHA-256，和清单不等就答 500、不给字节，管理员日志写“存储被改动过”。
   - 只答 `WorkflowStore.forUser` 给得出的版本，而且它的清单里至少有一个 `tools/` 文件。不存在、没分配、已下架、没有本地工具、清单外的路径、`..` 和编码过的斜杠，答案字节完全相同（R02 R[1]），真实原因只在管理员日志里。
   - 每次请求核 Bearer 令牌（和 `/mcp` 同一个 `authenticate`，没有或失效是同一个 401）；只收 GET 和 HEAD；Host 和 Origin 照 `app.ts` 已有的检查；每次请求记一行调用日志，工具一栏写这个出口的名字，参数只记包号和路径的摘要与长度。
   - 测试：分到包的用户取清单，字节的 SHA-256 等于包号；取文件，字节和清单的 SHA-256 相同；没分配、已下架、不存在、没有 `tools/`、清单外路径、`..`、编码过的斜杠，七种答案逐字节相同；没有令牌和撤销了的令牌都是 401；存储里的文件改一个字节，答 500、不给字节；HEAD 没有正文；POST 是 405；调用日志里没有文件内容。

3. **安装和核对命令**（`hub/server/cli-local-tools.ts`，在客户端那台机器上跑）。
   - `circle-hub local-tools install <包>@<版本> --digest <包号> --into <目录> [--hub <地址>]`：令牌用 `readSecret` 从标准输入读。地址默认 `http://127.0.0.1:<CIRCLE_HUB_PORT>`，只许回环，和 Hub 的监听一致。
   - 先取清单，它的 SHA-256 必须等于 `--digest`（包号从控制台的任务包页，或运行摘要的 `pack_digest` 抄）；再逐个取清单里的文件，大小和 SHA-256 都要对上。
   - 先写进同级的临时目录，全部对上才改名成 `<目录>/<包>@<版本>/`，清单字节存成里面的 `pack.json`；有一个不对就整份删掉，什么也不留。
   - 目标已存在：内容和清单一致，答“已安装”，退出码 0；不一致就拒绝，不覆盖。
   - `circle-hub local-tools verify <目录> --digest <包号>`：`--digest` 必填。先比目录里 `pack.json` 的 SHA-256 和 `--digest`，不等就失败；再按 `pack.json` 重算每个文件的 SHA-256，列出多出来的文件；只读，不联网。只按目录自己的 pack.json 重算的话，连 pack.json 带文件一起改过的一份也能过，所以要和 Hub 发布的包号比。集成者这一轮手工放的那一份也用它核，hub-device-run 第 11 条也靠它。
   - 输出只有包号、版本、文件数、字节数和第一处不符的路径，从不打印令牌和文件内容。
   - 测试（对第 2 条的测试服务器跑）：正确安装；`--digest` 不对，什么也不写；服务器给的某个文件被改，整份不留；目标已存在且相同，答“已安装”；存在但不同，拒绝；非回环地址被拒；令牌不出现在标准输出和标准错误里；`verify` 查出改过的一个字节和多出来的文件；pack.json 和文件一起改过、彼此对得上的一份，`verify --digest` 也查得出；不给 `--digest` 被拒。

4. **README**：两个包的 README 末尾写这一节：下发是什么、不是什么。它不是 MCP 工具，Circle 里没有它的界面；装在客户端的工具跑出来的只作预览，Hub 的重算算数（T01 R[0]）。

## 第二步（kb-candidates 和 views-and-notes 合并以后，集成者通知）

5. `list_task_packs` 的每个包加 `digest`（包号）；带 `tools/` 的包另列本地工具的路径和 SHA-256；回答文字写一行给人看的安装命令（不带令牌）。`start_run` 的回答文字在包带本地工具时同样写这一行，运行摘要里本来就有 `pack_digest`，照 T01 R[1]“规程随 start_run 下发、带摘要”的写法。
   - 测试：工具输出照 `contracts/generated/tools.json` 校验；没有 `tools/` 的包没有这一段；文字在预算内。

## 集成者改的（终端不改）

- 模型：T01 F[9] 和 R[1] 写下下发方式（只读下载出口，客户端按包号核对后安装）；待定项那一条拆出“本地工具的下发”，标已定（决定 35 第 12 问），另外两件照旧暂缓；`formatProposals.packFiles` 里 `tools/` 的说明。
- 待定项的条数一变，`docs/design/generic-model.md`、它的英文版和 `docs/hub-r4-progress.md` 里的“几项待定、几项已定、几项暂缓”要跟着改，`npm run test:docs` 会查。
- case-compile 的 SKILL.md 改用 `circle-hub local-tools install`：由改 case-compile 的分支做。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
