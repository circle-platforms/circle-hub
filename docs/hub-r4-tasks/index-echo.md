# 任务：索引视图把收窄和截断写成机器可读的字段

缺陷转用例的查重按草稿要用的命令收窄索引（`only=`）。可是索引视图的回答里没有 `only`：包只能从绑定的 URI 里自己解析查询参数。每个键最多列 2000 个条目，超出的被截掉，这件事也只在 notes 里有一句话：包只能靠“正好列到 2000”去推断（`packs/workflow/defect-to-case/README.md` 的 Needs）。视图已经回显 `fields`，`only` 和被截断的键也应当这样给。

- 分支和工作树：`hub-index-echo`，目录 `circle-hub-index-echo`，从 `hub-derived-acceptance` 开出（那里改过 `hub/knowledge/views.ts`；合并次序是先合派生受理，再合这一件）
- 可以改的路径：`contracts/src/views.ts` 和由它生成的产物（照 `tools/gen-contracts.ts` 的做法重新生成，`--check` 要过）、`hub/knowledge/views.ts`、对应的测试和 README。别的路径不动。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `contracts/**`、`hub/knowledge/**`。

## 要做的

1. `IndexView` 加两个可选字段，写法照 `fields`：
   - `only`：请求带了 `only` 时，就是解析后的取值（去重、按码位排序）；不带就没有这个字段。
   - `cut_keys`：条目超过每键上限、被截掉的那些取值，按码位排序；没有截断就是空数组或不写，两者选一种，写进合约说明。
2. 生成视图时照实填写。notes 里那两句说明照留，不要只留字段。
3. 视图的字节不能因为加字段就不确定：同样的请求和根给出同样的字节；已有的测试照旧通过，新加的测试覆盖带 `only`、不带 `only`、有截断、没有截断四种。
4. README 写明这两个字段；`packs/workflow/defect-to-case` 以后改成读字段、不再推断，这一步不在这件任务里，只在 knowledge 的 README 里记一句“消费方”。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
