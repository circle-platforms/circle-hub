---
name: jev
description: 在 Circle 客户端用 Jev 做是否、单选或打分判断，记录版本和概率；可校准后提出知识归位建议，经独立回注运行交 Hub 核验。用于分类、语义比较和排序，不用于生成内容或证明事实。
---

Jev 只判断，不写字。分类、“两段是不是说同一件事”用 ask；排序给每项一道 score 题，按期望等级排，只作本次任务产出，不回注。不要用它写内容、抽字段、计数、挑设备命令、定期望值，也不要把概率当事实。

技能安装在 `circle-home-skills` 任务的 `scripts/real/circle-home.ts --profile skills` 创建的上机和技能用 Circle 主目录的 `skills/jev/`；下文“技能目录”指这个已安装的 jev 目录。不要装到 `--profile review` 的评审主目录：那里只许六个 Hub 工具和 write_todos，连技能加载也被拒绝。集成者负责准备主目录及数据目录钩子，放行技能工具和 execute 运行 `node <技能目录>/jev.ts`，并在主目录自己的 hooks.json 中再次执行技能的 before_tool 钩子。

所有者在这个 skills 主目录用 `/secrets JEV_API_KEY`、`/secrets HUB_TOKEN` 存密钥，设置普通变量 JEV_MODEL（确切版本）、HUB_URL（Hub MCP 地址）。脚本不读 Circle 文件、环境密钥或钥匙串。密钥和变量不借用评审主目录；技能钩子不能越过主目录的硬拒绝。

用 Node 24 运行，密钥仅从标准输入进，命令里只写 Circle 占位符：

```sh
node <技能目录>/jev.ts ask --hub %HUB_URL% --model %JEV_MODEL% --input ask.json --out jev-results <<'EOF'
%JEV_API_KEY%
%HUB_TOKEN%
EOF
```

ask.json 形状见 [合成输入](examples/ask.json)。pieces 只给 id 和从 Hub 照抄的 tree: 条目或 src: 片段引用；questions 用 noul、choice 或 score，每题必须用 `pieces` 显式声明它判断的片段 id（取自本次 pieces 列表）：缺声明、声明为空或声明了列表外的 id 都是结构问题，整批不发，回报里写明缺的事实和下一步，不会退回“把全部片段都发给这道题”。instructions 里的反引号只给服务商的模型读，技能不从题目文字里找片段；instructions 最多 2000 字，选项说明最多 160 字。问题与说明也会外发，不能夹带用例、缺陷或其他受限原文绕过限制。

默认只发 Hub 读到的定义、行为原文和题目。用例、缺陷、观察或 src 只有本次明确 `--send case`（对应种类码，也可重复 --send；src 用 `--send src`）才加入，技能钩子仅在技能加载后生效；主目录自己的钩子还会再次执行技能的 before_tool 钩子，未加载技能、直接执行时也由它拦住 --send。该主目录由集成者准备。不能用 --send 绕过读取档位。子节点选项说明始终只来自定义或行为，不取用例标题等文字。种类码以 generated.json 为准。

每题显示答案、概率和 Jev@确切版本。requests.jsonl 只记摘要、引用、种类、字节数、尝试和状态；judgments.jsonl 追加题目、候选、概率、模型、用量及复用键，不存原片段正文。answers.json 是本次结果。同样输入复用已完成回答；修改片段只重问依赖它的批次。所有输出在工作目录内的 --out，回执不覆盖。

归位提议走四步。校准、归位可能跑几分钟，用后台任务；完成后读本地结果，重跑用原 --out 复用回答：

1. 已有本构建的根可直接用；否则 `lock --hub %HUB_URL% --product <产品> --build <构建> --out jev-results`。lock 不调用 Jev，不给 --model，标准输入只有 `%HUB_TOKEN%` 一行。读 lock.json 的根。
2. `calibrate --hub %HUB_URL% --model %JEV_MODEL% --root <根> --under <路径> --limit 200 --dry-run --out jev-results`。先把题数和最多请求数给所有者看，认可后去掉 --dry-run，按 ask 的两行方式输入密钥。只用集成者确认在 Hub 停止判断归位以后生产的根；原树条目作金标，排除回注叠加。样例不足或 Wilson 下界未达 0.95 时继续补样例，不出提议。
3. `place --hub %HUB_URL% --model %JEV_MODEL% --root <根> --under <起点> --pieces pieces.json --out jev-results`。文件形状为 `{ "pieces": [{ "id": "p1", "reference": "从 Hub 照抄的 tree: 条目引用" }] }`；也可改用 `--from <路径>` 取该子树、排除起点以下条目。可加 --limit、--dry-run 或本次 --send。已校准、非 none、无并列且达阈值才下走。读 placement.json 的停法和下一步；proposals.json 只收至少下走一层、已得到回答的提议。
4. `submit --hub %HUB_URL% --proposals jev-results/proposals.json --product <产品> --build <构建> --out jev-results`。不调用 Jev，不给 --model，只输入 Hub 令牌一行。遵守回注包 SKILL.md：陈述写 Jev@版本和 p，data 不放概率。脚本上传判断记录，只经 notes 引用（仅提交人和管理员可见）；提交的 model 写 `<确切版本>（Circle 技能 jev，<包 id>@<包号>）`，包号取 start_run 运行摘要的 pack_digest，不取生成快照；根不一致时用新根重跑 place、submit。回执文字原样交付；receipt.json 保留首次回执，后续用摘要命名回执与 receipts.jsonl。未受理时按点名条目改正再跑 place；暂不能补齐的用 `--skip <条目>=<具体理由>` 后重交，不把未入层说成已回注。

密钥缺失或被拒：所有者补存或换密钥再重跑。限流：按等待时间稍后重跑。服务不可用：稍后重跑，已有回答复用。本地估算超出单题预算的条目是确定的排除结果：校准不收该样例，归位不为该条目出提议；只有这类排除时退出 0，不反复重跑。读记录里的条目引用、节点与动作，校准改取其他样例；归位可从 --pieces 去掉该条目，节点选项过多则交集成者调整粒度或选已确认的更小起点。服务拒收为太大时：减少片段或选项说明。超时：本地超时不证明对方没处理，可能已计费；重跑继续。退出 0 表示本次完成；1 表示输入或配置拒绝；3 表示有题或交付未完成，继续上述动作。Hub 只核路径、原文及约束，不采纳概率为事实，不调用 Jev。
