# 怎样读懂代码里的函数

先读[项目内容说明](../project-explanation.md)，了解各部分为什么存在、怎样配合，以及目前的限制。下面按实际用途分开说明。

- [前端工作台](functions/workbench-ui.md)提供会话、上下文和四个对象的管理界面。
- [任务和实际操作](functions/platform.md)保存工作进度、操作记录和资源使用情况。
- [进程与浏览器执行管理](functions/execution.md)、[长期任务比较](functions/runtime-eval.md)和[入口验证](functions/harness-adapters.md)说明后续代码及其范围。
- [保存在数据库中的任务](functions/platform-pg.md)让工作能够留下持久记录。
- [产品资料和知识快照](functions/knowledge.md)保存指定版本的资料和读取范围。
- [公共格式与基础规则](functions/contracts.md)帮助各部分一致地表达请求和结果。
- [判断方法](functions/assessor.md)保存依据、结论和不能确定的内容。
- [真实模型评测适配器](functions/llm-assessor.md)记录提示构造、模型调用、预算与弃答；源码登记不代表本轮运行了模型。
- [产品知识问答](functions/chain-v01.md)、[用例评审](functions/chain-v04.md)和[脑图转 Excel](functions/chain-v05.md)是目前的专业方法参考。
- [模拟设备](functions/apv-fixture.md)、[本地登录测试站](functions/test-site.md)和[通信测试服务](functions/server-stub.md)帮助稳定复现问题。

每页先用自然语言介绍作用。需要查某个函数时，再展开代码核对部分。内部帮助函数也收录在里面，但不会因此变成产品对外提供的接口。

[关键函数说明](../design/critical-interface-contracts.md)解释目前最需要保护的行为。其他函数还需要逐项补齐用途、输入、结果、失败处理和使用者，不能把自动生成的目录当作完整设计。

<details>
<summary>给开发者的生成和核对方法</summary>

[机器目录](function-catalog.json)与[生成记录](generation-receipt.json)绑定指定源码。它们记录命名函数、类和接口的方法、构造器及具名可调用值，包含内部帮助函数；匿名回调、依赖、配置和测试文件不作为独立产品接口。

使用 TypeScript 5.9.3 解析器运行 `node .github/scripts/generate-function-reference.ts`。解析器不在 contracts 的既有依赖目录时，可以用 `INFOSEC_TYPESCRIPT_PATH` 指定独立工具路径。脚本不安装依赖，也不执行业务模块。

运行 `node .github/scripts/check-docs.ts` 检查链接、函数引用和源码摘要。Node 的[内置 TypeScript 支持](https://nodejs.org/api/typescript.html)只去除类型语法，不执行类型检查。工具结果只证明文档与代码登记的范围。

</details>
