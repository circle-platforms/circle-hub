---
name: recompose
description: 把作者写的测试脑图重组成编写阶段能用的记录：每个用例一份契约，加改写、具体化和缺口。把整份脑图编译成自动化用例之前先用它；需要这份脑图在敏捷平台上的文档号。
---

# 脑图重组

把作者写的测试脑图重组成编写阶段能用的记录：每个用例一份契约，加改写、具体化和缺口。这一步是搬运，不是创作。

本地工具由客户端装进技能目录（通用根 `~/.agents/skills/<包>/`；装好的目录即下文 `<技能目录>`，Base directory 由客户端在加载时给出）。`%HUB_URL%` 是 Hub 的 MCP 端点基址，`%HUB_TOKEN%` 是 Bearer 令牌：模型只写占位符名字，值由客户端执行时展开。

一次处理一整份脑图。Hub 已经按树位置读出用例原句（意图、动作、期望），在运行记录每个条目的 `fields/atoms` 里，Hub 不调模型。

## 铁律

1. **零发明。** 契约里的意图和期望必须是作者原文，工具会逐字取出，你不用重打。作者没写的知识不进契约，写进缺口。
2. **搬运，不是重新表述。** 知识常常写错了位置：验证方法写在步骤里，结果写在标题里。把它们对应起来，不要重新表述。
3. **不丢东西。** 作者写的否定、条件、差异和命令都要留下。可以改命令的参数，不能删命令，也不能加作者没写的对象或动作。
4. **和环境无关。** 记录里不写设备、座位和环境地址。换成环境地址是编写阶段的事。
5. **说不清就写缺口。** 缺口是这一步的产出，不是失败。一个诚实的缺口比一个像样的编造好。

## 步骤

1. `start_run` 用 recompose，绑定 subject（同一份脑图）。product、build 和 version 写在 start_run 顶层，和之后编写用同一个构建：重组记录只对同一棵锁定的知识树有效。用例和 case-compile 取的是同一批：带 autoid、没有声明不自动化的。
2. 先把运行整份取到本地（<目录> 为工作目录下的新目录），再用文件工具读每个用例的 `items/<序号>.json` 里的 `fields/atoms`，不逐条用 get_nodes 读 `rec:<运行记录>#/items/<序号>`：

```sh
node <技能目录>/tools/download-run.ts --hub %HUB_URL% --run <运行号> --out <目录> <<'EOF'
%HUB_TOKEN%
EOF
```

   `sources.json` 列出绑定的源，`sources/<摘要>` 是原件原字节，都已核对摘要。锁定根的命令树和手册也在这次下载里：`knowledge/` 下每个顶层节点一个文本文件（`# <路径>` 一块，条目原文后面跟它的“引用”行），在本地读和搜，引用照抄，不逐页用 get_nodes 读 `tree:<根>/...`。
3. 每个用例写一个文件 `<目录>/NN.json`，只写需要判断的字段（见下）。作者的步骤和手册冲突的，先照“作者的步骤和手册冲突”一节问用户，再写文件。
4. 执行下面的命令。工具补全机械字段，整份一次提交：

```sh
node <技能目录>/tools/submit-records.ts --hub %HUB_URL% --run <运行号> --model <模型> --records <目录> <<'EOF'
%HUB_TOKEN%
EOF
```

5. 读答复。被拒的用例按修正说明改文件后重交。每个用例都要有文件，全部通过这次重组才完成。
6. 编写时把运行记录的 `rec:` 绑到 `recomposition_run`，把本运行号写到 `recomposition_result`。

## 用例文件

