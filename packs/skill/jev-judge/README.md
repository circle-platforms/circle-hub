# packs/skill/jev-judge

客户端侧 Jev 判断通用技能包（`kind: "skill"`，`schema: "skill@1"`）。包号是 `jev-judge`：`jev` 这个名字被核心代码里的 `hub/jev` 引用占着，知识回注包里也已经有一个叫 `jev` 的技能，所以不用。

## 职责边界

- **只跑在客户端侧**：严格遵守 Decision 15 与 `AGENTS.md`（Hub 永不调用模型）。本包只有客户端模块 `functions/modules/jev-client/`、受守卫的 CLI `tools/jev-judge.ts`、合成示例 `examples/` 和包元数据。
- **和 plumb 技能并列，用法不同**：把 Jev 作为判断器的工作流（自动化用例工作流）自带内嵌的客户端模块 `jev-client`，不需要装本技能；`tools/jev-judge.ts` 的命令行只给集成者已在守卫里放行它的主目录用，放行后也只能把所有者允许的内容放进请求。本包不判断 Plumb 是否就绪，也不替换它。
- **答案是模型判断**：`status` 恒为 `未确认`，`decided_by` 恒为 `模型`，`model_version` 是服务应答里的模型名；没有为任何用途校准过阈值，答案只作核对时的参考，不当作已核准的结论。

## 外发与密钥

- 请求只发往常量 `JEV_ENDPOINT`（`https://api.typesafe.ai/v1/systemone`）：没有选项、命令行参数或环境变量可以改它；测试注入的是传输函数，不是地址。生产传输用 `node:https`，不跟随重定向。证书只设一个选项 `rejectUnauthorized: true`：证书链和主机名照常校验，环境变量 `NODE_TLS_REJECT_UNAUTHORIZED=0` 压不过它；不设 CA、证书、指纹或服务器名这类选项，所以信任的是 Node 自带的根证书，不是操作系统的证书库。
- 外发的就是调用方放进 `state` 和题目里的内容，原样发出；只有所有者允许的内容能放进请求。所有者 2026-11-23 的决定放宽了 2026-10-22 的限制：在选用 Jev 的自动化用例工作流里，原始用例的步骤、已写的命令和手册片段可以发送；这项决定只管这类工作流里的判断，范围外的内容（缺陷、设备输出等）不在其内。
- 密钥只有两个来源：模块的构造参数，和工具 `--key-stdin` 的标准输入第一行。不从 argv、环境变量或文件读（整个包没有读环境变量的代码，测试逐文件核对）；命令行上的 `--api-key` 一类选项一律拒绝。工具只读标准输入的第一行，最长 4096 字节（密钥的上限），读到换行就停，超长就拒绝；整行是 `%名字%` 的形式，说明客户端没有把占位符展开，也拒绝。密钥只进请求的 `Authorization` 头，放在私有字段里，不进任何输出、日志、错误文字和审计记录；应答里出现密钥（或连续 12 个字符）时整份丢弃。
- 客户端上由使用者用 `/secrets JEV_API_KEY` 存密钥；命令里只写占位符 `%JEV_API_KEY%`（here-doc 的唯一一行），由客户端在执行时展开。

## 请求与应答的核对

- 请求先核对再发：题目标识非空、互不相同、1 到 128 个 `[A-Za-z0-9_-]`；题型是 `noul`、`choice` 或 `score`；`instructions` 是非空文本；`noul` 的 `criteria` 只能有 `true` 和 `false`；`choice` 有 1 到 255 个选项，选项名不是纯数字（对象会把这类键提前并改变顺序）；`score` 有 2 到 10 个非空等级；`state` 是文本、数组或普通 JSON 对象，数字有限、文本能编码成 UTF-8，嵌套不超过 64 层；请求体不超过 32 MiB（工具读的请求文件也最大 32 MiB，且必须是 UTF-8）。不认识的字段一律拒绝。不合格就是 `参数无效`（代码 `invalid_request` 或 `request_too_large`），一个字也不发。
- 应答也核对：模型名非空；`usage` 的两个数是非负整数；回答的题目标识和所问的完全一致，同一个键不能出现两次；每道题的类型对得上；每个概率是 0 到 1 之间的有限数且合计为 1（容差 0.001）；单选题的概率键恰是选项、选的项是其中概率最高的一个；评分题的 `legend` 和概率键是 `0` 到 `n-1`、`score` 在这个范围内；`confidence` 在 0 到 1 之间。不合格是 `暂时不可用`（代码 `invalid_response`），不修补、不猜。交给调用方的只有协议字段和披露字段（服务多送的字段丢掉）。应答超过 8 MiB、或不是合法的 UTF-8 的整份丢弃，同样是 `invalid_response`，也不重发。

## 重试、超时与错误

