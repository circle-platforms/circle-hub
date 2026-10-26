# 任务：真实评审可以用所有者 Circle 里配置的 GLM 端点（独立复核需要另一个模型家族）

Hub 把名字里有共同词的模型算同一家族，不认作独立；环境配置文件里现在只有千问家族的端点，所以初评之后的独立复核（`case-review-verify`）没法用真实模型做。所有者自己的 Circle 里配了 GLM（`settings.json` 的 `auth`：协议、地址、模型名、密钥引用；`credentials.json` 的 `api_key`），这是所有者配置的端点，评审用 GLM 已在批准的计划里（“Circle 用 qwen 或 GLM 评审”）。这个任务让真实评审的驱动脚本能从那份 Circle 配置取端点。

- 分支和工作树：`hub-glm`，目录 `circle-hub-glm`
- 可以改的路径：`scripts/real/circle-home.ts`、`scripts/real/review-circle.ts`、`scripts/real/lib/**`（及其测试）。别的路径不动。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`scripts/real/circle-home.ts`（`endpointFrom`、`writeHome`）、`scripts/real/review-circle.ts`、`scripts/real/lib/env-file.ts`（密钥只通过 `pick()` 离开，屏幕上只有键名和长度）。
- 要做的事：
  1. 一个只读的取端点函数：从一个 Circle 数据目录（默认 `~/.circle`，用 `--circle-dir` 指定别处，测试用临时目录）读 `settings.json` 的 `auth` 和 `credentials.json` 的 `api_key`，给出和 `endpointFrom` 同形的 `Endpoint`（协议、地址、模型名、密钥、来源说明只写文件名和键名）。`api_key_ref` 指的是 `credentials.json` 里的哪一项（目前就是 `api_key`），不认识的引用要报错，错误里不带任何值。
  2. `review-circle.ts` 加 `--endpoint-from circle --circle-dir <目录>`（与现有的 `--env-file --provider --section` 二选一），其余流程不变；密钥只写进专用 Circle 目录的 0600 文件，屏幕和日志只显示协议、主机名、模型名和密钥长度。
  3. 测试：用临时目录里伪造的 `settings.json` 和 `credentials.json`（假的地址用 192.0.2.0/24 或 example.invalid，假的密钥），覆盖：正常取出、缺文件、缺字段、引用不认识、输出里没有密钥（把密钥当探针检查所有打印的行）、权限不是 0600 时的处理（只警告）。
- 不要运行真实评审，不要读 `~/.circle` 里的真实文件（测试只用临时目录）；监督者会在合并以后自己跑。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "scripts/real/**/*.test.ts"`。
- 提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；不推送、不建 PR；不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统。
- 完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、没做完或拿不准的地方。
