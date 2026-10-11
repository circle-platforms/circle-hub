# @infosec/server-stub

P1-3 对拍用的最小长任务服务桩：一个确定性的 scripted 模型 + 三种传输（MCP / CLI / HTTP），与 [P1-3 记录](../../docs/p1-3-pairing-record.md) 对应。

- **它是什么**：契约的试验台。行为由 `payload.script` 驱动（instant / slow / needs-input / fail-target / drop-receipt），逻辑时钟与 ID 计数器都是确定性的，所以同一场景在三路上必须产出逐字相同的响应信封——对拍测试就是这么断言的。
- **它不是什么**：不是产品服务。没有持久化数据库（CLI 路用状态文件模拟“状态在服务侧”）、没有真实身份校验（身份格式由契约 schema 校验，可信通道校验不在 P1 范围）、脚本指令是测试控制通道，不是生产 API。
- **状态归属**：状态只在服务核心里；MCP 服务进程、HTTP 服务进程、CLI 的状态文件都只是它的载体，客户端不持有任务状态——这是共同契约“状态不能依赖 harness”的最小演示。

## 使用

```bash
# 先装契约包（同级目录），再装本包
npm --prefix ../contracts install
npm install
npm run typecheck
npm test   # pretest 会先构建契约包与本包，再跑 fixtures/vectors.json 的全部场景 × 三路
```

场景与期望都在 `fixtures/vectors.json`：即时成功、慢执行轮询、待输入（含旧修订拒绝）、目标失败、执行前取消（四段状态）、回执丢失→unknown→对账、幂等重复提交、越权 scope、版本不受支持、终局后取消冲突。
