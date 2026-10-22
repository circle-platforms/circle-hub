# 任务：`test-bed` 任务包（设备管理包的 P2 到 P5）

核心已经落地：租约（取得、按血缘续期和释放见 `device-lease-ops.md`）、管理员命名文档 `doc:doc:<名字>`、运行上下文里的租约视图、`lease_requests`。P1 的纯函数（清单校验、环境事实、选台架）在 `packs/workflow/test-bed/functions/`。这个任务把它们装成一个能用的工作流包，并用真实 Circle 客户端验收。设计在 `docs/hub-r4-device-pack.md`，复核在 `docs/hub-r4-device-pack-review.md`。

- 分支和工作树：`hub-test-bed`，目录 `circle-hub-test-bed`
- 可以改的路径：`packs/workflow/test-bed/**`、`scripts/real/accept/` 里新增的 `test-bed.ts` 场景及其测试、`tests/acceptance/` 里新增的 `25-test-bed.test.ts`。别的路径不动（核心有缺口就在回报里写，不要自己改）。
- 先读：`AGENTS.md`、`docs/hub-r4-device-pack.md` 全文、`packs/workflow/test-bed/README.md` 和 `functions/`、`packs/workflow/case-location`（只产生事实、不绑产品线的工作流包的写法：`pack.json`、`workflow.json`、`requirements.json`、`checks.json`、`slots.schema.json`、`SKILL.md`、`README.md`、`examples`、`samples`、`packaging.ts`、`pack-files.ts`、各种 `*.test.ts`）、`hub/server/docs.ts`（命名文档的读法和 `accepts: ["doc:doc"]`）、`tests/acceptance/24-lease-start-run.test.ts`（租约场景的写法）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据（地址只用 192.0.2.0/24 和 2001:db8::/32）；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。

## 要做的

1. **一个任务包 `test-bed`（工作流包，不绑产品线，只产生事实）。** 输入槽 `inventory`：命名文档（`accepts: ["doc:doc"]`，json@1 解析器），缺省用户写 `doc:doc:bed-topology`；参数 `action`：`search`、`facts`、`acquire`（`extend` 和 `release` 等 `device-lease-ops.md` 合并后再加），`need`（对象，形状同 P1 的 `matchNeed` 的需求：设备类型和数量、构建、小时数）、`bed`（台架名）、`hours`、`addresses`（要几个地址，在哪个网段）。声明 `context: ["leases"]` 和 `leases: { prefix: "bed/", max_ttl_seconds: 28800 }`（单次最多 8 小时；累计上限 24 小时放在续期那一步）。
2. **投影。** `search`：每个满足设备数量和类型的台架一个条目，结论写空闲状态（只写“Hub 记录里空闲（未排除本地操作）”或最早空闲时刻）、构建是否一致（声明来源）、缺什么；`facts`：每个台架一个条目，写监听候选、盲地址、后端候选、空闲地址数；`acquire`：选定台架（`bed` 参数）或按 `need` 取最佳匹配，投影返回 `lease_requests`（键 `bed/<台架>/<设备>`，要地址时再加 `bed/<台架>/ip/<地址>`；期限 `hours` 换成秒，超过上限被核心拒绝）；取得失败由核心拒绝（`LEASE_UNAVAILABLE` 带最早空闲时刻）。读清单时先用 P1 的 `parseManifest`，清单有问题就整份拒绝并指出位置。
3. **检查与样例。** 照 `case-location` 的写法：每个检查声明 `tier`，每个检查有正反例样本（发布校验要求）。
4. **说明。** `SKILL.md`（模型读的规程：先 `search` 再 `acquire`，结论里“Hub 记录里空闲（未排除本地操作）”这句限定必须原样转述，版本只是管理员在清单里声明的）、`README.md`（决定、限制）、示例清单（合成，放 `examples`，不含真实地址和设备名）。
5. **验收。** `tests/acceptance/25-test-bed.test.ts`：管理员用 `doc put` 发布合成清单；用户 `search`、`acquire` 成功；第二个用户同一台设备被拒并带最早空闲时刻；`facts` 的监听和盲地址正确；清单有重复地址时整份拒绝；未分配该包的人得到“对你不可用”。`scripts/real/accept/test-bed.ts`：真实 Circle 客户端场景（脚本化的模型发工具调用），用于监督者在已部署的 Hub 上验收；合成测试覆盖它的检查逻辑。
6. **发布。** 包要能通过 `circle-hub pack publish packs/workflow/test-bed --stage`（先在测试里用现有的发布测试夹具验证）；`pack.json` 签名用 `packaging.ts`。
7. 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/workflow/test-bed/**/*.test.ts" "scripts/real/**/*.test.ts"`；`node --test --test-concurrency=1 tests/acceptance/25-test-bed.test.ts`（数据库测试不要和别的终端的同时跑）。

完成后在终端里回报：提交号、测试数量、核心缺口（要核心改什么才能做的事）、没做完或拿不准的地方。
