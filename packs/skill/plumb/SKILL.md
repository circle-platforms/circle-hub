# Plumb 判断客户端

本技能向客户端侧提供受 TLS 与主机锁定约束的 Plumb 推理网关访问能力及可内嵌模块 `plumb-client`（供工作流包通过构建期生成镜像使用）。Hub 永远不直接调用任何模型或 Plumb 网关；本技能也不充当 Hub 代理。

## 允许命令行语法

所有带值选项均使用 `--选项 值` 空格分隔格式（禁止使用 `=` 连接，禁止在命令行传入 `--api-key` 或 `--claim-code`）：

1. 查看模型与就绪状态：

```text
node '<技能目录>/tools/plumb.ts' models --base-url %PLUMB_URL% --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

```text
node '<技能目录>/tools/plumb.ts' status --base-url %PLUMB_URL% --model plumb-27b-0.5.0 --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

2. 唤醒空闲后端（冷启动通常需要 406–641 秒，建议结合后台/长超时等待）：

```text
node '<技能目录>/tools/plumb.ts' wake --base-url %PLUMB_URL% --wait --timeout-sec 720 --model plumb-27b-0.5.0 --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

3. 单条或批量调用判别接口（自动分批至多 32 题/请求、并发不超过 2、写审计 JSONL）：

```text
node '<技能目录>/tools/plumb.ts' judge --base-url %PLUMB_URL% --file '<请求JSON>' --cache-dir .plumb-cache --out plumb-audit.jsonl --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

## 约束与口径

- 非回环地址强制要求 `https://`，默认读取 `PLUMB_CA_FILE`（与运行环境注入的 `NODE_EXTRA_CA_CERTS`）及可选 `PLUMB_CA_SHA256` 指纹校验；不关闭证书校验证书链。
- 全部模型判别结果恒附带并强制核对 `status: "未确认"`、`decided_by: "模型"` 与真实 `model_version`，严禁直接当作已核准结论或省略披露字段。
- `POST` 请求在超时（`408`/`504`）或中途断连时不自动重发；超长触发 `413 request_too_large` 时应按前序上下文裁剪或拆分，不得吞错放行。
