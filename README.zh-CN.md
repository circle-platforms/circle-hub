<h1 align="center">circle-hub</h1>

<p align="center">Circle 的团队 hub：共享的知识、持久的任务、受治理的执行和有版本的方法，给要碰真实系统的 agent。</p>

<p align="center">
  <a href="https://circle-platforms.github.io/circle-hub/">文档</a> ·
  <a href="docs/design/README.md">设计</a> ·
  <a href="docs/compatibility.md">兼容矩阵</a> ·
  <a href="CHANGELOG.md">更新日志</a> ·
  <a href="README.md">English</a>
</p>

---

[Circle](https://github.com/circle-platforms/circle) 的团队 hub：一个团队跑一个常驻进程，让大家的 Circle 共用一套资料、任务、执行资源和方法，并让碰真实系统的 agent 始终在人批准过的规则里运行。

Circle 保持通用 harness 的身份。circle-hub 是对它的增强：Circle 登录 hub 后，原有菜单里多出 hub 的条目（工作、技能、工具、审批、资料、资源）。管理员就是在某个范围里持有管理员角色的 Circle 用户，没有第二个管理程序。

## 为什么要 hub

让 agent 碰真实系统（设备、测试床、文档库、工单系统）的团队都会遇到同样五件事：

1. 资料散在个人笔记里，没有共享、有版本、经审阅的来源。
2. 工作随聊天窗口一起消失，断线和重启都接不上。
3. 唯一的人工闸是 agent 自己进程弹出的许可提示。
4. 凭据和地址最后都进了提示词、配置和日志。
5. 技能靠复制传播，没人知道它调了什么、谁批过。

circle-hub 用四个对象分别回答这五件事，并把 agent 的运行时（Circle）和约束它的东西分开。

## 四个对象，一套标准

| 对象 | 拥有 | 例子 |
|---|---|---|
| **B · 资料** | 来源修订、证据、声明、快照、制品 | 文档库、构建站点、工单镜像的只读连接器；带 role 的上传原件 |
| **C · 工作** | 身份、范围、任务、输入修订、审批请求、决定、审计、bot | PostgreSQL 持久任务；审批绑定输入修订、目标身份和动作摘要 |
| **D · 执行** | 资源、操作、租约、现场、未知结果 | worker 调用 MCP 网关，凭据从只写保险箱注入 |
| **E · 方法** | 技能包、产品线模块、规则、流程版本 | 带试跑记录的技能包；hub 在派发前重跑的确定性规则 |

每个对象都由同样五样组成——记录、资产、审批策略、证据、扩展点——所以 Circle 里每个登记簿页面同一个形状，每条产品线用同一种方式插进来。三条规则处处成立：

- **一切可插的东西都是资产**：kind · version · sha256 · declaration · configuration · lifecycle（draft → 独立审批人批准 → running → retired）。
- **审批发生在变更时，不在运行时。** 运行走执行链——权限、绑定、核验、租约、审计——结果只有通过、带事实的固定错误码、如实披露的未知。平台不是审批人。
- **证据归 hub。** 工具返回原样保存并给 evidenceId，agent 只拿指针；脚本事实和模型判断分开标记。

完整设计见 [docs/design](docs/design/README.md)。

## 现在能做什么

- 带认证的 HTTP API（`/v1`）、PostgreSQL 持久任务（输入修订、事件流、游标补读）、带优雅重启的监督进程、可选的原生 HTTPS。
- 资产生命周期、只写凭据保险箱、绑定「修订 + 目标身份 + 动作摘要」的独立审批；被取代的申请可以关闭。
- 只读连接器（WebDAV 文档、构建站点、工单系统镜像、环境视图），每个来源限并发限间隔、原件钉 SHA、按身份缓存；按身份计算的工具目录。
- 两类知识记录——脚本抽取的产品事实、经审阅的对话候选——不可变快照与异步入库。
- 上传原件（带 role 和声明元数据的文件）批准后给出稳定的来源 id，所有命令工具可绑定它。
- 从 Circle 推送的技能包：带试跑记录，核对声明工具，由另一个人批准，由无界面的 Circle 执行；定时与事件 bot。
- 服务客户端、`/token`、RFC 7662 `/v1/introspect`、worker 的短期操作令牌；通过 MCP 网关执行，派发前由 hub 重核每条设备命令。
- 从 packs 仓库安装模块（`modules.json`）：冻结字节、作为普通资产提交，不自动批准。

验收套件（contracts、methods、acceptance、references）全部跑在合成来源和临时 PostgreSQL 上；真实来源的观察单独记在 [docs](docs/README.md) 里。

## 正在做

当前简报是 [docs/server-s2-brief-r3.md](docs/server-s2-brief-r3.md)：按范围的角色（管理员 / 成员 / 访客）与两人规则、作为唯一审批概念的变更集、带固定错误码和 `waitingReason` 的执行链、通知流与工作队列、执行资源的静态密钥凭据模式、分页的登记簿查询。Hub 可执行入口与配置只使用 `circle-hub`、`CIRCLE_HUB_*`；进程环境中仍有改名前的旧变量时拒绝启动（见 [CHANGELOG](CHANGELOG.md)）。Circle 扩展使用 `hub` 与 `/hub`，旧扩展名与命令不作别名。

## 快速开始

需要 Node.js 24。

```sh
npm ci
npm run dev:stack     # 临时 PostgreSQL + server + worker，只绑定本机，只用合成来源
npm test              # contracts、methods、acceptance、references
npm run typecheck
```

`dev:stack` 会打印本机地址、开发登录方式和一个合成样本；Ctrl+C 清掉临时环境。仓库和测试套件不连任何真实系统；运行时地址、凭据和业务原件都不进 Git。

## 包

技能包和产品线包不属于 hub。它们在自己的仓库里，各自有版本和 SHA，通过 hub 自己的机制装入（推送 → 试跑记录 → 独立审批）。第一个包仓库是 [circle-packs](https://github.com/circle-platforms/circle-packs)；[产品线包典范](docs/design/product-line-pack.md)给出目录布局和每个包都要填的适配单，以一条合成产品线为样例。

## 状态

circle-hub 在开发中，不是受支持的生产发行：登录是开发登录，验收是合成的，只有一个团队端到端用过。部署到任何要紧的地方之前先读 [SECURITY.md](SECURITY.md) 里的支持范围。

## 文档

- [设计](docs/design/README.md)——对象标准、术语与状态、层级与元素、审批与执行链、角色、与 Circle 的集成、产品线包。
- [客户端接口交接](docs/client-api-handoff.md) · [用例执行](docs/case-execution-handoff.md) · [资源身份](docs/resource-identity-handoff.md) · [模块安装](docs/module-installation.md) · [管理命令](docs/admin-cli.md)
- [阶段记录](docs/README.md)——简报、进度与真实来源观察。
- [参考库](references/README.md)——hub 之前的归档平台；冻结、按 SHA 核验、运行时从不导入。

## 参与与安全

参与开发见 [CONTRIBUTING.md](CONTRIBUTING.md)，编程助手见 [AGENTS.md](AGENTS.md)，三个仓库彼此的要求见[兼容矩阵](docs/compatibility.md)。安全问题按 [SECURITY.md](SECURITY.md) 报告。参与的每个人都遵守[行为准则](CODE_OF_CONDUCT.md)。

circle-hub 是三个仓库之一：[circle](https://github.com/circle-platforms/circle) 是 agent，circle-hub 是它登录的 hub，[circle-packs](https://github.com/circle-platforms/circle-packs) 是装在 hub 上的技能包和产品线包。

## 许可

circle-hub 以 [Apache License 2.0](LICENSE) 发布。[NOTICE](NOTICE) 写明著作权人，并保留商标：本开源许可仅授予代码与相关文档的使用权，未经明确书面许可，不授予任何使用 Circle、Circle Hub 或相关商标、Logo 及图标的权利。[docs/design](docs/design/README.md) 里的设计规范按 [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/deed.zh-hans) 授权，引用、借鉴须保留署名并注明原始出处链接。2026-10-13 之前本仓库以 MIT 许可证发布。`foundation/circle` 里冻结的 Circle 源基线保留其 MIT 许可；它、`references/` 里的归档平台和各依赖见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。贡献按 [CONTRIBUTING.md](CONTRIBUTING.md#contributor-terms) 的贡献者条款接受。
