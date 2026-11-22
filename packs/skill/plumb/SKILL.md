---
name: plumb
description: 在客户端查 Plumb 推理网关的模型与就绪状态、唤醒空闲后端或提交判别题时使用；判别结果是模型判断、未经确认。工作流另以内嵌模块使用同一个客户端，不代 Hub 调用模型。
---

# Plumb 判断客户端

在客户端向 Plumb 推理网关查模型和就绪状态、唤醒空闲后端或提交判别题时使用。工作流包另以内嵌模块 `plumb-client` 使用同一个客户端。Hub 不调用任何模型或 Plumb 网关，本技能也不替 Hub 转发。

## 命令

带值选项一律写成 `--选项 值`，不用 `=` 连接；密钥只从标准输入第一行传入，不写 `--api-key` 或 `--claim-code`。`--model` 可以省略，省略时用网关的默认模型，可用的模型见 `models`。

1. 查看模型与就绪状态：

```text
node '<技能目录>/tools/plumb.ts' models --base-url %PLUMB_URL% --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

```text
node '<技能目录>/tools/plumb.ts' status --base-url %PLUMB_URL% --model %PLUMB_MODEL% --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

2. 唤醒空闲后端。冷启动可能要十分钟左右，用后台任务或长超时等待：

```text
node '<技能目录>/tools/plumb.ts' wake --base-url %PLUMB_URL% --wait --timeout-sec 720 --model %PLUMB_MODEL% --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

   等待中网关在唤醒之后连续两次报告后端启动失败（状态里 `backend_state` 是 `failed`），命令当场以 `backend_failed` 结束，不等满超时，输出里带网关自己写的原因（`progress_message`，没有就写 `phase`）；中间有一次别的状态就重新数。这时请 Plumb 管理员检查后端，不要再唤醒。唤醒请求本身被拒（`backend_down`）时同样请管理员检查后端，不再建议执行 `wake --wait`。

3. 单条或批量判别。超过网关单次请求上限（32 题、展开后 256 个打分对、请求体 1 MiB）时自动分批，并发不超过 2，审计记录写成 JSONL：

```text
node '<技能目录>/tools/plumb.ts' judge --base-url %PLUMB_URL% --file '<请求JSON>' --cache-dir .plumb-cache --out plumb-audit.jsonl --key-stdin <<'EOF'
%PLUMB_API_KEY%
EOF
```

请求体的三种写法见 `examples/`：`match-single-cmd.json`（一条命令是否符合当前步骤）、`choice-node.json`（在候选命令里选一个）、`sequence-fidelity.json`（命令块是否实现作者的步骤）。

## 约束与口径

- 非回环地址只用 `https://`；证书默认读 `PLUMB_CA_FILE`（以及运行环境注入的 `NODE_EXTRA_CA_CERTS`），可加 `PLUMB_CA_SHA256` 指纹校验；不关闭证书链校验。
- 每个判别结果都带 `status: "未确认"`、`decided_by: "模型"` 和网关给的 `model_version`，客户端逐项核对。它是模型判断，不当作已核准的结论，转述时不省略这些披露字段。
- `POST` 在超时（`408`/`504`）或中途断连时不自动重发。遇到 `413 request_too_large` 时裁剪前序上下文或拆分题目，不吞掉错误。拒绝文字里的 `limit (N)` 是同一请求还剩的预算，不是上限。
