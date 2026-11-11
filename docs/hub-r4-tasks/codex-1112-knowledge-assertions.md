# 知识读取正文断言同步

依据：11 月 12 日任务书 B1、同日勘定措辞及集成任务分工。

本分支只改以下文件：

- `hub/knowledge/operation-records.test.ts`
- `hub/knowledge/operation-device.test.ts`
- `hub/knowledge/contribution-retraction.test.ts`
- 本任务页

按 B1 的显示层改动同步原有正文断言：模型结论未确认，冲突未知，撤回仍披露，设备使用测试环境称呼，用户与会话标识留在结构部分。原有数据、结构断言和场景不变；不修改生产代码，不新增测试。

本次不运行测试、类型检查或安装；由集成分支最后一次 `npm test` 验证。
