# 任务：知识：视图续读与范围声明，同步把源头的答复记成确定的结论

依据：

- 所有者 2026-10-23 的规矩：未知只是过渡状态，要写明缺哪个事实、取得它的下一步动作、由谁做、何时到期；流程自动执行这一步，或者写成请求交给具名的人。以未知结束的运行、报告或检查都是缺陷。
- 全量普查 `docs/hub-r4-research/unknown-sweep.md`：第 2 节缺陷、第 3 节设计缺口、第 4.2 节缺的动作、第 5.2 节数据缺口。下面各条写了位置和要改的模型元素，动手前先读普查里同一处的真实影响。
- 理论文档 `docs/design/truth-docked-architecture.md`；模型用 `node tools/show-element.ts <元素>` 读。

- 分支和工作树：`hub-view-scope`，目录 `circle-hub-view-scope`。等这一批（K2、core-fixes、views-and-notes、kb-sections、hub-job-dispatch 等）合并以后，由集成者从 hub-redesign 开出并通知。
- 范围（普查拟定，集成者照当时合并后的代码再核一遍）：等 views-and-notes、kb-candidates、kb-sections 合并后从 hub-redesign 开出。可以改：hub/knowledge/**、contracts/src/views.ts（照生成器重新生成）、hub/records/artifacts.ts、scan.ts、coverage.ts、objects.ts、hub/refs/text-decoding.ts、parser.ts、parsers/**、hub/server/upload.ts 的识别答复、hub/runs/engine/inputs.ts 里绑定知识视图的一段（与 hub-read-absence 错开）、packs/product/apv/functions/**；对应测试。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。枚举只来自生成的词表；Hub 只核验，不生成内容。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对改到的目录；每条先写改前失败、改后通过的测试。

## 要做的

1. 视图续读：视图 id 支持 after=，视图给 next；索引、影响、分面视图不再静默丢键；运行绑定视图时读完全部页，或按条目 only= 收窄。
2. 视图声明索引范围：列出的文档、略去的文档及原因（含产品同步不列出的 762 份这类文档）、未归位条目数、缺的可选来源；影响视图带未归位的用例数。
3. 归位：用例也从步骤和预期行解析命令（同一个解析器）；接 bot 提议的确定性核验（路径存在、引文逐字出自原件；决定 15、25，通道在 kb-candidates）；剩下的记确定的“没引用目录里的任何命令”并计数；去掉旧的“交给归类服务”说法；手册按章节挂的部分在 kb-sections，不重复做。
4. 同步：构建站 404 记在构建记录上并登记为无根构建，列表变了才重查；403 记结论并请构建站负责人开放访问；缺的可选手册在根上记结论；别名缺的基础构建交回计划去取（sync.ts:248-256）；计划被轮数或读数上限截停时存下待取清单，下次接着取；知识同步可定时跑（部署另定）。
5. 生产器：超时不记忆，跳过时 retry:true、原因 timeout（call.ts:51、lists.ts:274、367）；超单次上限的文档单独一次调用；单文档失败给包作者一条生产者错误结论；跳过的 id 和问题全部存成按内容寻址的分块记录，每次同步全部重试。
6. 凭据：照决定 20 和新的 C04 R[6]，同步时对已点名的来源类别自动接受并记录，其余给管理员发带期限的请求；命中超过 100 条可分页列出、按检测类接受；计算视图最后一步拒绝时列出被排除的引用和管理员动作。
7. 解析：GB18030、GBK、Big5、UTF-16 解码并带偏移表；接受不带实体声明的 DOCTYPE；recognize() 把各解析器的拒绝原因带回同步和上传答复。
8. 构建与目录：构建名只差大小写时返回候选（builds.ts:123）；apv 的 listing.ts 解析“先时间、后斜杠日期”，仍认不出就记为失败的构建；空目录视图保留声明的完整性（read.ts:581-583）；get_nodes 的过期游标返回确定的原因（read.ts:234-241）。
9. 有效性：读出时列出没能评估的条件，适用条件全部评过才报 valid（read.ts:412-500）。
10. 命令树与用例条目：照新的 catalog-entry@1 改 packs/product/apv/functions/command-tree.ts（参数地址角色、地址或主机名联合类型、单数 limit）；产品同步不列出的用例文档放进不分版本线的范围；没打标签的用例在条目上记“正负向和测试类型未声明”。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
