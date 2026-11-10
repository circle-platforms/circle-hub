# B2：管理员可达的来源核看请求

来源：所有者 2026-11-09 全量计划；基线 aded2ffd，分支 fix/source-review-queue；关联 #193、#35、#192、#199。

## 允许路径

- `hub/knowledge/requests.ts`、`api.ts`、`requests.test.ts`、`credential-policy.test.ts`、`README.md`
- `hub/server/console/records.ts`、`README.md`
- `hub/server/console-source-review.test.ts`
- `docs/hub-r4-tasks/source-review-queue.md`、`CHANGELOG.md`

## 设计与边界

main已有同步请求索引knowledge.credential.request.all和具名受众/期限，但控制台不列出。由knowledge公共API提供管理员只读分页，基于完整性校验records端口，核对当前有效管理员与原件当前权限，展示请求摘要、具名接收人、原件身份、期限、已到期/已有解决记录；不读取或显示被扣正文/命中值。已到期不当接受，不把动作记录当已通知人。

记录页管理员可达“来源核看请求”列表，单页50条、下一页；禁用或普通成员拒绝，无权私人原件不泄露存在。沿用已有CLI source held/findings/accept/withdraw处理说明，界面不增加写操作或自动接受。

#190仍未集成：本批兼容现有同步请求字段，未来运行读取的新请求使用同索引可接入；不改#190分支、不合并、不声称其线上已生效。#194安全/逐值核看单独门仍保留。

## 验收

合成临时PG覆盖启用管理员/成员/停用管理员、不同所有者私人原件不可见、开放/过期/解决记录、分页和权限重查、无正文/命中值回显，记录水位不变。真实HTTP记录页证实可达和中性拒绝。

## 实际验证

- `node --test hub/server/console-source-review.test.ts hub/server/console.test.ts hub/knowledge/credential-policy.test.ts`：32通过、0失败、0跳过。知识测试将真正produceTree产生的72小时具名请求读入队列，对照请求引用/接收人/期限；HTTP测试含已解决/过期后续/未决、两条分页、私人原件与实时撤权、普通/停用成员拒绝。
- 禁止artifacts.source调用的测试端口仍能列队列，证明只读完整性校验的元数据及权限，不取原件字节。正文与扫描命中值不回显，疑似凭据的外部身份不显示；查询前后records水位一致。
- 隔离Chrome从真实临时HTTP记录页读取52条合成请求：管理员/成员×两主题×三宽度共12图。管理员首屏分页50、下一页2，成员无列表或原件摘要；水位不变。390窄屏截图人工查看。没有真实来源、生产账号或远端通知。
- `npm run typecheck`退出0；`npm run test:docs`333通过、0失败、0跳过。初轮夹具误用createUser角色参数、缺类型和固定日期导致HTTP时钟差异，修正后通过；不将夹具错误记业务故障。
- `node --test tests/acceptance/12-console-security.test.ts tests/acceptance/36-source-unreachable-exit.test.ts`：8通过、0失败、0跳过。
- 不改请求创建、对账、期限或受理决策。#193仅完成现有同步请求可达列表，#190运行读取请求/对账修复未集成、无外部通知；#35/#192其余语义、部署与真实系统验收仍保留。未运行全仓unit/acceptance、Linux隔离或部署。
