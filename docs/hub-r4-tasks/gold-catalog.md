# 任务：评审里目录类标记的独立答案

依据：`gold-review.md` 页尾答复第 4 条（2026-10-23 更正）：

- 未注入用例上目录类标记（`core.catalog.*`）的独立答案，`gold-case-commands` 给不了，它只给命令路径，不给命令行和参数；
- 所以 gold-review 里这类标记只按条数报，记为“还没有独立答案”；
- 另开一件，自己解析命令树，核对模型引用的那些命令行。这一件就是那一件。

要比的 Hub 标记：`case-review` 的 `cited_commands` 要求项判定为反驳、带归责、`qualifier.source_role` 是 `subject` 的那些（`packs/workflow/case-review/checks.json` 34–43 行，表 `tables/cited-commands.json`）。下面两类不算：

- `command_claims` 判的是模型自己的陈述，不算 Hub 的标记；
- `case_commands` 默认关闭；运行里开了才比。

- 分支和工作树：`gold-catalog`，目录 `circle-hub-gold-catalog`（从 gold-review 开出，依赖已装好；合并时排在 gold-review 后面）
- 可以改的路径：
  - `scripts/real/gold/catalog-marks.ts`（新文件）和它的测试；
  - `scripts/real/measure-review.ts` 里报目录类标记的那一段，和 `scripts/real/measure-review.test.ts` 里对应的测试。

  用法写在新文件的文件头里，照 `command-diff.ts` 的写法。

  别的路径不动。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后；`git commit -s`）。所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作。
- 独立性：
  - 不导入 `hub/**` 和 `packs/**`；
  - 可以复用别的金标准脚本，例如 `scripts/real/gold/compile-check.ts` 的命令树解析和参数核对，或 `command-diff.ts` 的 XML 读取；
  - 匹配规则（NFKC、大小写不敏感、空白折叠、开头解析不到目录命令的引文不判）照 `tables/cited-commands.json` 的文字自己实现。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=1 'scripts/real/gold/**/*.test.ts' scripts/real/measure-review.test.ts`。

## 要做的

1. **独立答案**：`node scripts/real/gold/catalog-marks.ts --tree <锁定根的命令树原件> --source <脑图原件> --run <run show 的 JSON> --out <目录>`。
   - 对每个未注入用例：取模型在发现里引用的命令行，先核对它们确实逐字出自这个用例（照表里的匹配规则）；
   - 再用命令树自己判：开头能不能解析到目录命令，参数个数、类型、取值范围符不符合某个签名；
   - 得出每一行应有的码：`not_member`、`param_out_of_range`、`param_type_mismatch`、`arity_mismatch`，或者不判。
2. **和 Hub 比**：按条目和命令行逐条比 Hub 的反驳。
   - 结果分三类：一致、Hub 漏了、Hub 多了。
   - 反向用例上预期的反驳单列，不算标记。
3. **判不了的不当成通过，也不当成未知**：
   - 遇到不认识的参数类型、解析不了的约束，写一份按位置的补证请求，交给集成者；
   - 按设计缺口退出 1。
4. **屏幕和提交的文件只有计数、摘要和通过与否**：逐条明细写进 `--out`，权限 0600。
5. **接进 measure-review**：给了 `--tree` 时，目录类标记那一段改成按这个独立答案计分；没给时照旧报“还没有独立答案”，并写明缺 `--tree`。
6. **测试**（合成的命令树和脑图写在测试里）：
   - 每种码一个正例；
   - 开头解析不到目录命令的引文不判；
   - 引文不是出自这个用例；
   - 反向用例；
   - 三个说谎的假 Hub：漏标、多标、码不对，都要被抓到；
   - 不认识的参数类型退出 1，并给出位置。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。真实数据上的运行由集成者做。
