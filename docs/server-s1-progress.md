# 第一阶段构建记录

2026-10-12。基线 `d839935`；隔离目录 `../circle-server-s1`，分支 `server-s1`。授权与八幕要求固定在 [brief](server-build-brief.md)。Circle、foundation 和 references 不参与修改。检查只使用脚本模型、合成资源和临时 PostgreSQL。

## 授权固定

首笔提交更新 AGENTS.md 并登记 brief。确认 brief 已在分支跟踪且与主工作树副本相同后，按 brief 删除主工作树的未跟踪副本；主工作树保持干净。没有 push 或 PR。

## 1：契约（已完成）

先编写独立契约验收，固定 `task` / `inrev` 身份、60/20 秒租约参数、统一操作词表、请求身份剥离、规范哈希和连接器动作声明。依赖版本以 npm 元数据核实并固定，锁文件随本步骤提交。

实际检查：`npm run test:contracts` 先因缺少实现失败，实现后 3/3 通过；`npm run typecheck` 通过；`npm run verify:postgres` 在临时目录启动 PostgreSQL 18.4，实际返回 x86_64-apple-darwin24.6.0，监听仅 127.0.0.1，随后停止并删除目录。包版本 `embedded-postgres@18.4.0-beta.17`，没有系统安装或创建系统用户。`npm run verify:references` 校验 714 原件，`npm run test:references` 7/7 通过。

后续按 brief 顺序推进 PostgreSQL/C、worker/D、B/E、连接器、审批交付、管理命令。每一步在此登记实际检查和仍缺项。八幕尚未验收；尚未发布或部署。
