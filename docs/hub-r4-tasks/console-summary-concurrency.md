# B1：任务摘要读取并发有界

来源：所有者 2026-11-09 全量计划，基线 aded2ffd，分支 fix/console-summary-concurrency。关联 #200、#195、#199；独立于 #251 的历史早停补丁，可按任意次序集成。

## 允许路径

- `hub/server/console/tasks.ts`、`tasks.test.ts`、`README.md`
- `docs/hub-r4-tasks/console-summary-concurrency.md`、`CHANGELOG.md`

## 验收及边界

当前loadTasks对一页全部运行Promise.all，120条会并行加载重正文。改为单页4个worker，保留输入顺序、每行结果与读取失败的未知展示；不能减少列表数量、绕开权限/完整性、把未知显示成功。只限摘要加载，不更改只读请求批量收集或全详情协议。

用确定性门闩控制120个摘要读取，验证未释放前只启动4个，最大并发4，逐行顺序正确且全部120条保留；包含null、抛错及无摘要API的兼容端口，不使用墙钟上限。运行相关控制台/HTTP/总览测试、类型和文档。真实吞吐与堆占用尚需后续投影和容量验证，不凭此宣布超时修复。

## 实际结果

- 先加确定性门闩回归，原实现同时启动120项而预期4项；修正夹具的fact-only状态后控制测试通过、并发项仍确定失败。修复后3个定向测试通过，最大并发4、全部120条保留、反序完成不串行、null/抛错/未决状态和旧详情端口保持原语义。
- `node --test "hub/server/console/*.test.ts" hub/server/console.test.ts hub/server/console-overview-bound.test.ts hub/server/console-results.test.ts`：80通过、0失败、0跳过；后增反序完成控制单独运行3通过、0失败、0跳过。
- `npm run typecheck`：最终退出0。先前新增夹具原始对象与RunRecordView的rules必填类型不一致，改由RunRecord解析后明确空requirements；生产代码没有放宽类型。
- `npm run test:docs`：333通过、0失败、0跳过。
- 未运行全仓unit/acceptance、Linux隔离、堆/吞吐容量测试或真实部署；每页并发不代表跨会话全局并发，完整正文最终保留内存问题未解决。#200/#195保留后续投影、长拒绝链、详情分页和实测工作。

## 与紧凑统计后续的断言兼容

后续B1不再把完整detail保留在行里。本分支测试改以每行独立未决数0/1/2/3作为结果绑定哨兵，而非要求保留detail对象；门闩最大4、120条完整与顺序、反序完成、null/抛错不fallback/未知展示断言保持。旧summary和新紧凑统计4worker组合各3通过，合计6通过、0失败/跳过，typecheck退出0。首次新哨兵缺location被schema拒绝，补齐合法fixture后通过。运行时代码未变，不提前引入后续接口。

