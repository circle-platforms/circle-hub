# 知识读取正文断言同步

依据：11 月 12 日任务书 B1、同日勘定措辞及集成任务分工。

本分支只改以下文件：

- `hub/knowledge/operation-records.test.ts`
- `hub/knowledge/operation-device.test.ts`
- `hub/knowledge/operation-device.ts`
- `hub/knowledge/contribution-retraction.test.ts`
- 本任务页

按 B1 的显示层改动同步原有正文断言：模型结论未确认，冲突未知，撤回仍披露，设备使用测试环境称呼，用户与会话标识留在结构部分。原有数据、结构断言和场景不变，不新增测试。

集成检查发现被扣留贡献的设备说明缺失，由 B1 保留安全说明；本分支仅把 `operationDeviceNote` 的设备和台架文字改为测试环境称呼，同步同一测试文件的旧措辞断言。没有改变字段、扫描、权限或处理逻辑。

本分支不运行测试、类型检查或安装。全量检查后，由集成分支仅复验失败文件。
