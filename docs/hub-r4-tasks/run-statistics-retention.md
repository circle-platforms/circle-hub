# B1：核验后只保留任务统计，不让整份结果占住页面

来源：所有者全量计划#200/#195/#199；基线aded2ffd，fix/run-statistics-retention。#251历史提前停止/#256四worker仍独立未合入，本批补充而非声称完成全部性能问题。

## 允许路径

- `hub/ports.ts`
- `hub/records/{api.ts,read-scope.ts,read-scope.test.ts,README.md}`
- `hub/runs/{api.ts,statistics.ts,statistics.test.ts,README.md}`
- `hub/runs/engine/{service.ts,query-scope.ts,statistics.test.ts,README.md}`
- `hub/server/console/{tasks.ts,status.ts,overview.ts,README.md}`
- `hub/server/console-task-statistics.test.ts`
- 本任务页、`CHANGELOG.md`

## 决定

新增内部可选getRunStatistics：沿用getRunSummary所有完整性核验、最新头选择、权限/grounds/撤回和未知管理状态，然后仅派生列表/总览真正需要的正式任务状态、未决数、检查层终态计数和阻塞代码/原因计数。输出无run原件字段/claims/quotes/诊断全文。正式状态算法从console移到runs公共纯函数，console原API转调，防两套定义。

统计读取在明确隔离的短read scope中进行，子scope与父scope共享retirement代次和活跃scope集合但不复用/保留父scope缓存；普通写入同时清父/并行子缓存，破坏性写入retire全部，子结束从集合移除；结束清空核验/记录缓存，只有紧凑统计返回页级。完整detail/export/summary对外旧行为不变。UI优先getRunStatistics，老端口退回getRunSummary/getRun并立即派生/丢弃详情；表格仍按listRuns原已读run信息显示。此批不做未核验DB JSON投影，不持久化派生事实，不缓存跨用户权限结果。

## 验收

完整结果与统计在owner/admin/受分享者、fact-only、system_input、abandoned、未知/不满足/缺输入/扣留等一致；隐藏当前头不回退、撤分享/权限收紧重查、不留历史/当前大claims，篡改记录仍拒绝。固定行/要求/终态的大陈述体输入扩大100倍时输出字节/对象数保持不变；隔离scope证明不会读到父memo/不会把原件塞回父memo，retire跨子scope有效。UI断言新端口不调用旧详情、旧适配器等价、unknown/null行为保留，overview计数/阻塞与旧实现相等。

本批loadTasks同时保留#256同样的4worker/原下标写回，避免新统计入口重引入全页Promise.all；#256独立未合入，集成冲突以本批统计版4worker为准，旧.detail断言改查原row/run和紧凑统计且保留调度/unknown控制。待独立合成组合#251/#256/#265验证。两周观察、DB持久摘要、长历史跳过、详细分页仍待后续；不以输出小推断DB/CPU已解决。

## 实际验证

- 原嵌套scope复用父缓存的新增控制确定失败；普通写入的父缓存控制也确定失败0≠1。新增显式隔离、活跃scope集合后父/并行子普通写入失效及retirement全部通过，默认嵌套行为保留。
- `node --test "hub/runs/engine/**/*.test.ts"`：641通过，0失败/跳过；该次在最终scope集合修正前完成。最后再跑read-scope、engine/statistics、runs/statistics、console-task-statistics：38通过，0失败/跳过，涵盖父/并行子失效、当前头隐藏不fallback、owner/shared/admin/disabled、撤分享、未知、真实1MiB以上陈述、合法空白与非法改字完整性拒绝。
- `node --test "hub/server/console/*.test.ts" hub/server/console.test.ts`：66通过，0失败/跳过。后增4worker统计入口120行控制在最终38内通过；既有overview-bound另2控制通过。
- `npm run typecheck`：最终退出0。新增fixture先后补齐RunRecordView的rules/run_interpreters、合法时间、location和明确partitions；生产类型未放宽。篡改测试先被append-only触发器拒绝，随后仅在临时DB的明确corrupt函数事务内绕过触发器以建立损坏输入，读取仍拒绝。
- console-security + source-unreachable acceptance：8通过，0失败/跳过；先写错shared-space路径未运行该文件，补跑实际30-shared-results.test.ts：1通过、0失败/跳过。
- `npm run test:docs`：333通过，0失败/跳过。
- 独立detached组合树基于#251，应用本批runtime、#265总览与#256等价4worker；最终45通过，0失败/跳过。类型退出0；此前20浏览器案例/40捕获通过（两种主题、五宽度、空/有任务），该浏览器运行在最终scope集合修正前完成，最终45覆盖修正后的真实HTTP组合路线。保留子树未提交、未推送，不代表合并。
- #256原回归改以每行不同未决数验证对应关系，不再要求保留detail；新旧两个worker实现同样3控制各通过，typecheck退出0。其独立跟进cf4c6c2f已推送原草稿，运行时未变。
- 最终member-deletion、personal-payloads、read-scope：45通过、0失败/跳过，检查破坏性账户/载荷退休路径与默认读取兼容。
- 未做真实数据/部署、Linux隔离、全仓npm test、堆/全局并发/吞吐上限或两周观察；当前完整摘要仍读大正文/历史，listRuns原run view仍留页级。内部可选端口不改变MCP六工具、外部schema、生成协议、包版本或配置。
