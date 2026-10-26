# 任务：计划第 12、13 步缺的证据：凭据导入、钥匙丢失演练、PLM 构建存在核对、连接器只读冒烟

依据：

- 终审（`docs/hub-r4-progress.md` 211–212 行）：第 12 步的演练没有记录，`circle-hub secrets import` 没有实现，现在只有 `secret set`（`hub/server/cli-admin.ts` 50 行）；第 13 步 PLM 的构建存在核对没有实现，`plm:builds` 声明了（`packs/system/plm/system.json` 127 行）却没有包读它；各连接器的只读冒烟没有记录。
- 简报“怎么验证”（`docs/hub-r4-brief.md` 72–73 行）：在另一个数据目录里演练备份与恢复，包括钥匙串里的钥匙丢失后重新导入；切换失败回到上一个部署；重启后自动恢复；只监听本机；每个连接器一次只读冒烟，日志里只有条数和摘要。
- 所有者批准的计划（不在仓库里，集成者转述）：导入只读环境配置文件里点名的键，只显示键名、有没有和长度，解析出错也不回显值；PLM 的“版本”就是构建，没有发布标记，只用来核对构建存在，记找到、没有或不唯一，从不挡评审；发布状态来自构建站。
- 之后的决定：Hub 没有模型密钥（决定 15，进度 258 行）；SVN 账号存进 Hub 的密钥库（决定 28，进度 296 行）。
- 分层：平台不导入 records（`hub/platform/README.md` 176 行）。所以钥匙丢失分两半：钥匙串和备份那一半进 `rehearse.ts`，密钥库和重新导入那一半写成 server 一侧的测试。

- 分支和工作树：`plan-evidence`，目录 `circle-hub-plan-evidence`（依赖已装好）
- 可以改的路径：`hub/server/cli-admin.ts`；`hub/server/assemble/` 下的新文件 `env-file.ts`、`vault.ts` 的提示、`cli-admin.test.ts`、README（提示改了以后跟着变的断言照改）；`hub/platform/rehearse.ts`、`rehearse.test.ts`、`cli.ts` 里 `rehearse` 的输出、`README.md`；`packs/system/plm/**`（gold-trace 第 5 条也改这个包，先后和版本号由集成者定）；`packs/workflow/case-review/**`（`packs.test.ts` 除外；core-fixes 还改了这个包的 `pack.json`、`README.md`、`functions/expected-sources.ts`，加了生成的词表，第 5 条等它合并以后在它之上做）；新文件 `scripts/real/gold/plm-build.ts`、`scripts/real/smoke-connectors.ts` 和它们的测试；`tests/acceptance/` 里因为多了一个要求项而变的断言。`contracts/`、`hub/runs/engine/`、`hub/rules/`、`hub/connectors/`、`packs/product/famx/` 不动，缺什么先回报。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。每条一个提交。要用钥匙串的地方只用临时钥匙串文件（建法照 `hub/platform/keychain.test.ts` 489–496 行），服务名用一次性的，不用部署的 `circle-hub`；每个 `security` 调用都要点名这个文件（照 `hub/platform/test-support.ts` 33 行的 guard）；不经平台的 `key` 命令（它用默认钥匙串）。合成构建名用 10.6 以后的版本线，地址用 192.0.2.0/24。取值只用 `contracts/generated` 的类型，包函数里用 `import type`；运行时要整组取值的，照 core-fixes 给包生成 `functions/generated/vocabulary.ts` 的办法（它合并以后；登记要改 `tools/gen-contracts.ts`，先回报）。
- 验证：`npx tsc --noEmit`；`node packs/workflow/case-review/packaging.ts check plm case-review`；`node --test --test-concurrency=1` 对 `hub/server/assemble/*.test.ts`、`hub/platform/rehearse.test.ts`、`hub/platform/cli.test.ts`、`packs/system/plm/**/*.test.ts`、`packs/workflow/case-review*/**/*.test.ts`、`scripts/real/**/*.test.ts`；`npm run test:acceptance`。

## 要做的

