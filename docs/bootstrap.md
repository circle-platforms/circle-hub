# 仓库初始化与参考归档

2026-10-11。用户要求先创建 server 仓库，再把已有 platform 代码归入对应参考。本记录只说明本次实际整理范围。

## 来源

- Circle：9d23c09a0f8de2f71920b32b23db9af6c9a41100，公开主干；保留共同 Git 历史与 upstream。287 份原件移到 foundation/circle，源内容保持不变。
- infosec-platform：4ab6c5ea593eb1b1d71bed92374b3a013ba61ad9。427 份原件复制到 references/platform/snapshot，完整目录、16 个 package、测试与样本依赖保持不变。源仓库未删除或迁移其历史文件。

server 是独立私有衍生仓库，不在 Circle 公共 fork 网络中。未导入其他分支、tag、本地未提交的桌面代码、用户数据或依赖目录。Circle 原 checkout 与正在进行的分支保持不动。

## 归属与证明范围

B/C/D/E 的实现参考按状态和方法用途列出；A 的界面、F 的契约、G 的验证单列。混合 package 不因包名强行划成同一职责。索引不将 UI 模拟状态当作服务端状态，也不将测试站或 APV 夹具当作真实产品支持。

来源清单和完整 Git tree 摘要固定本次原件。检查逐份验证 SHA-256、Git blob、文件/目录闭包、源路径和来源树；原件被改或新增未登记文件时拒绝。校验不执行业务源码，也不证明原实现的逻辑正确。

只启用 root 的参考校验 CI。原 Circle 的 CLI 检查、发行和 Pages 工作流，以及 platform 的旧工作流都保留在来源子目录，不被新仓库当作当前发布或部署任务执行。

## 尚未实施

正式 server/API、认证接入、后台 Agent 生命周期、管理端和 Circle 默认连接插件仍待逐项建设。当前没有以 Circle 的个人数据路径或 JobRegistry 替代服务端持久任务、权限与执行权威，也没有把参考代码自动接入运行。

许可和第三方说明沿用各来源原件；Circle 的 LICENSE 和 notices 保留在 foundation/circle，平台原件保留原仓库范围。新 server 尚未发布软件制品。
