# 任务：用例定位的五个目录约定照决定 35 第 18 项改

依据：

- 决定 35 第 18 项（`docs/hub-r4-progress.md`）：五个约定都取“用上”：
  - 自相矛盾的版本层，两个值都留，记成确定的冲突；
  - 目录名里的构建名，算这一层的版本；
  - 混在别的字里的版本作引用，单独的版本标签作版本；
  - “bug to case”后面的编号按缺陷号读，并在 PLM 里核对，没有就记“PLM 里没有”；
  - 版本层以下目录名里的编号，关联到它下面的每一份文档。
- 包现在的做法和这五问的原文：`packs/workflow/case-location/README.md` 末节“Open questions for the owner”，以及“The scheme”第 2、5、7 条。代码：
  - `functions/locate.ts`：版本层 `versionLevel`，结论 `judgmentOf`（自相矛盾现在记未知）；
  - `functions/convention.ts`：只写版本的标签 `pureVersionOf`，写出的构建名 `writtenBuilds`；
  - `functions/ids.ts`：`kindOf` 把 “bug to case” 一族后面的编号读成未标明；
  - `functions/expected.ts`：按编号绑 `plm:story:`、`plm:bug:`。
- 构建名里哪几位是版本线：产品包 `packs/product/famx/functions/naming.ts` 的 `parseBuildName`。前三个数是版本线，其余是构建号；只有三个数时，前两个是版本线。包之间不能互相导入，在本包里照这条规则写一份，测试里拿几种写法和它比。
- “PLM 里没有”：`hub-read-absence.md` 第 1 条把“系统 S 里没有 X（读于 T）”记成确定的观察，绑进运行，检查能读到。那一件合并以前核对不了，所以分两步。
- 模型元素：W01、W02、V01、V03、A01（声明照旧是声明）、A06（未知只作过渡）。`node tools/show-element.ts W02 V01 V03 A01 A06`。模型文字不用改。