```json
{
  "item": "<条目编号>",
  "method": {"kind": "declared", "text": "怎么验证", "sources": ["<用例原句或树的引用>"], "basis": "为什么这样验证"},
  "slots": [{"atom": "a4", "knowledge_location": "has_verification_knowledge", "evidence": [], "proposal": null}],
  "states": [{"atom": "a2", "state": "missing_prerequisite", "reason": "缺什么", "prerequisites": ["要先做什么"]}],
  "adapted": [{"atom": "a2", "action": "structural_completion", "text": "改写后的步骤", "commands": ["完整命令行"], "equivalence_reason": "为什么等价", "equivalence_refs": ["tree:<根>/commands/..."]}],
  "concretizations": [{"slot": "e1", "value": "具体值", "value_ref": "<来源引用>", "source_kind": "catalog"}],
  "unknowns": [{"missing": "缺什么", "next_action": "下一步", "audience": "编写模型", "due": "编写提交之前"}]
}
```

除 `item` 和 `method` 外都可以省略。没提到的用例原句算 `settled`。

- `method.kind`：`declared` 作者写了验证方法；`recomposed` 方法在别的位置，你把它搬来；`missing` 确实没有，这时 `unknowns` 必须写明。
- `knowledge_location`：`has_verification_knowledge` 期望可以判断；`recomposable_from_elsewhere` 判断依据在别处，`evidence` 写来源；`genuinely_missing` 真的没有，`proposal` 写缺什么。只有结果标签（如“设置成功”）而没有可判定的观察目标时，写 `genuinely_missing`，不要把标签当判据。
- `states`：`underdetermined` 作者没说清，交给写手选一个能保持原意的写法；`missing_prerequisite` 用例要成立还差前置，写清差什么；`conflict` 作者的两处写法互相矛盾，这种情况要等人决定。
- `adapted.action`：`parameter_change` 改参数；`equivalent_form` 换等价写法；`structural_completion` 补全结构。

## 前置要写全

最常见的失败是前置没人管。功能默认关闭、依赖的对象还没建、查询要先有服务监听，这些手册写着但作者不一定写。读手册，凡是用例要成立却没写的前置，写进 `states` 的 `missing_prerequisite`，`prerequisites` 写清要先做什么。写手靠它补步骤。不要假设环境已经具备：运行器每条用例结束都会清理配置。

## 作者的步骤和手册冲突

作者的步骤要一个取值或写法、期望却是成功，而锁定根的命令树或手册对这个参数的说明把它排除了（例如手册只允许某几种字符，作者给的名字里有别的字符；手册写明两种记录不能同名，作者让它们同名），这是作者步骤与手册冲突。写这条用例的文件之前先交用户裁定：不自己改写，也不照写。作者要测的正是非法输入、期望本来就是被拒绝的，不算冲突。手册那一句在 `knowledge/` 里读到，引用照抄。

只有主代理问用户。子代理不问，把用例、作者原句、手册原句和它的引用写进给主代理的报告。整份脑图的这类冲突攒齐了问一次，每条列出用例、作者原句、手册原句和引用，让用户选：以手册为准，改成手册允许的写法；保留作者原样，这条先不编，待作者裁定。用户另有裁定（例如说手册不对、照原样写）就照他说的。

裁定写进这条用例自己的记录，用记录已有的字段，不另造：该原句的 `states` 里，`reason` 以“用户裁定：”开头、逐字写用户的话，`state` 记 `settled`。以手册为准的，改写后的步骤写进 `adapted`（`parameter_change`，`equivalence_reason` 引用这句裁定），定下的值写进 `concretizations`（`decided_by` 写“用户”，`value_ref` 写手册那一条的引用）。选了先不编的，或问不到用户的（不替用户选），`state` 记 `underdetermined`，`reason` 写清冲突在哪里、用户说了什么（没问到就写没问到），`unknowns` 写明“作者步骤与手册冲突”和下一步“作者或用户裁定”；编写时这条用例用 parameters.exclude 排除，交付时记为作者步骤与手册冲突。不要记成 `conflict`：它要两个有签发权的来源，作者原句和手册都不是，会被拒。

## 命令

`adapted.commands` 写完整命令行，Hub 按锁定命令树解析。命令名不在树里就被拒，改之前先读树。作者写的命令不能丢，只能改参数。
