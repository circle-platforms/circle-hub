# Circle Server

Circle 的企业 Agent 服务端，面向网络安全产品的研发、测试、诊断和维护。

普通用户使用 Circle 默认插件库中的连接插件，配置 server 的 IP 或域名并登录。Circle 保留通用 harness；服务端保存产品资料和证据、持续推进任务、管理实际执行资源，并提供版本化的专业方法。管理员和运维使用 server 自己的管理入口。

## 当前已经做了什么

仓库已从 Circle 的公开 TypeScript 主干派生，保留源历史及 upstream，作为独立私有仓库维护。共享基础放在 [foundation/circle](foundation/circle/README.md)，保持源文件原字节；旧客户端的安装、发布和 Pages 工作流随来源保留在子目录，不作为 server 的工作流启用。

之前 infosec-platform 的代码、契约、测试、样本、研究脚本和原型已经归入[参考库](references/README.md)。参考原件保留完整目录关系，按职责提供入口，并登记来源提交、Git blob 和 SHA-256。这里的代码没有接入新的生产运行路径。

| 服务端职责 | 对应参考 |
|---|---|
| B：产品知识、证据和制品 | [知识记录、快照与证据登记](references/platform/by-object/B.md) |
| C：任务、权限和协作 | [内存与 PostgreSQL 任务服务](references/platform/by-object/C.md) |
| D：实际执行和资源 | [操作、租约、进程和浏览器](references/platform/by-object/D.md) |
| E：专业方法与规则 | [知识问答、用例评审和脑图编译](references/platform/by-object/E.md) |
| 共享与验证 | [契约 F](references/platform/by-object/F.md)、[实验与样本 G](references/platform/by-object/G.md)、[界面 A](references/platform/by-object/A.md) |

## 接下来怎样建设

先核对共同代码的接口与使用者，再逐项建设 server 的身份、持久任务、执行节点和管理入口。已有知识和 PostgreSQL 决策继续沿用；真实输入输出、模型判断、实际操作和已验证结果分别记录。复杂网络调查覆盖物理到应用层，产品方法按型号、版本和环境限定。

Circle 和 server 分别发布，默认连接插件留在 Circle，不另建插件项目。共同代码通过来源记录和同步 PR 管理；兼容清单固定实际验证的客户端、API、worker、能力包和数据库版本。详见[工程计划](https://github.com/qingshanfeihu/infosec-platform/blob/main/docs/circle-server-plan.md)。

当前还没有正式的 server/API 或管理端启动入口。此轮完成仓库、来源基线和参考归档；没有安装平台依赖、启动实验服务、调用模型或连接设备。原参考中的历史结果不作为新 server 的验收结果。

## 核对参考原件

使用 Node.js 24，无需安装依赖：

```sh
npm run verify:references
npm run test:references
```

检查包含文件摘要、Git blob、完整来源树、路径闭包，以及被改动的原件能否被拒绝。它只证明来源和归档完整性，不证明业务行为或设备兼容。

[开源基础检查](docs/open-source-readiness.md) · [B/C/D/E 融合提案](docs/bcde-integration-plan.md)

当前可以继续准备开源，但项目许可和完整私有归档的公开范围仍待确认，仓库保持私有。融合提案尚未实施或排期。

[初始化记录](docs/bootstrap.md) · [来源清单](references/source-manifest.json) · [共同产品看板](https://github.com/users/qingshanfeihu/projects/1)