- 只有 `429` 和 `529` 重发，且只一次：等 `Retry-After` 给的秒数（夹在 0.5 到 30 秒之间，缺失或读不懂时等 2 秒）。第二次还是被拒就报错，错误的 `retryable` 为真。
- 超时（默认 30 秒，可配）和连接中断不重发，服务可能已经处理并计费；错误文字写明这一点（代码 `timeout`、`connection_lost`，`retryable` 为假）。
- `401`、`403` 是 `无权限`；`400`、`413`、`422` 是 `参数无效`（保留状态和短代码，不回显请求）；其余没成功的（含 `429`、`529`、5xx、重定向和意外的状态）是 `暂时不可用`。错误文字是 `<类别词>：<事实>。<下一步>。`，不含密钥、请求和服务应答的内容。

错误都是 `JevCallError`，`code` 取下面这个封闭的集合（`JEV_ERROR_CODES`），`status` 是 HTTP 状态（没发出请求时为 0）：

| `code` | 类别 | 什么时候 |
|---|---|---|
| `invalid_request` | 参数无效 | 请求或客户端配置核对不合格，没有发出请求 |
| `request_too_large` | 参数无效 | 请求体超过 32 MiB（没有发出），或服务回 `413` |
| `context_too_long` | 参数无效 | 服务回 `400` 或 `422`，并写明 `max_tokens_exceeded` |
| `request_rejected` | 参数无效 | 服务回 `400` 或 `422`，没有写明原因 |
| `invalid_key` | 无权限 | 密钥没有通过本地检查（为空、太长或含不允许的字符，`%` 也不在内），没有发出请求，不是服务拒绝 |
| `unauthorized` | 无权限 | 服务回 `401` |
| `forbidden` | 无权限 | 服务回 `403` |
| `rate_limited` | 暂时不可用 | 服务回 `429`，重试一次后仍被拒（`retryable` 为真） |
| `overloaded` | 暂时不可用 | 服务回 `529`，重试一次后仍被拒（`retryable` 为真） |
| `service_error` | 暂时不可用 | 服务回 5xx，不重发 |
| `unexpected_status` | 暂时不可用 | 其余状态，含重定向，不重发 |
| `timeout` | 暂时不可用 | 超时，不重发 |
| `connection_lost` | 暂时不可用 | 连接失败或中断，不重发 |
| `invalid_response` | 暂时不可用 | 应答不合格、太大、不是 UTF-8 或出现密钥，不重发 |
| `audit_failed` | 参数无效或暂时不可用 | 审计文件写不进：发请求之前是参数无效，没有发出；应答之后是暂时不可用，答案不交付 |

## 审计

给了 `auditPath`（工具里是 `--out` 目录下的 `audit.jsonl`）时，每发一次请求追加一行 JSON：`ts`、`endpoint_host`、`questions`、`question_types`、`body_bytes`、`body_sha256`、`attempt`、`http_status`、`model`、`usage`、`duration_ms`、`error_code`。没有 `state`、题目、选项和密钥。发请求之前先确认审计文件写得进去，写不进就不发；发出后写不进，答案不交付并报错（服务可能已计费）。

## 嵌入

`functions/modules/jev-client/` 只导入 `node:*` 和本目录的文件，工作流包像嵌入 `plumb-client` 那样嵌入它：在 `pack.json` 的 `embeds` 里加一项 `{ "pack": "jev-judge", "version": "1.0.0", "module": "jev-client" }`，生成的副本放在 `functions/generated/skills/jev-judge/jev-client/`（由 `npm run gen:contracts` 生成，不手改）。导出的接口：`JevClient`（`ask(request)`）、`JevCallError`、`JEV_ENDPOINT`、`JEV_DEFAULT_MODEL` 和 `JevRequest`、`JevResponse`、`JevQuestion`、`JevAnswer`、`JevTransport` 等类型；`JevClientConfig` 里的 `transport`、`now`、`sleep` 是给测试注入的。默认的单次请求时限是 30 秒；工作流需要别的时限时自己传 `timeoutMs`。

## 验证

```sh
node --test --test-concurrency=1 "packs/skill/jev-judge/**/*.test.ts"
node packs/skill/jev-judge/api.ts check
npx tsc --noEmit
```

测试只用合成数据和注入的传输函数，不访问网络。

## 没有核实的地方

字段形状和取值来自此前的 Jev 客户端、TypeSafe 的公开接口说明和已记录的真实应答；选项上限 255、评分等级 2 到 10、请求体 32 MiB 沿用既有客户端的规则，没有对着服务现场核实。服务方改了协议，先改 `validate.ts` 和它的测试。

证书只用 Node 自带的根证书，不是操作系统的证书库，没有指纹固定；`NODE_EXTRA_CA_CERTS` 这类 Node 自己读的启动设置可以增加根证书，不归本包管，测试也没有覆盖。生产传输 `createHttpsTransport` 的地址、选项、超时、大小上限、编码和断连用假的请求函数测过；证书校验另用本机回环上的自签名 HTTPS 服务器测过（拒绝它，也在 `NODE_TLS_REJECT_UNAUTHORIZED=0` 时拒绝它，不送出任何请求头）。没有连过真实服务：第一次真实调用要由集成者放行后在客户端上做。