- 分支和工作树：`case-location-conventions`，目录 `circle-hub-case-location-conventions`，从 core-fixes 开出（core-fixes 改了这个包的 pack.json、params.ts、README 和测试，现在是 1.3.2；它再有提交时合进来，合并时排在它后面；这一件的目标版本 1.4.0 照旧）。第二步等 hub-read-absence 合并。
- 可以改的路径：
  - `packs/workflow/case-location/**`：functions、checks.json、requirements.json、tables/codes.json、samples、testing/examples.json、SKILL.md、README.md、pack.json、pack-files.ts 和测试；
  - 前导零那一节要的：`packs/product/famx/functions/ids.ts`、`ids.test.ts` 和 FAMX 的 `pack.json`。K1、kb-links、kb-adoc 也重签 FAMX 的 pack.json，以合并后的为准，最后重签。
  - 不碰 `scripts/real/**`。gold-location 正在改独立答案（`scripts/real/accept/case-location.ts`、`location-tree.ts`），`scripts/real/gold/locations.ts` 在 gold-trace 上也在改。两边都合并以后，集成者照这五条对齐独立答案。
  - hub-pack-findings 第 6 条也改这个包（`expected.ts`、`project.ts`）。集成者让两件先后做：本页先合并，那一件从合并后的 hub-redesign 开出。
  - case-review 和 case-review-verify 也把 “bug to case” 后面的编号读成未标明。那两个包改不改，由集成者另排，不在这一件里。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 未知只能是过渡状态，写明缺的事实和下一步动作；
  - 枚举只来自生成的词表；
  - Hub 只核验：编号和文档有没有关系，Hub 不判。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1 "packs/workflow/case-location/**/*.test.ts"`；`node packs/workflow/case-location/pack-files.ts --check`。

## 要做的

1. **自相矛盾的版本层记成确定的冲突**（`locate.ts`、`check.ts`、`tables/codes.json`）：
   - 现在记未知（缺输入）。改成反驳，提示档，新码 `case-location.version_conflict`，when 和 fix 写进 `tables/codes.json`。
   - 两个值都留：`version` 照旧取离根最近的那个；data 另列每个值和它所在的目录标签（自根向下第几层、原文）。陈述先写冲突，再写已知的部分。
   - 修正说明写下一步：整理敏捷平台目录的人把文档放到一条版本线下；或者开始运行时用参数 `line` 声明，结论标为声明。
   - 调用方声明了版本线、树又自相矛盾时：码用 `version_conflict`，声明和哪个值一致写进陈述，不再另记 `declaration_conflict`。README 写明这个先后。
   - 构建候选：两个值各自那条线的候选都列出，分开写，陈述先说目录自相矛盾。
   - 测试：几个版本线节点；发布火车属于别的版本线；只写版本的标签和版本线节点不一致；再各加一个声明的版本线（和其中一个一致、都不一致）。`locate.test.ts` 里原来期望未知的这几行改成期望反驳；`candidates.test.ts` 加两条线都列出的一行。
2. **目录名里的构建名算这一层的版本**（`convention.ts`、`locate.ts`）：
   - 目录标签里写了这条产品线名称族的构建名（`writtenBuilds` 认的那种；旁边有别的字也算，例如 `Rel_FAMY_10_9_1_37 回归`），这个标签就是版本标签。它和只写版本的标签同一条规则：在版本层里，算版本层的版本，参与一致性判断；在版本层以下，照旧只当引用。
   - 版本取构建名的版本线，照 `parseBuildName` 的规则。构建名照旧列进 `build_names`；notes 写“版本取自目录名里的构建名 X”。
   - 别的产品的构建名不算版本，照旧只记一条说明。
   - 测试：只靠一层构建名目录定版本（现在是未知，改后是支持、置信度高）；构建名和版本线节点一致、不一致（不一致就是第 1 条的冲突）；只有三个数的构建名；别的产品的构建名；版本层以下的构建名。
3. **混在别的字里的版本作引用，单独的版本标签作版本**：照现在，判定不改。
   - 这种条目仍是未知（缺输入）。陈述和 `data.missing` 写明缺的是“目录里的版本层”，下一步同第 1 条。
   - 测试：现有的 `802.1Q VLAN`、`FAMY_10.9.1.37_专项` 这类行，再断言陈述里有缺的事实和下一步。
4. **“bug to case”后面的编号按缺陷号读**（`ids.ts`、`expected.ts`）：
   - “bug to case” 一族（连同现有的几种错拼）后面的编号读成缺陷。`PLM` 后面的照旧未标明。“bug to case-需求<编号>”这种紧挨着另一个词的，照旧以挨着编号的那个词为准。
   - 期望来源照缺陷绑 `plm:bug:<编号>`，理由写“标题里“bug to case”后面的编号，按缺陷号读”。
   - 测试：`ids.test.ts` 里 “leaves the numbers after "bug to case" and PLM unmarked” 那条拆成两条（这一族读成缺陷；PLM 照旧未标明）；`locate.test.ts`、`expected.test.ts` 里对应的行；警告 `id_kind_unknown` 不再数这一族的编号。
5. **版本层以下目录名里的编号，关联到它下面的每一份文档**：照现在，判定不改。还没有“同一个目录下两份文档都带上这个编号”的测试，就补一条，文档粒度和用例粒度各一。
6. **文字、样例和版本**：
   - `requirements.json` 里 location 的说明照新口径写：自相矛盾的记不通过（提示档）；其余定不准的记未知，写明缺什么和下一步。
   - `SKILL.md` 第 3、5 步同改。
   - 样例：`samples/negative/trees-that-are-no-facts.json` 里两个自相矛盾的条目改成期望反驳；加一对构建名目录的正例和反例；`testing/examples.json` 同步。
   - README：末节五问改成“已定（决定 35 第 18 项）”，每问写一行现在的做法；“The scheme”第 2、5、7 条和 Deviations 第 11 条同改。
   - 包升到 1.4.0（core-fixes 的 1.3.1 之后），`node packs/workflow/case-location/pack-files.ts --write` 重签；`pack.test.ts`、`publish.test.ts`、`production.test.ts` 里的版本号和期望一起改。

## 第二步（hub-read-absence 合并以后，集成者通知）

7. **在 PLM 里核对读成缺陷的编号**：
   - locate 检查在 `checks.json` 里声明 `reads`（角色 expected，类型 `plm:bug`），读到绑定的缺陷记录和“PLM 里没有”的观察。
   - 每个读成缺陷的编号给确定的结论：PLM 里有，带上记录标题的原文和引用，让人看得出是不是这份文档的缺陷；PLM 里没有（读于 T）。“没有”是确定的结论，不是未知。读失败的，照 hub-read-absence 的重试和出口走。
   - 测试：有、没有、读失败三种，用 `hub/connectors/testing/plm.ts` 的合成桩；`production.test.ts` 加一个端到端的运行。

## 集成者补的一条（2026-10-23 晚）

- 编号的前导零统一成去零规范化：长度下限照旧（带标记的 2 到 9 位，不带标记的 5 到 7 位，按写出来的位数算）；规范化只去掉非零数前面的零，全是零的串不是编号；数据里同时保留原文写法，显示和引文都用原文。（10-23 晚按审读更正：先前一句“全是零的记成 0”写错了。）
- `packs/workflow/case-location/functions/ids.ts` 和 `packs/product/famx/functions/ids.ts` 用同一条规则，各写测试：0 和 00 都不是编号；0123 规范成 123；带前导零的六位数；“bug 1”照旧不是编号。可改路径加上 `packs/product/famx/functions/ids.ts`、`ids.test.ts` 和 FAMX 的 `pack.json`（K1、kb-links、kb-adoc 也重签这个 pack.json，合并时集成者对齐）。core-fixes 现在发的是 case-location 1.3.2，目标仍是 1.4.0。
- 原因：gold-trace 的终端报告两个包现在一个拒绝前导零、一个保留，追溯和定位会对不上。
- FAMX 的 `ids.ts` 改了以后重签它的 `pack.json`，但不升版本：K1 正把 FAMX 升到 1.2.0，合并时由集成者对齐版本并重签。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
