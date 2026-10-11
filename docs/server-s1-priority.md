# 第一阶段优先级调整：脑图编译

2026-10-12，用户在完成 C 基础后追加授权与顺序调整。第一优先级是 Circle 经 server 编译脑图，最终验收在真实 Otty 终端完成；Circle 客户端与连接插件由 Claude 实现，本分支不修改 Circle。

当前 server 工作先完成：

1. 自写 TypeScript `mindmap-compile` 能力包，接受 `.xmind` 的 content.json（2020+）、裸 content.json 和主题树 JSON。只读冻结 V05 样本与 Excel 脑图 V1 契约，另制备合成 zip 样本。IR 编译为两表七列工作簿，独立读取器回读逐格核对；不调用现有编译 skill、InfoTest 或旧 Python。B 保存原件、产物及 SHA，C 持久受理、推进和交付；重提不能重复产物，无法映射元素必须列为 partial。
2. 将开发登录、原件上传、能力包、submit/status/events/result/input 与产物下载的 HTTP 契约定在 packages/contracts。
3. `npm run dev:stack` 一次启动临时真实 PostgreSQL、server、独立 worker，打印地址和开发登录方式。

三项完成并通过当前验收后，提交 `docs/client-api-handoff.md`，在当前终端通知接口就绪。LBX、连接器、设备审批和完整管理命令放在这条故事之后；原 brief 的其他边界仍有效。没有取得 push、PR、部署或付费模型授权。真实 Otty/Circle 组合演示不能以本分支的 HTTP 测试替代。
