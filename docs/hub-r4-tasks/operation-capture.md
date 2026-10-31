# 任务：Circle 会话操作采集与整合（R5 B4）

来源：所有者 2026-10-27 的 B4 简报；决定 71–73、D06 R[1]、K03 R[7]。只使用合成资源，不改 Circle 仓库，不接触真实密钥库、环境配置、设备或业务系统。

## 接口核对与差异

- 提交走 `knowledge-contribution` 回注运行：`code=assertion`，类型化内容为 `data.feeding` 的 `fed-observation@1`、`fed-procedure@1` 或 `fed-pitfall@1`；根据是同一份本次上传的 `client_captured` 原件。引文逐字，版本只由 Hub 从运行锁定的构建或自动化测试环境在装构建填写。
- **B3 合入缺口**：当前 `UploadFileInput` 没有出处字段，`hub/server/tools.ts` 把所有上传固定为 `declared`，因此客户端无法经 MCP 上传 K03 R[7] 所需原件。本任务最小补充可选 `provenance_type: declared | client_captured`，省略仍为 `declared`，其他出处拒收。它不证明字节未经模型；这类记录仍一律是声明等级。不会把普通上传改标成客户端捕获。
- 选方案 **A**：工具后钩子直接上传，模型不参与采集和上传。独立 Hub 令牌只来自用户配置的 0600 普通文件，不读 Circle 密钥库或环境密钥。方案 B 不采用，避免让模型经手原件上传参数。

## 设计与位置

技能放在 `packs/workflow/knowledge-contribution/tools/operation-capture/`：这是客户端本地工具的既定发布位置，能随回注包签名并独立复制到 Circle `skills/operation-capture/`。核心和生产器不导入它；运行时只用 Node 24 内置模块和 fetch。

1. **默认不采。**用户用技能命令为明确的 `session_id` 开启共享；开关、输出和日志只写该会话的本地状态目录。`disable` 与进行中的采集、上传和整合串行，返回后不再有这些动作。技能 hooks 只在会话加载技能后生效，安装本身不运行。
2. **原件与清单一一对应。**输出文件保存脱敏后的完整 UTF-8 工具输出，不保存摘要冒充原件。清单一行一个结构事件：采集事件含会话、工具、状态、时间、参数摘要、结构化设备/自动化测试环境字段（若存在）、文件大小与 SHA-256；上传事件含对应原件摘要、请求出处和 Hub 引用。每个事件含前序摘要与自身摘要。原子目录锁保护并发追加，文件排他创建；未同步重算链的篡改、缺文件、额外文件和链接都使核验失败。运行必须绑定同字节的本次具体 artifact，不能任选旧记录。
3. **先脱敏再落盘。**沿用 Circle 的 URL userinfo、认证头、闭集密钥名及固定令牌形状替换，再按 Hub `credential-scan@2` 口径检查精确命中并复扫。当前 Hub 令牌也按 Circle 的字面替换规则处理，上传前再检查。无法完整扫描、无法可靠替换、Unicode 不良或超出上限时整条不采，不截断。日志只记结构错误码，不记原文或密钥。
4. **钩子静默直传。**`after_tool` 不写 stdout/stderr，失败只写本地日志并正常退出。HTTPS 以外的端点仅许回环；请求带 `client_captured`、Circle 会话头和追踪头。网络结果未知时不声称未上传；本地保留待传事件供重试。锁记录进程和随机身份，旧 owner 原子隔离后才回收，避免误删新锁；元数据先扫描，追加失败回滚本次新文件或未完整行。`recover` 保全未登记输出和不完整清单尾部，无法证明完整的片段不上传。
5. **整合只交三类。**模型写观察、步骤或教训提案及逐字引文，其他类型拒绝。脚本验证整份清单、上传状态和引文选择器，改一个字即拒绝。产品和构建只用于操作者开独立回注运行；`product/root` 从运行回答取，模型不得提交版本、构建、对象摘要、上传者、运行号或时间。回执追加保存，未受理不称已入层。
6. **限制。**Circle 不给技能钩子注入技能目录，钩子按 Circle 同一套去空白、`~` 展开和 realpath 规则定位安装目录。上传接口只声明客户端出处，不能证明模型从未接触字节。哈希链没有外部信任锚，能重写整个状态目录并重算全部摘要的人可伪造一条自洽链；本任务只保证检出未同步重算的改动。测试只证明合成链路和确定性核验，不证明真实设备结果；没有启动完整 Circle 会话，协议测试直接执行安装后的 `hooks.json`。

## 可改路径

- 本任务页。
- `contracts/src/tools.ts` 及官方生成器产出的 `contracts/generated/**`；`hub/server/{tools.ts,mcp.test.ts,README.md}`；`hub/knowledge/{feeding.ts,contributions.ts,operation-records.test.ts}`（同字节上传必须取运行绑定的 artifact）。
- `packs/workflow/knowledge-contribution/**`；包版本与清单只由 `pack-files.ts` 更新。
- `tests/acceptance/37-operation-capture.test.ts` 新合成端到端场景。
- `package-lock.json` 中该包的实际版本引用（若有）。

其他路径不改。若合入前主线触碰这些文件，先同步、复核设计并重跑规定验证。

## 验证

新增测试覆盖默认关闭、脱敏与不可脱敏、静默、哈希链连续及篡改、并发 2、令牌权限、回环假 Hub 的捕获出处、三类整合、改字拒绝、独立安装与 `--verify-install`。真实临时 PostgreSQL/Hub 验收实际出处、运行绑定、三类回注和逐字拒绝。

完成后跑类型检查、契约生成检查、docs、contracts、hub、packs、acceptance（含 oracle）全量，测试并发不超过 2；扫描整树和提交差异。提交只暂存显式路径，合入只用指定的 `merge-locked.sh`。
