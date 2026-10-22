# 任务：把几条没守住的规矩补上

核对（2026-10-23）发现四处和 AGENTS.md 不符的代码，都不改行为语义。

- 分支和工作树：`hub-hygiene`，目录 `circle-hub-hygiene`（依赖已装好）
- 可以改的路径：`contracts/model.json`（只加第 1 条的词表轴）、`contracts/src/records.ts`、`contracts/src/pack.ts`、`contracts/generated/**`（只经生成器）、`hub/leases/**`、`hub/rules/check.ts` 及其测试、`tests/**`、`packs/**`、`scripts/real/**` 里的测试和样例（第 4 条）。别的路径不动。
- 先读：`AGENTS.md`（枚举只来自 `contracts/generated`；样例地址用 192.0.2.0/24；不强行兼容）；`contracts/README.md`（改模型以后怎么重新生成，生成物的差异交给合约负责人看）；`node tools/show-element.ts D04`。
- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`，合并用 `git merge --signoff`）。每条一个提交。

## 要做的

1. **租约操作进词表。** `LeaseDetail.op`（`contracts/src/records.ts`）和 `lease_requests` 的 `op`（`contracts/src/pack.ts`）现在是手写的五个值。模型词表加一个轴 `lease_op`：`acquire` 取得、`extend` 续租、`release` 释放、`force_release` 强制释放、`take_over` 接管（D04 的用语：取得、续租、释放；管理员按原因结束租约是强制释放；到期的行被原子地接过来是接管），带一条变更记录写明来源（这次核对）。`npm run gen:contracts` 重新生成，两处改用生成的 schema；`lease_requests` 只接受前三个值。测试：词表一致性测试通过，未知值被拒。
2. **样例地址。** `tests/acceptance/12-console-security.test.ts` 里的 Origin 用了 192.168.1.100，改成 192.0.2.0/24 里的地址；顺手在仓库里查一遍别处还有没有 192.0.2.0/24 和 2001:db8::/32 以外的私网地址（`foundation/` 和 `references/` 不动）。
3. **去掉没声明档时的回退。** `hub/rules/check.ts` 里 `declaration.tier ?? (basis ? 'blocking' : 'advisory')` 是给发布前不声明档的旧包留的；现在发布时已经强制声明（`checks.tier_missing`），运行时再遇到没有档的检查，按检查出错处理：未核对，原因“检查出错”，归责“生产者错误”，管理员日志里写明缺档，不猜档。测试：缺档的检查得到这个终态；有档的照旧。
4. **测试和样例里的真实编号与构建名换成合成值。** 集成者在终端里另给你一份清单（不进 Git）：几个取自真实系统的缺陷号和文档号，以及真实版本线（10.3 到 10.5）的构建名出现在哪些文件里。换成合成值时保留形状：两族名字、`Rel`/`Beta`、NSAE 基于 APV 的写法、编号位数；换完测试照过。合成的版本线用 10.6 以后的号（仓库里已有 10.6、10.7、10.9 的合成样例，沿用它们）。
5. 验证：`npx tsc --noEmit`；`npm run verify:contracts`；`node --test --test-concurrency=3` 对改过的路径（数据库测试别和别的终端同时跑）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
