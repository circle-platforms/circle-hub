# 任务：影响视图只比命令目录的语法；独立比较补读顶层命令

跨版本线那一对（较早一条线的一个构建到较新一条线的一个构建）的回归范围瘦身以后能跑完了，但 Hub 的影响视图（`changed=definition`）给出 137 条变更路径，独立的命令树比较只有 30 条。集成者用两边各自的解析在同一份原件上核过，原因有三：

1. 手册里的命令签名段落也是“定义”条目（FAMX 产品包 README），而手册是按版本线的。同一版本线的两个构建用同一份手册，看不出问题；跨版本线时，两份手册之间签名段落的增删改都算成了命令定义的变化。这样多出 96 条路径；另有 10 条路径，构建的命令树里已经删掉了命令，手册里还写着，于是被算成“修改”而不是“删除”。
2. 命令树条目的签名带着参数的说明文字（`description`），只改了说明的命令也算成了“修改”（7 条）。
3. 独立比较（`scripts/real/gold/command-diff.ts`）不读直接挂在作用域下的命令（单个词的顶层命令），少读了约 39 个命令。其中一个在后一个构建里多了一个可选参数，独立比较因此漏掉了一条“修改”。

只按命令树、只比语法时，同一版本线那一对与独立比较逐条相同（新增 10、删除 1、修改 1）；跨版本线那一对的新增 14、删除 11 逐条相同，修改除了独立比较的 5 条，还多出第 3 点那一条。

两部分分别指派，互不依赖；B 的答案不能看 A 的代码。

- 规则：同前（不推送、不建 PR、不发布、不部署，不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，照真实结构做，不带真实内容；`git commit -s`，合并用 `git merge --signoff`）。

## A. 影响视图按目录比（分支 `hub-impact-catalog`，目录 `circle-hub-impact-catalog`）

- 可以改的路径：`hub/knowledge/**`（影响视图）、`contracts/src/views.ts` 和 `contracts/src/tables.ts`（视图的参数与输出、catalog-entry@1 里哪些字段算说明；改合约先回报改法）、`packs/workflow/regression-scope/**`、`packs/workflow/maintenance-sweep/**`、`scripts/real/accept/regression-scope*.ts`、`scripts/real/accept/maintenance-sweep*.ts`，以及对应的测试和 `tests/acceptance/**` 里用到影响视图的场景。别的路径不动。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=3` 对 `hub/knowledge`、两个包、`scripts/real` 和改到的验收场景（数据库测试别和别的终端同时跑）。

1. 影响视图加参数 `catalog=<目录>`，例如 `catalog=commands@1`：只有这个目录的成员算变更。成员按各自的根读，目录的种类和生产器取自产品包对那个根的声明，读法和 `hub/knowledge/read.ts` 读目录时一样。哪个根没有这个目录，视图就写明“没有目录 X”，不猜。
2. 成员是否“修改”按语法比：把 catalog-entry@1 里的说明性内容去掉以后再比，只有说明不同的不算变更，可以在 notes 里计数。哪些字段算说明，在 catalog-entry@1 的合约里写明（参数的 `description`、条目的 `summary`），视图照合约去掉，不按产品写死。引用（每个根不同）和签名的 `id` 也不参与比较；签名按集合比，只是重载换了顺序不算变更。（与 kimi 10-23 商定：哪个根没有这个目录，视图不回答并写明原因，不回空的变更表；带了 `catalog` 时 `changed` 可以不写或等于目录的种类，写别的种类就拒绝；`catalog=commands@1` 照写可解析。）
3. 视图输出写明用了哪个目录（新字段，合约里写说明）。`changes` 里的 `before`、`after` 仍是条目摘要，引用照旧能解析。
4. 回归范围和维护巡检：README 和 SKILL 里给的外部标识改为带 `catalog=commands@1`；绑定的视图没写目录时，结论里加一句提示（只按种类比，可能混进别的生产器的条目）。两个包各升一个小版本，重签。
5. 场景 `regression-scope.ts`、`maintenance-sweep.ts` 改用新的外部标识。
6. 测试先写，用合成的两个根：
   - 另一个生产器在同一路径上有“定义”条目、两边不同：不算变更；
   - 只改了参数说明：不算变更；
   - 改了默认值，或加了一个可选参数：算修改；
   - 命令从目录里删除，另一个生产器在那条路径上还有定义：算删除；
   - 同一版本线、跨版本线各一例。

## B. 独立比较补读顶层命令（分支 `hub-gold-toplevel`，目录 `circle-hub-gold-toplevel`）

- 可以改的路径：`scripts/real/gold/command-diff.ts` 和它的测试。别的路径不动；不导入包或核心的函数，不看 A 的改动。
- 验证：`npx tsc --noEmit`；`node --test --test-concurrency=2 "scripts/real/**/*.test.ts"`。

1. 作用域下直接挂的命令（`scope > item`，前面没有菜单）要读成 `/commands/<命令名>`。现在的写法在没有上级词时跳过了它们。
2. 顺带核一遍：除了 `scope`、`menu`、`item`，命令树里还有没有别的包装元素；有的话照包装处理，往下读，不加词。名字前后的空格和多个空格照现在的写法容忍。
3. 重载按集合比：一个命令的各个参数表去掉顺序以后相同，就不算修改；只是换了顺序不算变更。A 部分也这样比。
4. 合成测试：顶层命令的新增、删除和加参数各一例；顶层命令和同名菜单下的命令并存时路径不混；重载只换顺序时不算修改。

每部分完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