1. **`secret import`**（加在 `hub/server/cli-admin.ts` 637 行的 `secret` 组里；计划写作 `secrets import`，不另开复数命令组，README 写明这个对应）：
   ```
   circle-hub secret import --env-file <文件> --key <键名>=<资源>/<凭据项> … [--basic <用户键>:<密码键>=<资源>/<凭据项>] [--dry-run]
   ```
   - 先要管理员令牌和密钥库主密钥（`--dry-run` 不要主密钥），再照 `secret set` 核对每个目标（646–651 行）：资源和凭据项都在；同一个凭据项不能写两次；同一个键可以写进几个资源（门户账号同时给敏捷平台和 PLM）。这些都过了才读文件。
   - 读文件放新文件 `hub/server/assemble/env-file.ts`，格式照 `scripts/real/lib/env-file.ts` 14–15 行（`KEY = value`、`#` 注释、节标记）：只认没有注释的行，只留点名的键的值，别的行读过就丢。不是普通文件、超过 64 KiB、不是 UTF-8、含 NUL、点名的键出现在两行，都整份拒绝；错误只写键名和行号，不写路径和行内容。
   - 每个键一行：`<键名>：找到，长度 <n>` 或 `<键名>：没有`。有一个没有就一个都不写，退出 1。都找到时按资源分组调 `hub.connectors.admin.setCredentials`（`hub/connectors/connectors.ts` 71 行：先核对全部值，最后清一次登录状态），每个凭据项一行，照 `secret set` 的说法写按什么规则存。
   - `--basic` 存 `Basic base64(用户:密码)`：openkm 和 svn 的 `authorization` 要整个头值；用户名里有冒号就拒绝。`--dry-run` 只核对，只报有没有和长度，不写。
   - 值、值的片段和摘要都不显示。
   - 测试（`hub/server/assemble/cli-admin.test.ts`，合成环境文件，断言抓到的输出；照 43–44、56–60 行把文件里所有的值都加进扫描）：
     - 正例：两个键写进一个合成资源，密码按规则存成摘要，经桩服务读一次成功；一个键写进两个资源；`--basic` 的头值；`--dry-run` 什么都不写。
     - 反例：键不在文件里或只在注释行；资源或凭据项不存在、没有令牌、不是管理员、没有主密钥（都不读文件）；同一凭据项两次；文件里别的键的值不出现在输出、密钥库和日志行里；坏文件（非 UTF-8、NUL、同名两行、超大）的错误里没有任何值的片段。

2. **演练里的钥匙丢失：钥匙串和备份那一半**（`hub/platform/rehearse.ts` 232 行起）。没有 `/usr/bin/security` 时这一段在报告和输出里写“跳过，不算通过”，其余照旧。
   - 演练数据根里建临时钥匙串文件，用一次性服务名写两个项：密钥库主密钥和操作令牌（32 字节随机值），写在核对前的文件摘要之前。所有 `security` 调用经一个只放行这个文件的包装；不读部署设置。
   - 备份以后（259 行）：备份目录里每个文件都查两个项的值（十六进制大小写两种写法，和原始 32 字节），每处命中记一条不一致，说明里不写值。
   - 销毁时（262–265 行）两个项一起删掉，这就是钥匙丢失。恢复后的核对（278–286 行）之后：两个项都不在；照第 3 条的步骤把恢复回来的 `vault/` 移到 `set-aside/<时间>-key-loss/`，新建密钥库主密钥。
   - 不论成败、加不加 `--keep`，`finally` 里都删掉临时钥匙串文件。
   - 报告多一段：项数、备份里的命中数、丢失后还在的项数、移开的密钥库文件数，或者跳过的原因；`hub/platform/cli.ts` 344 行一带多打一行，只有这些数。README 第 10 条（231 行）照改。
   - 测试（`rehearse.test.ts`，没有 libpq 或 `security` 就跳过并写原因）：正常一次，命中 0，丢失后 0 个项在，每个 `security` 调用都点名根里的临时文件；反例：传进去的执行器把写入的值抄进根的 `vault/`，备份命中至少 1 处，报告不通过，说明里没有值；`security` 指向不存在的路径（选项可以给），这一段记跳过，其余照常通过。

3. **钥匙丢失以后重新导入：密钥库那一半**（`cli-admin.test.ts` 新的 describe；同一个场景跑两遍：钥匙在文件里，各平台都跑；钥匙在临时钥匙串文件里，只在 macOS 跑，别处跳过并写原因）。
   - 建管理员，发布合成的敏捷平台包，加资源，`secret import`，经桩服务读一次成功（登录 1 次）。
   - 丢掉钥匙：删钥匙文件，或删临时钥匙串里的两个项。钥匙串那遍改变状态的命令先因为没有操作令牌被拒，提示 `operator-token reissue`；reissue 以后，两遍里要用密钥库的命令都被拒，提示照 `hub/server/assemble/vault.ts` 11 行，环境文件没被读；`resource list` 照常列出。
   - 恢复：把 `<数据目录>/vault`（`hub/records/index.ts` 63 行）移到 `<数据目录>/set-aside/`，新建钥匙，再 `secret import`；读一次成功（登录 2 次），密钥库里是重新导入的值。钥匙串的 provider 按进程缓存钥匙（`hub/platform/keychain.ts` 201 行），每次运行新建一个。
   - 这套步骤写进 `hub/platform/README.md` 292 行一带和 `hub/server/assemble/README.md` 的 Secrets 一段（117 行）：停服务、移开 `vault/`、`key init`、`operator-token reissue`、`secret import`、起服务。`vault.ts` 11 行的提示加一句：找不回原来的钥匙串项时照这套步骤。

