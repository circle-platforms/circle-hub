# 知识读取正文断言同步

依据：11 月 12 日任务书 B1、同日勘定措辞及集成任务分工。

本分支只改以下文件：

- `hub/knowledge/operation-records.test.ts`
- `hub/knowledge/operation-device.test.ts`
- `hub/knowledge/operation-device.ts`
- `hub/knowledge/contribution-retraction.test.ts`
- `packs/workflow/template-gap/engine.test.ts`
- `tests/acceptance/42-r5-t4-2-operations.test.ts`
- `tests/acceptance/43-r5-t4-3-change.test.ts`
- `tests/acceptance/44-r5-t5-1-webui.test.ts`
- `tests/acceptance/46-knowledge-spaces.test.ts`
- 本任务页

按 B1 的显示层改动同步原有正文断言：模型结论未确认，冲突未知，撤回仍披露，设备使用测试环境称呼，用户与会话标识留在结构部分。原有数据、结构断言和场景不变，不新增测试。

集成检查发现被扣留贡献的设备说明缺失，由 B1 保留安全说明；本分支仅把 `operationDeviceNote` 的设备和台架文字改为测试环境称呼，同步同一测试文件的旧措辞断言。没有改变字段、扫描、权限或处理逻辑。

全量检查还定位到模板覆盖测试遗留的 256 来源预期：指定基线 `4218d1fa93` 已将 `read-budget.ts` 的预算提高到 1024，六份文档在预算内。因此同一场景改为核对六份文档均被接收、结果完整并保留两个要求项；原有命令目录、索引匹配及后续逐文档业务断言不变。没有修改生产预算或增加大型数据。

验收检查中，同步场景 42 的未确认模型结论、冲突未知和场景 43 的测试环境措辞。客户端捕获、来源、等级、原句、双端点、不可变记录、撤回及拒绝清单外设备的原结构断言全部保留。

场景 44 只同步已声明浏览器设备的测试环境称呼，设备、所属测试环境、PNG 原字节和读取权限断言不变。

场景 46 同步个人资料保存和未检索范围的正文措辞；状态和已核对引文改由原机器答复逐值核对，保留原引用与引文的精确对应、错误码、权限、容量和检索降级检查。

本分支不运行测试、类型检查或安装。全量检查后，由集成分支仅复验失败文件。
