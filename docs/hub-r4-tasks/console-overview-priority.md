# B5：总览先任务，统计与规划按需展开

来源：所有者B5合成70图后选择A+共用方向（2026-11-09），#216、#220（总览部分）、#199；基线aded2ffd，分支fix/console-overview-priority。

## 允许路径

- `hub/server/console/{overview.ts,style.ts,README.md}`
- `hub/server/console-overview-bound.test.ts`
- `hub/server/console-overview-priority.test.ts`
- 本任务页、`CHANGELOG.md`

## 实现范围

保留既有120任务和逐任务请求预算、正式结果推导、未知/零/无结果统计、时间范围及用户权限。首区为最多8个可见任务的可读列表，未回应请求/未决/未完成/拒绝/扣留/尚待判定优先；显示原状态/最近开始时间，不把需继续等同当前用户可操作。始终可达完整任务列表。

键盘/屏幕顺序与视觉一致，所有宽度任务先于紧凑统计；760及窄屏4统计2×2。趋势/期间瀑布和结果表按需展开，保留完整同源表格；系统/知识/运行状况及规划分别收拢，不移除未知/规划决定。无选中/无详情不再复制右侧任务统计Inspector。页面仍为同一liveModule名称与事件订阅，原details开合保存机制保持。

## 验收

先红真实/合成HTTP顺序/全部证据/无重复Inspector，数据混合包含已满足、待输入、不可读摘要、过期/未回应请求，权限不扩大。五宽×两主题，任务首屏/2×2统计/展开图表和键盘焦点可见，不能仅断言隐藏DOM有文本。回归bounded、console/status/live/CSP、类型/文档；不作性能查询减少结论或真实用户研究。

## 实际结果

- 新HTTP两项在旧main确定失败：首屏统计先于任务、空态下一步在统计后、右侧重复概况。修复后`node --test "hub/server/console/*.test.ts" hub/server/console-overview-priority.test.ts hub/server/console-overview-bound.test.ts hub/server/console.test.ts hub/server/console-csp-nonce.test.ts`72通过、0失败/跳过；typecheck退出0，docs333通过、0失败/跳过。
- 10任务混合fixture最近一个已交付、其余待提交；8条预览保留最近待继续任务、不让已完成任务挤前。补充其中一条getRun返回null，列表保持“结果暂不可用”且仍可看任务，不当成功。旧bounded请求测试继续证明5,000条其他run请求不增加本页读取，列表requests:false/逐任务请求读取保持。
- 两个真实临时HTTP空态/有任务页面×两主题×五宽度20情形，每个首屏与展开表格各一图=40图。任务起点<450CSSpx、先于统计；≤760px统计确为2×2，键盘Space展开趋势、完整结果表实际可见、snapshot/restore保持details开合，水位不变。人工查看390有任务、1440空态、390展开表3张，其余自动矩阵。
- 首轮测试误将data-live事件值当模块ID导致夹具误报，改用实际id=live-overview-kpis；MCP structuredContent依公开StartRunOutput解析，无类型放宽。
- #220仅总览部分，连接/记录/其他模板仍后续；已规划卡片和零/未知原值保留，未移除数据。未运行全仓unit/acceptance/Linux、实时生产任务、真人可用性或部署；图表仍在服务器计算，本批不降低后台内存/查询承诺。