4. **PLM 系统包按名字读构建列表**（`packs/system/plm/system.json` 125–131 行）。
   - `plm:builds` 的键多一种写法：这条线的各个名字，各自 URI 编码后用 `+` 连接。改成规划函数（`functions/plm.ts` 加 `buildsPlan`、`buildsProject`，`max_requests: 2`）：数字键照旧只读这个产品的构建列表；名字键先读产品列表，产品名整串先 NFKC（全角 `／` 也就成了 `/`），再按 `/` 拆开，每段去首尾空白、转小写，含有每个名字的产品正好一个，才读它的构建列表，没有或不止一个就不读。依据：这条线的产品记录名字里列出两族名字（`docs/hub-r4-architecture.md` 156 行；合成桩照这样写，`hub/connectors/testing/plm.ts` 19 行）。
   - content：`{ product: {id, name} | null, product_resolution, builds: [{ name }] }`。`product_resolution` 用词表轴 `resolution` 的值（`contracts/generated/vocabulary.ts` 12 行：已解析、有歧义、未解析）；构建名取每项的 `name`（合成夹具的形状，`tests/fixtures/plm/index.ts` 43–49 行）。
   - 升小版本（gold-trace 第 5 条也升这个包，版本号接在先合并的那件后面），改 README，`node packs/workflow/case-review/packaging.ts sign plm`。
   - 测试（`plm.test.ts`，合成应答写在测试里，不改 `tests/fixtures/plm` 现有的值）：数字键；名字解析到一个产品；一个也没有；两个产品都列出这些名字；构建列表为空。

5. **case-review 的 PLM 构建核对**（等 core-fixes 合并以后，在它之上做）。
   - 期望来源（`functions/expected.ts` 42 行一带）：运行有锁定构建、有产品名时加一条 `plm:builds:<名字>+<名字>`，角色 expected，理由写“核对锁定构建在 PLM 里有没有；只作记录，不挡评审，不作评审的根据”。
   - 新要求项 `plm_build`：target run，fact，static，`required: false`（`contracts/src/pack.ts` 145 行：只有门禁型运行要求必需项满足），bookkeeping。新检查 `plm_build`：包内函数，`reads: { roles: ["expected"], types: ["plm:builds"] }`（照 `packs/workflow/traceability/checks.json` 9 行），applies run，subject 只取 `context.build`，judges expected（先例 `packs/workflow/case-review-report/checks.json` 12 行），tier advisory。
   - 判定：构建列表里和锁定构建同名（NFKC、去首尾空白后逐字相等）的条数。1 条支持；0 条反驳 `case-review.plm_build_none`；多于 1 条反驳 `case-review.plm_build_not_unique`；data 写 `resolution`（同上的轴）和条数，根据是那份来源的 `src:` 引用。没有锁定构建、PLM 没绑上或在 `unread_sources` 里、产品没解析出来，都记未知（缺输入），说明写是哪一种。不提发布状态。
   - 码写进 `tables/codes.json`；样例：正例找到，反例没有、不唯一（`testing/samples.ts write`）；SKILL.md 加一句：这一项 Hub 自己核对，模型不填，PLM 构建列表不是评审证据；README 写明这条记录要到第一次提交以后才有（评审包不在 start_run 时算事实）；升小版本，接在 core-fixes 的 1.0.4 后面；`packaging.ts sign case-review`。
   - 测试：检查函数和期望来源，上面每种情形一例；用 `hub/server/testing-real.ts`（真实的包和引擎、PLM 桩、临时 PostgreSQL）跑一次评审，提交以后这个要求项的结论和合成答案一致；`tests/acceptance` 里因为多了一个要求项变的断言照实改，不放宽。
   - `packs.test.ts` 不改，它的发布检查（55 行：每个检查都要有正例和反例）和词表扫描（98 行）要照样通过。引擎要是在评审运行里不给运行级事实要求项结论，停下回报，不改 `hub/runs/engine`。

