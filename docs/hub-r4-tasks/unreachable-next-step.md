# 来源读不到时的下一步（R5 A2c）

分支 `unreachable-next-step`。调用方能看到的来源读取失败按 `hub/connectors/errors.ts` 的错误码闭集给出固定出口：缺什么、谁来做、做完怎么继续。不可达和超时对 Circle 是稍后用同样参数重新开始，仍失败则请管理员核对资源地址与网络；管理员命令是 `circle-hub resource show <资源>`。登录过期、登录失败、凭据缺失和凭据被拒指向重新设置凭据或 `circle-hub resource reset-login`。资源名可以出现。地址、令牌和响应体不进调用方文字。保留档位和停用账号仍不对调用方展开内部说明。

`ACCESS_DENIED` 与 `READER_INVALID` 不是调用方可见的读取失败。

可改路径：

- `hub/connectors/errors.ts`
- `hub/connectors/read-exit.ts`
- `hub/connectors/read-exit.test.ts`
- `hub/connectors/connectors.ts`
- `hub/connectors/read.ts`
- `hub/connectors/read-retry.test.ts`
- `hub/runs/engine/inputs.ts`
- `hub/runs/engine/projection.ts`
- `hub/dispatch/bed-state.test.ts`
- `tests/acceptance/36-source-unreachable-exit.test.ts`
- `docs/hub-r4-tasks/unreachable-next-step.md`

不改 `docs/hub-r5-tests.md`。合成数据，产品内容为 ORBIT/COMET 与验收床上的合成产品。不连接真实系统，不读环境配置，不使用钥匙串。
