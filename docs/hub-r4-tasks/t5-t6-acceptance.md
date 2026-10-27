# 任务：T4–T6 合成场景验收

来源：所有者 2026-10-27 的测试阶段简报；范围为 T4-2、T4-3、T5-1、T6-1、T6-2、T6-3。只使用合成资源、回环服务和临时 PostgreSQL，不连接真实设备、浏览器、SSH 或账号。

## 边界

- 补 `tests/acceptance` 的机械场景，记录输入、实际调用、回执、终态和反例；已有断言只在 `docs/hub-r5-test-map.md` 指路，不复制旧测试。
- 复用已合入的操作采集钩子、回环假 Hub、真实记录服务和真实 MCP。钩子保存的是脱敏后的完整 UTF-8 输出，不声称未经改写的设备字节，也不把 base64 文本当作图片。
- 合成操作以脚本化事件代替真实 SSH/浏览器操作；新增操作输出只用 ORBIT/COMET，第二产品用 lumen-api，锁定根来自仓库既有合成产品包。地址只用文档网段，身份只由测试临时创建。
- 不改实现和旧测试。发现的能力缺口只写进覆盖表“发现的问题”，不能通过测试替身声明未实现的平台行为。
- T4-3 的床面未恢复及阻止再次派发沿用 `hub/dispatch/bed-state.test.ts`；新场景验证三次采集及恢复后内容一致。完整租约绑定、无租约的未授权标记、WebUI 报告模板及导航/表单结构核验尚无实现。手册与页面/教训的矛盾缺少当前可用的手册对象端点，不能用两条操作记录冒充；这些均不伪造验收通过。

## 可改路径

- 本任务页。
- `docs/hub-r5-test-map.md` 中 T4-2、T4-3、T5-1、T6-1、T6-2、T6-3 和“发现的问题”的对应内容。
- `tests/acceptance/42-r5-t4-2-operations.test.ts`。
- `tests/acceptance/43-r5-t4-3-change.test.ts`。
- `tests/acceptance/44-r5-t5-1-webui.test.ts`。
- `tests/acceptance/support/operation-acceptance.ts`（新增共享夹具，如确有需要）。
- `docs/hub-r4-tasks/skill-lazy-locate.md` 中不合规的本机目录写法（仅合入门要求的单行路径清理，不涉及该任务的实现）。

其他路径不改。合入前主线若触碰这些文件，先同步、复核并重跑规定验证。

## 验证

先运行新增场景及直接相关的操作记录、床面测试和类型检查；再以并发 2 运行 docs、contracts、hub、packs、acceptance（含 oracle）、scripts 和归档检查。只暂存显式路径；检查提交差异和整树的安全边界；用带说明的 `merge-locked.sh` 合入并报告实际计数与未覆盖的真实层。