6. **独立答案 `scripts/real/gold/plm-build.ts`**（集成者跑）。
   - `--products <产品列表原件> --builds <构建列表原件> --names <名字>+<名字> --build <构建名> [--hub <run show 的 JSON>]`：自己解析两份原始 JSON（产品列表带信封，构建列表是数组），按第 4、5 条写的规则自己数，得出产品的解析状态和同名条数；给了 `--hub` 就和这个要求项的 data 比。
   - 独立性：不导入 `packs/` 和 `hub/`；取值用 `contracts/generated/vocabulary.ts` 的 `RESOLUTION`，那只是封闭的取值集。
   - 屏幕上只有解析状态、条数和一致或不一致，不出现名字、构建名和产品。
   - 测试：合成原件三种情形各一例，加一个和 Hub 不一致的反例。

7. **`resource read`**（`hub/server/cli-admin.ts` 48 行的 `resource` 组）：`circle-hub resource read <资源> <读取名> <键>`。
   - 读会存原件和读清单，所以要管理员令牌；调 `hub.connectors.executeRead`（`connectors.ts` 92 行），目的写“管理员冒烟读取”。
   - 只打印：系统包和读取名、完成或失败的码、每个产物的名字、sha256 和字节数、读清单的摘要。不打印键、内容、meta 和失败原因（原因在读清单和管理员记录里）。
   - 测试（合成桩）：成功的一次，输出里没有桩应答的任何文字，也没有键；失败的一次（404、登录失败）只有码；非管理员、没有的资源、没声明的读取名被拒。

8. **冒烟脚本 `scripts/real/smoke-connectors.ts`**（集成者跑）。
   - `--logs <部署的 logs 目录> --read <资源>:<读取名>:<键>`，每个系统一条，可以重复；键是真实数据，只在运行时给。
   - 每条：记下开始时间和 `hub.out.log`、`hub.err.log` 的长度；子进程跑 `node bin/circle-hub resource read …`；结束后跑 `node bin/circle-hub logs export --from <开始> --to <结束>`（调法照 `scripts/real/review-circle.ts` 149 行），再读出两个服务日志新增的部分；这次的产物用 `original export` 导进一个 0700 的临时目录，用完就删。
   - 核对：从原件取出应答文字（JSON 的每个字符串值，文本按标签和换行切开的段；至少 8 个字符；去掉 64 位十六进制和请求的键里就有的串），在命令输出、调用日志和服务日志三处查，原样和 JSON 转义两种写法都查。读取完成、命中 0 才算通过。
   - 每条只打一行：`<系统包>/<读取名>：读取完成|失败（码），产物 n 个共 m 字节，命令输出 a 行、调用日志 b 行、服务日志 c 行，命中 h：通过|不通过`；命中只报条数和在哪一处，不报文字。全部通过才退出 0。
   - 测试（跑命令的函数换成假的，不起真实 CLI）：JSON 和 HTML 应答取文字；命中的正例和反例（原样、转义；请求的键回显不算）；整段输出里没有合成应答的文字和键。

## 集成者之后跑

合并、发布、部署以后，在这台 Mac 上做，结果记进进度（只记计数和一致与否，不记路径）：

1. 导入凭据（部署的 Hub），先加 `--dry-run` 跑一遍：
   ```
   circle-hub secret import --env-file <环境配置文件> --key <门户账号键>=<敏捷平台资源>/username --key <门户密码键>=<敏捷平台资源>/password --key <门户账号键>=<PLM 资源>/username --key <门户密码键>=<PLM 资源>/password --basic <SVN 账号键>:<SVN 密码键>=<SVN 资源>/authorization
   ```
   屏幕上只有键名、找到或没有、长度和写入行。不导入模型密钥。
2. 第 12 步演练（演练数据根、本机回环）：
   - `circle-hub rehearse`：行数、对象、权限和钥匙串那一行，核对一致；演练根的路径不记；
   - `node --test --test-concurrency=1 hub/server/assemble/cli-admin.test.ts`：钥匙丢失两遍都通过，macOS 上跳过 0；
   - `node --test --test-concurrency=1 hub/platform/deploy-system.test.ts hub/platform/service.test.ts hub/platform/lifecycle.test.ts hub/config/config.test.ts tests/acceptance/17-hub-restart.test.ts`：切换失败回滚（`deploy-system.test.ts` 188 行）、重启恢复（`service.test.ts` 17 行、场景 17）、只监听本机（数据库只有本机套接字，`lifecycle.test.ts` 54 行；Hub 只收回环地址，`config.test.ts` 125 行），记计数。这些测试里 launchctl 是假的：服务标签固定（`hub/platform/settings.ts` 35 行），真跑会顶掉在用的服务，记录里照写；
   - 部署的 Hub 只读看一眼监听（`lsof -nP -iTCP -sTCP:LISTEN` 里 Hub 进程那几行）：只有 127.0.0.1，只记地址和端口。
