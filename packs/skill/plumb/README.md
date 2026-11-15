# packs/skill/plumb

客户端侧 Plumb 推理网关通用技能包（`kind: "skill"`，`schema: "skill@1"`）。

## 职责边界

- **只跑在客户端侧**：严格遵守 Decision 15 与 `AGENTS.md`（Hub 永不调用模型）。本包只包含本地 TLS 校验客户端模块 `functions/modules/plumb-client/`、受守卫 CLI `tools/plumb.ts`、合成示例 `examples/` 与包元数据。
- **TLS 与凭证安全**：
  - 除回环地址（`127.0.0.1` / `localhost` / `[::1]`）外默认要求 `https://`；支持 `--ca-file` / `PLUMB_CA_FILE` 及可选 SHA-256 指纹锁 `--ca-sha256` / `PLUMB_CA_SHA256`。
  - 严格拒绝通过 `--api-key` 或 `--claim-code` 命令行参数明文传密；必须通过 `--key-stdin` / `--claim-code-stdin` 或环境变量 `PLUMB_API_KEY` 注入，并在输出与审计日志中自动脱敏。
  - `POST` 读超时、`408`、`504` 与连接中断不自动重发；单次 `/v1/judge` 限制 `<= 32` 题且请求体 `<= 1 MiB`；客户端并发上限默认 `2`、窗口限流 `60 RPM`。
- **模型判断披露**：强制核验响应携带 `status: "未确认"`、`decided_by: "模型"` 与非空 `model_version`，否则拒绝消费响应。

## 验证

```sh
node --test --test-concurrency=1 "packs/skill/plumb/**/*.test.ts"
node packs/skill/plumb/api.ts check
```
