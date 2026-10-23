# 需求追溯矩阵

独立工作流包 story-traceability 1.0.0。按任务页 gold-trace 第 5 条实现；Hub 仅分发和核验，用户给出的需求编号是主路径。编号精确数字规范化，需求号只连接 stories 键，不读取 defects。用例索引不完整，没有索引用例记 missing_input 未知，不能推出没有用例。PLM 未返回仍是条目，状态和阶段各自保留原样，不定义已交付。

可选构建路径由 PLM 资源 settings.build_story_field 指定真实顶层编号数组，配合 build 槽和 build_id。字段名属于管理员部署数据，不是用户参数。缺配置或字段时拒绝并向用户索取编号。有效范围在条目摘要和事实数据明确注明“需求范围取自构建记录”。主路径优先，避免混合两种范围。一个条目最多一份一致 PLM 详情；批次冲突拒绝，不采用最后写入。

## 决定与限制

运行结果附 gaps 和 next_actions：无用例立即核对原始脑图与敏捷树；缺哪个构建的用例条目写明，并请求管理员运行知识同步，完成后重跑。客户端执行 SKILL 的后续流程；Hub 不自动同步、不重试、更不调用模型。PLM 未返回请管理员核实原件与访问。两条完整性反驳：原始需求号与连接矛盾、未截断的视图与总数矛盾。

视图瘦身后没有原始 stories 字段，按知识索引键作为连接证据；字段存在但不含需求号（包括空数组）则反驳。引用保留 PLM JSON 位置及用例树引用。统计按 PLM 原样状态分组，返回但 status 缺失单列 null；没返回不并入状态。原始构建列表按原件保留，只有 PLM 配置投影给出的范围可用。每运行最多 8000 条和 5 MiB 投影预算，超限明确分批。

## 验证

`node --test --test-concurrency=1 packs/workflow/story-traceability/**/*.test.ts packs/workflow/story-traceability/*.test.ts`

`node packs/workflow/story-traceability/pack-files.ts --write` 重新签名清单；`--check` 校验；`--stage <目录>` 准备可发布目录。包内正反样例为合成作者样例，不等于真实验收。发布及临时 PostgreSQL 生产运行端到端仅测试合成读取器。`npx tsc --noEmit` 检查类型。

## Needs from other packages

需要集成者注册 scripts/real/accept/story-traceability.ts 场景，本分支不改 accept-circle.ts。真实 PLM 需求状态、阶段和构建需求字段由集成者核实后配置；目前无新词表轴需求。客户端必须执行 SKILL 的后续动作，用户不能触发管理员知识同步。发布、分配、部署和真实验收由集成者执行。


独立答案脚本 `scripts/real/gold/trace-stories.ts` 只读需求编号清单、PLM 原件、脑图、敏捷树和显式文档清单；不导入 Hub 或包的运行代码。参数为 `--stories <文件> --plm <文件>… --cases-dir <目录> --tree <文件> --docs <文件> --product <产品> --build <构建> --out <文件>`。空文档清单或漏导出的文档不作为通过。场景核对逐需求展示的用例、原样状态和阶段及运行计数，诊断只写序号、计数和摘要。

临时差异：本分支基线的 `gold/locations.ts` 排除零前缀编号，但产品索引保留；独立答案只在标题和目录文本内将零前缀数字映射为无碰撞、等宽的数字占位值，交给共享提取器后还原并规范化；等宽保留日期和版本边界规则，文档编号不改动。集成者已通知 gold-trace 的 36455d4 修复了共享提取器；按集成者要求兼容先保留，待该分支合入并通知后再移除，不改共享文件。