3. PLM 构建核对：发布 plm 和 case-review 的新版本，`circle-hub resource update <PLM 资源> --system-pack plm`；用所有者选的构建经真实客户端开一次评审、提交一次（第 15 步：`HUB_REAL_TOKEN=<令牌> node scripts/real/review-circle.ts --endpoint-from circle --prompt <评审提示> --out <目录> --name <标签>`，运行号取 `<标签>.calls.jsonl` 里 `start_run` 那一行），`run show <运行> --json` 存到 Git 之外；`resource read <PLM 资源> products all` 和 `resource read <PLM 资源> builds <名字>+<名字>`，两份原件用 `original export` 导出；然后：
   ```
   node scripts/real/gold/plm-build.ts --products <文件> --builds <文件> --names <名字>+<名字> --build <构建名> --hub <run show 的 JSON>
   ```
   屏幕上只有解析状态、条数和一致或不一致。
4. 冒烟，每个系统一条（敏捷平台、PLM、构建站、手册库、文档库、SVN）；PLM 用 `products:all`，构建站用 `listing:index`，其余挑一个便宜的读：
   ```
   node scripts/real/smoke-connectors.ts --logs <部署的 logs 目录> --read <资源>:<读取名>:<键> [--read …]
   ```
   每个系统一行通过或不通过。

完成后在终端里回报：提交号、测试数量、macOS 上跳过的测试（应为 0）和 Linux 上会跳过的、第 5 条引擎给没给运行级事实要求项的结论、没做完或拿不准的地方。

## 分两步做（集成者 2026-10-23）

- 现在做：`secret import`、部署演练里钥匙丢失的情形、连接器只读冒烟脚本。
- 后做：PLM 构建存在核对（要改 `packs/system/plm/**`）。另一个终端（story-trace）正在改这个包，等它合并以后再做这一条；在那之前不动 `packs/system/plm/**` 和评审包里这一条的改动。

## 集成者对待定问题的答复（2026-10-23）

1. 用现有的 `secret` 组：`secret import`，不另开 `secrets` 组，也不加别名。进度页记下和计划写法的差别。
2. 要 `--basic`：环境文件里 SVN 的账号和密码是分开存的（决定 28），由它拼成整个 Basic 头值存进密钥库，不显示任何值。
3. PLM 里这条线的产品先按名字找；集成者冒烟以后看真实产品名，不对就改成在 PLM 资源设置里写产品编号。
4. 构建名的字段由集成者冒烟后确认。
5. “没有”和“不唯一”记成提示档的反驳，不挡评审，照页面。
6. 核对放在评审包，核的是评审运行锁定的构建，照页面。
7. 重新导入那一半写成服务端测试，照页面。另外做：`key init` 遇到非空的 `vault/` 就拒绝，并给出把它移开的选项。
8. 真实服务上的切换失败回滚和重启恢复，由集成者放在下一次部署时演练。
9. 冒烟改为核对命令输出（连接器事件）和服务日志，照页面。

## 第 44 项注：hub-variables 第一步合并以后的做法

这一件照现在的写，到时由 hub-variables 第 3 条改：

- 第 1 条的 `secret import` 改成写到名字：`--key <键名>=<密钥名>`、`--basic <用户键>:<密码键>=<密钥名>`，加 `--digest <密钥名>=sha512_base64`、`--short <密钥名>` 和必填的 `--reason`；“一个键写进两个资源”改成“两个资源引用同一个密钥”；`--basic` 的核对改成核引用这个名字的各凭据项。
- 第 3 条的恢复步骤里，`secret import` 照到时的写法；导入之前 `secret list` 写“登记了第 n 版，密钥库里没有它的条目”。
- “集成者之后跑”第 1 条：hub-variables 第一步部署以前照现在的命令；部署以后先 `resource update <资源> --credential <凭据项>=<名字>` 迁移原值，以后再导入就写进 `PORTAL_USERNAME`、`PORTAL_PASSWORD`（`--digest PORTAL_PASSWORD=sha512_base64`）、`SVN_AUTHORIZATION` 这些名字。
