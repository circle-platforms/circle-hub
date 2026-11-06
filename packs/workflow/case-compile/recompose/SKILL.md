# 脑图重组

把作者写的测试脑图重组成编写阶段能用的记录：每个用例一份契约，加适配、具体化和缺口。这一步是搬运，不是创作。

一次处理一整份脑图。Hub 已经按树位置读出每个用例的原子（意图、动作、期望），在 `rec:<运行记录>#/items/<序号>/fields/atoms`，Hub 不调模型。

## 铁律

1. **零发明。** 契约里的意图和期望必须是作者原文，工具会逐字取出，你不用重打。作者没写的知识不进契约，写进缺口。
2. **搬运，不是改写。** 知识常常写错了位置：验证方法写在步骤里，结果写在标题里。把它们对应起来，不要重新表述。
3. **不丢东西。** 作者写的否定、条件、差异和命令都要留下。可以改命令的参数，不能删命令，也不能加作者没写的对象或动作。
4. **和环境无关。** 记录里不写设备、座位和环境地址。换成环境地址是编写阶段的事。
5. **说不清就写缺口。** 缺口是这一步的产出，不是失败。一个诚实的缺口比一个像样的编造好。

## 步骤

1. `start_run` 用 recompose，绑定 subject（同一份脑图）。用例和 case-compile 取的是同一批：带 autoid、没有声明不自动化的。
2. 读每个用例的 `fields/atoms`，再读需要的命令和手册：`tree:<根>/commands/...`、`tree:<根>/manual/...`。
3. 每个用例写一个文件 `<目录>/NN.json`，只写需要判断的字段（见下）。
4. 执行 `node <技能目录>/tools/submit-records.ts --hub %HUB_URL% --run <运行号> --model <模型> --records <目录>`，下一行开始写 here-doc（`<<'EOF'`、`%HUB_TOKEN%`、`EOF`）。工具补全机械字段，整份一次提交。
5. 读答复。被拒的用例按修正说明改文件后重交。每个用例都要有文件，全部通过这次重组才完成。
6. 编写时把运行记录的 `rec:` 绑到 `recomposition_run`，把本运行号写到 `recomposition_result`。

## 用例文件

```json
{
  "item": "<条目编号>",
  "method": {"kind": "declared", "text": "怎么验证", "sources": ["<原子或树的引用>"], "basis": "为什么这样验证"},
  "slots": [{"atom": "a4", "knowledge_location": "has_verification_knowledge", "evidence": [], "proposal": null}],
  "states": [{"atom": "a2", "state": "missing_prerequisite", "reason": "缺什么", "prerequisites": ["要先做什么"]}],
  "adapted": [{"atom": "a2", "action": "structural_completion", "text": "适配后的步骤", "commands": ["完整命令行"], "equivalence_reason": "为什么等价", "equivalence_refs": ["tree:<根>/commands/..."]}],
  "concretizations": [{"slot": "e1", "value": "具体值", "value_ref": "<来源引用>", "source_kind": "catalog"}],
  "unknowns": [{"missing": "缺什么", "next_action": "下一步", "audience": "编写模型", "due": "编写提交之前"}]
}
```

除 `item` 和 `method` 外都可以省略。没提到的原子算 `settled`。

- `method.kind`：`declared` 作者写了验证方法；`recomposed` 方法在别的位置，你把它搬来；`missing` 确实没有，这时 `unknowns` 必须写明。
- `knowledge_location`：`has_verification_knowledge` 期望可以判断；`recomposable_from_elsewhere` 判断依据在别处，`evidence` 写来源；`genuinely_missing` 真的没有，`proposal` 写缺什么。只有结果标签（如“设置成功”）而没有可判定的观察目标时，写 `genuinely_missing`，不要把标签当判据。
- `states`：`underdetermined` 作者没说清，交给写手选一个能保持原意的写法；`missing_prerequisite` 用例要成立还差前置，写清差什么；`conflict` 作者的两处写法互相矛盾，这种情况要等人决定。
- `adapted.action`：`parameter_change` 改参数；`equivalent_form` 换等价写法；`structural_completion` 补全结构。

## 前置要写全

最常见的失败是前置没人管。功能默认关闭、依赖的对象还没建、查询要先有服务监听，这些手册写着但作者不一定写。读手册，凡是用例要成立却没写的前置，写进 `states` 的 `missing_prerequisite`，`prerequisites` 写清要先做什么。写手靠它补步骤。不要假设环境已经具备：运行器每条用例结束都会清理配置。

## 命令

`adapted.commands` 写完整命令行，Hub 按锁定命令树解析。命令头不在树里就被拒，改之前先读树。作者写的命令不能丢，只能改参数。
