# 任务：评审终稿——分块取最差的整体结论和中文报告（方法第 6、7 步）

评审方法的第 6 步（报告由初评方用中文写，材料取自复核方）和第 7 步（大文档分块，整体结论取各块最差：FAIL 重于 PARTIAL 重于 PASS）现在只写在两个评审包的 SKILL 里，Hub 既不算也不核对：`packs/workflow/case-review-verify/README.md` 的 Limits 写着整体结论 “is the report's, not a Hub computation”。可是“取最差”有明确的输入和规则，按 AGENTS.md 应由脚本算（主张上的规则）；架构第 9 节场景 15 也要求分块目标的整体结论是各块最差。真实评审里一份 62 例的文档分两块，各自初评、复核都已受理，但没有整体结论和报告。这个任务补上第三步：一个新的工作流包 `case-review-report`。

- 分支和工作树：`hub-review-report`，目录 `circle-hub-review-report`（依赖已装好，所有命令在这个目录里跑）
- 可以改的路径：`packs/workflow/case-review-report/**`（新包）、`tests/acceptance/**`（新增一个场景文件）、`hub/leases/**`（只做第 0 步）；`packs/workflow/case-review/SKILL.md`、`packs/workflow/case-review-verify/SKILL.md` 和 `README.md` 里关于分块与报告的句子（改完两个包各升一个小版本并重新签）。核心（`hub/runs/**` 等）缺什么就先停下来，把缺口写清楚回报，不要自己改。
- 先读：`AGENTS.md`；架构第 6 节方法第 5 到 7 步和第 9 节场景 14、15；`packs/workflow/case-review-verify/`（`workflow.json` 的 `draft` 输入怎么按 `rec:` 读初评结果、`requirements.json`、`functions/verify.ts` 的结论与处置一致性检查、`final` 主张）；`contracts/src/pack.ts` 的 `WorkflowInput.many`。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行；合并别的分支时用 `git merge --signoff`。

## 要做的

0. 租约续期与释放（C6）的两处收尾，各一个小提交：
   - `hub/leases/README.md` 写明 C6 的语义：`op`、按血缘判持有者、释放不可撤回、血缘窗口 20 层（窗口外按不持有处理，同一个 `LEASE_UNAVAILABLE`，消息里说明血缘）、投影看到的 `mine` 在开始运行时冻结。
   - `extend` 只延长不缩短：到期时刻取“原到期”和“现在加 ttl_seconds”中晚的那个，累计上限不变。先写测试：ttl 比剩余时间短时到期时刻不变。
1. 新包 `case-review-report`（workflow）：
   - 输入：`verifications`（`many: true`，角色 `expected`）：各块复核运行的验证结果 `rec:<摘要>`，每块一个；可选 `target`：被评审的同一份脑图（只用来核对各块属于同一份源文件，不重新评审）。投影按引用读出每块复核结果里的 `final`（结论和等级）、每条处置（证实、推翻、部分正确）和新发现；各块必须是同一份源文件、同一锁定构建，否则整次开始运行被拒，给修正说明。
   - 要求项 `overall`（事实，整次运行一个，生产者是函数）：整体结论取各块最差（FAIL 重于 PARTIAL 重于 PASS），整体等级取各块最差的一块（P7 最差，P0 最好）；依据是各块 `final` 的引用。任何一块没有 `final` 或结论不可读时，整体记未知（缺输入），不猜。
   - 要求项 `report`（判断，初评方写）：槽位 `text`（中文报告全文）、`verdict`、`level`、`findings`（引用各块复核结果里每条证实、部分正确和新增的发现）、`suggestions`（每条写补什么用例、为什么、期望结果）、`gaps`（证据缺口）。检查（阻断，修复 2 轮）：`verdict` 和 `level` 等于 `overall` 算出的值；每条引用都解析到某块复核结果里的证实、部分正确或新增发现（推翻的不能引）；各块的这些发现一条不漏；每条建议三项齐全。各块里的证据缺口没写进 `gaps` 的只作提示。码用包名开头（`case-review-report.<码>`），文字和修正说明用中文。
   - SKILL.md（中文，简短）：什么时候用（各块都复核完以后）、怎么开始运行、按复核方的材料原样写结论和等级、报告里写什么；`examples/start-run.json` 和完整的 `examples/submit-result.json`（合成）；样例分正例和反例；README 写决定、限制和需要别的包做的事。
   - 包签名照其他包（`node packs/workflow/case-review/packaging.ts sign case-review-report`，先看现有用法）。
2. 验收场景（`tests/acceptance` 新增一个文件，合成数据、脚本化模型）：一份目标分两块，A 块复核 PASS、P3，B 块 PARTIAL、P5，整体应是 PARTIAL、P5；报告写 PASS 的被拒并给修正说明；漏一条证实发现的被拒；引用推翻发现的被拒；一致的报告被受理。补的是场景 15 最后一句。
3. 两个评审包 SKILL 里“分块与报告”那一节改成指向新包；`case-review-verify/README.md` 的那条 Limit 改写。
4. 测试先写。验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "packs/workflow/case-review-report/**/*.test.ts" "hub/leases/**/*.test.ts"` 和新场景文件（数据库测试别和别的终端同时跑：macOS 共享内存段只有 32 个）。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
