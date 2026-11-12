# B2：嵌套读取缓存的有效档位复核

来源：所有者 2026-11-09 全量计划，基线 aded2ffd，分支 fix/nested-read-tiers；关联 #109、#199。

## 允许路径

- `hub/connectors/read.test.ts`、`README.md`
- `docs/hub-r4-tasks/nested-read-tiers.md`、`CHANGELOG.md`

## 当前证据与边界

当前read.ts已通过artifacts.source(function,record)重查有效档位，缓存保存及命中核对每份使用过的原件/派生物，withheld检查stored.held。原有#109三项回归实际运行3通过、0失败、0跳过（另一记录更新扫描器命中、嵌套缓存后命中、受理撤销）。不重复实现或放宽档位，补显式retain_only采集与跨记录扫描命中的区别回归并记录既有修复证据；不因历史issue未关推断当前仍有漏洞。

首轮假设“另一条干净记录显式只保留会降档旧固定采集”失败。核对records/artifacts.ts #choose/#effectiveChoice以及records/derived.test.ts现有明确保留测试后确认：显式保留属于精确采集，跨记录安全收紧来自新版扫描命中，而非任意新采集的档位。保留按held.digest读取为null的断言，同时检查旧固定采集未被替换；不为让错误假设成立改安全策略。

只用临时PG、loopback合成系统和合成字节，不读真实凭据。验证函数不拿到扣留字节、缓存不冒充有效重读、不可用保持中性。运行连接器读取相关测试、类型和文档；线上及真实系统另行验收。#194输出扫描/可疑凭据函数访问仍需所有者逐项确认，不在本批。

## 实际验证

- `node --test --test-name-pattern='issue 109' hub/connectors/read.test.ts`：原有3通过、0失败、0跳过。
- `node --test hub/connectors/read.test.ts hub/connectors/read-coverage.test.ts hub/records/derived.test.ts`：新增采集区分后53通过、0失败、0跳过。脚本包、loopback资源与临时PG均为合成，原read.test包含实际sandbox路径，新四项#109使用requireOsIsolation:false的定向测试端口，不冒充真实系统。
- `npm run typecheck`：退出0；初轮新增origin外部身份缺第三段被拒绝，修正后不再出现，非产品错误。
- `npm run test:docs`：333通过、0失败、0跳过。
- 不改read.ts或records安全策略。#109的实现早于本批；本批交付覆盖与复核，不关闭或宣称部署修复。未跑全仓unit/acceptance、Linux隔离及真实来源验收。
