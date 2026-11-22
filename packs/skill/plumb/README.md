# packs/skill/plumb

客户端侧 Plumb 推理网关通用技能包（`kind: "skill"`，`schema: "skill@1"`）。

## 职责边界

- **只跑在客户端侧**：严格遵守 Decision 15 与 `AGENTS.md`（Hub 永不调用模型）。本包只包含本地 TLS 校验客户端模块 `functions/modules/plumb-client/`、受守卫 CLI `tools/plumb.ts`、合成示例 `examples/` 与包元数据。
- **TLS 与凭证安全**：
  - 除回环地址（`127.0.0.1` / `localhost` / `[::1]`）外默认要求 `https://`；支持 `--ca-file` / `PLUMB_CA_FILE` 及可选 SHA-256 指纹锁 `--ca-sha256` / `PLUMB_CA_SHA256`。
  - 严格拒绝通过 `--api-key` 或 `--claim-code` 命令行参数明文传密；必须通过 `--key-stdin` / `--claim-code-stdin` 或环境变量 `PLUMB_API_KEY` 注入，并在输出与审计日志中自动脱敏。
  - `POST` 读超时、`408`、`504` 与连接中断不自动重发；单次 `/v1/judge` 受网关三项上限约束：`<= 32` 题、各题展开后合计 `<= 256` 个打分对（选择题每个候选算一对，同一请求的各题共用这一个预算）、请求体 `<= 1 MiB`；`judgeBatched` 按这三项依次装批，装不下一题时在发出前报错；客户端并发上限默认 `2`（等于网关每个密钥的在途上限）、窗口限流 `60 RPM`。
- **唤醒不空等**：`wakeAndWait`（`wake --wait`）在唤醒之后连续两次轮询都看到网关的 `backend_state: "failed"` 时，当场以 `503 backend_failed` 结束，不等满超时；信息引用网关的 `progress_message`（没有就用 `phase`），去掉密钥并截到三百字，下一步是请 Plumb 管理员检查后端，不要再唤醒。唤醒前的那次状态和唤醒后的第一次轮询可能还是上一次失败的结果，所以只数唤醒之后的轮询，中间有一次别的状态就重新数。唤醒请求或唤醒中的轮询遇到 `backend_down` 时，下一步同样是联系管理员；判别、询问和单独的 `status` 遇到它仍建议先 `plumb wake --wait`。
- **模型判断披露**：强制核验响应携带 `status: "未确认"`、`decided_by: "模型"` 与非空 `model_version`，否则拒绝消费响应。

## 验证

```sh
node --test --test-concurrency=1 "packs/skill/plumb/**/*.test.ts"
node packs/skill/plumb/api.ts check
```

## 网关上限的来源

网关不在任何响应里公布这些上限（`/v1/models`、`/v1/status`、`/healthz` 都没有），拒绝时也只写「还剩多少」：`Compiled judge pairs (24) exceed limit (16)` 里的 16 是同一请求前面各题用完后剩下的预算，不是上限。所以数字钉在 `functions/modules/plumb-client/gateway-limits.ts`（`PLUMB_GATEWAY_LIMITS`、任务到题族的对照、选择题的计价规则）。网关的配置或计价写法变了，先按网关的配置和接口说明改这里的常量，再跑 `gateway-limits.test.ts`；这份测试只用合成题目核对分批和计价，不读网关的源码。
