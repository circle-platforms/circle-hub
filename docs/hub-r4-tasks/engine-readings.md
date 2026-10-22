# 任务：引擎里模型有两种读法的三处，按所有者的决定统一

`tests/acceptance/oracle/FINDINGS.md` 记着判定规则的参照实现和引擎不一致的地方；其中第 4、5、6 条是模型的两句话可以读成两边，要所有者定夺。所有者 2026-10-22 的决定：评审只提出问题；就算人要追加修改，也只能改自己本地的 Circle，不能修改 Hub 里的文件。据此：

- **第 5 条（主体上的修复行）：维持引擎现在的读法。** 修复只用于待判定产物（模型自己的回答）上的检查；评审主体（被评审的材料）上的反驳停在“不通过”，归作者输入，不进入修复，也不消耗修复轮数。要改参照，不改引擎。
- **第 6 条（“记未知”）：改引擎，照参照。** 动作 `unknown`（记未知）不改终态：一条已经返回的反驳仍是“不通过”，码和档照记，归责留空（待归因，不走“数据缺口”），要求项状态是未满足（终态不符合期望）；记未知既不修复也不拒收。
- **第 4 条（没声明的检查档）：每个检查必须声明档，发布时强制。** 声明了的档替换结局的档，这一点本来就清楚；省略时不再有一个悄悄起作用的缺省档（现在是有 `basis` 就阻断、否则提示，函数返回的阻断会被悄悄降成提示）。

分支和工作树：`hub-engine3`，目录 `circle-hub-engine3`。**开工前先确认 `hub-union` 已经合进 `hub-redesign`**（监督者会在合并后通知；那个任务把三个包的每个检查都写上了明确的 `tier`）：从合并后的 `hub-redesign` 开分支。

- 可以改的路径：`hub/runs/engine/**`、`hub/rules/**`、发布 `checks.json` 的校验所在的文件（先找：`pack publish` 校验检查条目的地方）、`contracts/src/pack.ts`（只改 `tier` 的说明文字，不把 `tier` 在解析层改成必填，已发布的旧版本照常读）、`contracts/model.json` 里 T03 R[4] 与 W02 F[7] 的文字（改后 `node tools/gen-contracts.ts` 重新生成并 `--check`）、`tests/acceptance/oracle/**`、`docs/hub-r4-architecture.md` 第 6 节的一句原则。别的路径不动；`docs/hub-r4-progress.md` 由监督者改。
- 先读：`AGENTS.md`、`docs/hub-r4-handoff.md`、`tests/acceptance/oracle/README.md` 和 `FINDINGS.md`（全文）、`oracle.ts`、`differential.test.ts`、`hub/runs/engine/terminals.ts`（`applyRouting`、`rowApplies`、`BY_REASON`）、`hub/rules/check.ts`（`runCheck`、`withTier`）。
- 规则：不推送、不建 PR；不发布、不部署，不碰 7420 上的持久部署、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；提交只暂存明确的路径，`git commit -s`，一句首字母大写的英文祈使句，不加前缀和句号，空一行后写你自己的署名行。每一条单独一个提交。

## 要做的

1. **第 6 条。** 先把 `differential.test.ts` 里种子 `20261222`（`recorded`）的断言翻成参照的结论，看它失败，再改 `applyRouting`（约第 220 行）让动作 `unknown` 不改终态、不写 `integrity_unproven`、不走 `BY_REASON` 的数据缺口，归责留空。引擎自己的单元测试里钉着旧行为的断言一并改，并说明理由。
2. **第 5 条。** 改参照 `oracle.ts`：修复行只用于待判定产物上的检查；主体上的反驳停在不通过，归作者输入，`rounds.used` 不增加。翻 `differential.test.ts` 里种子 `20261222`（`short`）的参照断言；引擎不动。`contracts/model.json` 里 T03 R[4] 与 W02 F[7] 各加一句清楚的话：“修复只用于待判定产物上的检查；评审主体上的反驳停在不通过，由作者在自己本地修改，Hub 不修改被评审的材料”；`docs/hub-r4-architecture.md` 第 6 节加同义的一句原则（评审只提出问题）。只改文字，不改模型的结构。
3. **第 4 条。** 发布时检查条目没有 `tier` 就拒绝，错误里写任务包、检查的编号和怎么改（声明 `blocking`、`advisory` 或模型里的其他档名）；发布测试：缺 `tier` 被拒，补上被收；仓库里所有包的 `checks.json` 都通过（用一个遍历所有包的测试）。运行时对发布这条规则之前已发布的旧版本保留现有的缺省（有 `basis` 就阻断、否则提示），在 `hub/rules/check.ts` 里写明这是旧版本的兼容，并用一条测试钉住；`differential.test.ts` 里种子 `20261223` 的 `loose` 场景改成钉住“发布拒绝”和“旧版本缺省”，从随机生成的空间里拿掉没有 `tier` 的检查。
4. **FINDINGS.md。** 第 4、5、6 条的状态改成已定/已修，写明日期、决定内容和改了什么；表格里的断言行号同步；“模型没有排定的地方”里把这三项从待所有者定夺里划掉，剩下的照旧列着，不要替所有者定别的。
5. **验证。** `npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2 "hub/runs/**/*.test.ts" "hub/rules/**/*.test.ts" "contracts/**/*.test.ts" "tests/acceptance/oracle/*.test.ts" "packs/**/pack.test.ts"`；`node --test --test-concurrency=1 tests/acceptance/*.test.ts`（先看 `package.json` 的验收脚本怎么跑；负载高时单个文件会变慢，单独重跑确认）。

完成后在终端里回报：提交号、测试通过/跳过/todo 的数量、改动了哪些旧断言及理由、没做完或拿不准的地方。
