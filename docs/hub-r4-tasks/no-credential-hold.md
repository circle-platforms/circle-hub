# 来源内容不因像凭据而扣留、拒收或送核看（决定 154，issue #194）

来源：所有者 2026-11-11：“#194 全部放开不拦，既然是公开资料就应该让模型去处理，不要给自己加戏”；“关于这个安全问题，最多在 Hub 上增加一个正则字典功能，管理员可配置，当匹配上后自动替换成 ai 能知道是密码或者密钥 *****，如果需要使用，从 circle 直接定制变量就行了”。基线 `origin/main` 812c52b2，分支 `fix/no-credential-hold`。

## 分三步

1. **停掉扣留、拒收和送核看**（本页，本分支）。
2. **管理员可配置的正则字典**：匹配到的内容替换成说明“这是密码或密钥”的占位，模型看得出那里原本是什么。Hub 发出的密钥被应答回显的情况在这一步一起改成遮盖。还没有做。
3. **删掉不再使用的流程**：核看与接受的命令、页面、记录处理，以及模型里只对旧记录适用的规则文字。还没有做。#190、#35、#193 随这一步了结。

## 第一步改了什么

以前，只要内容里有一处看起来像凭据（例如用例里写着设备登录口令、手册里的示例密码、配置样例），就会：

| 入口 | 以前 | 现在 |
|---|---|---|
| 读业务系统的应答 | 只保留，不给包函数和模型；告诉读的人“内容待核看”，给管理员发核看请求 | 照原样交给有权读的人、包函数和模型 |
| `upload_file` 上传 | 不受理，返回 `CREDENTIAL_IN_UPLOAD` | 受理 |
| 写知识空间、记忆、个人同步 | 拒收，返回 `SPACE_CREDENTIALS_DETECTED`、`MEMORY_CREDENTIALS_DETECTED` | 写入 |
| 贡献、投喂 | 拒收或跳过 | 照常处理 |
| `start_run` 的参数 | 拒绝整个调用 | 当作普通参数 |
| 要派发的内容 | 不派发 | 摘要对得上就派发 |

做法：`hub/records/content-scan.ts` 新增“内容扫描” `scanContent`，它不检查任何东西，结论固定为“无命中”，扫描器名写 `credential-scan@4`。上面这些入口原来调用探测器 `scanForCredentials` 的地方改为调用它。因为同一份内容以“最新扫描器的结论”为准，新记录一旦写下，按内容读取就是可读的。

探测器文件 `hub/records/scan.ts` 一个字节也没有改：它被整份复制进一个包的独立工具（`tools/gen-credential-scanner.ts`），而且 Hub 自己的卫生检查还在用它。

## 没有改的

这些不是“内容”，而是 Hub 自己写下或保存的东西，仍然用探测器，不让凭据写进去：

- 调用日志（`hub/records/calllog.ts`）、备注（`findingsNote`）、控制台表单回填（`hub/server/console/form-recovery.ts`）、沙箱诊断（`hub/refs/sandbox-diagnostic.ts`）。
- 变量和资源、执行器配置（`hub/records/variables.ts`、`hub/server/variables.ts`、`hub/connectors/resources.ts`、`hub/dispatch/executors.ts`）：凭据应当存进保管库，由配置引用。
- 放弃任务的理由（`hub/runs/engine/management.ts`）、读取位置的脱敏（`hub/connectors/read.ts`）、凭据申请里的外部标识（`hub/knowledge/requests.ts`）。
- **包文件**（`hub/runs/packs/validate.ts`、`hub/runs/packs/personal.ts`）：包里有像凭据的内容仍然不能发布。包是分发给每个使用者的配置，使用时需要的凭据按所有者的话由客户端变量提供。如果这一处也要放开，改法和上面相同，一行即可。
- **Hub 发出的密钥被应答回显**（模型 B02 R[6]）：仍然只保留。这是 Hub 自己保管库里的值，不是公开资料；第二步改为遮盖。

## 已有记录

记录不改写。此前按 `credential-scan@3` 存下并命中的记录，指名读这条记录时仍是原来的“只保留”；同一内容重新读取或上传，会产生一条可读的新记录，按内容读取随之可读。目前没有任何部署，没有这样的存量数据，所以没有做迁移。

## 模型和协议

- 模型到第 44 版：改写 B02 R[4]，加 `changes44`。模型其他元素里关于普通来源凭据命中的规则（只保留、`possible_credentials`、待核看请求、上传不受理、记忆与知识空间拒收）没有逐条删，R[4] 写明它们只对旧记录适用；第三步删流程时一起删文字。
- 协议码没有增减。`CREDENTIAL_IN_UPLOAD`、`SOURCE_PENDING_REVIEW`、`MEMORY_CREDENTIALS_DETECTED`、`SPACE_CREDENTIALS_DETECTED` 不再由新内容触发，但仍然登记，旧记录和回执里有它们。
- 记录种类、MCP 工具、词表轴、迁移都不变。

## 测试

- 每个入口加了一条说明新行为的测试：记录层收存（上传、连接器应答、非文本字节、明确指定的档位仍然有效）、旧记录重读后可读、个人同步、MCP 上传、记忆和知识空间写入、连接器读取（应答进入包函数、读清单覆盖完整）、`start_run` 参数、派发内容。
- 覆盖旧流程（扣留、核看、接受、撤回、拒收）的测试保留，因为这些代码在第三步之前还在，旧记录还按它们读。这些测试显式打开探测器：`hub/testing/records.ts` 的 `credentialDetectorsFor(t)`（一条测试）、`withCredentialDetectors()`（整份文件，只用于整份都在测旧流程的文件）、`openTestRecords({ detectors: true })`。开关是 `useContentDetectors`，只有测试调用，运行中的 Hub 从不打开它。
- 只给确实依赖探测器的测试打开，其余测试走运行中的 Hub 的默认路径。

## 允许路径

- `contracts/model.json`、`contracts/generated/**`（生成）、`contracts/src/{model-b02-content.test.ts,result-summary.test.ts,model-w04-w10-v07.test.ts,vocab-axes.test.ts}`、`contracts/README.md`
- `hub/records/{content-scan.ts,api.ts,artifacts.ts,personal-sync.ts}` 及其测试，`hub/testing/records.ts`
- `hub/knowledge/{spaces.ts,memory.ts,feeding.ts,feeding-errors.ts,contributions.ts,personal-sync/service.ts}`
- `hub/runs/engine/start.ts`、`hub/dispatch/content.ts`
- 给旧流程测试加开关的测试文件（`hub/**`、`packs/system/plm/opened-build-hub.test.ts`）
- `docs/hub-r4-progress.md`、`docs/compatibility.md`、`docs/compatibility.en.md`、`CHANGELOG.md`、本任务页
