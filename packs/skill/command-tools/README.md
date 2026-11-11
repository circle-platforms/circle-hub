# 命令工具通用技能包

`functions/modules/command-check/` 是可复用模块。`grammar.ts` 由 `tools/gen-contracts.ts` 从 `contracts/src/command-grammar.ts` 生成，类型在那里检查；`command-policy.ts` 在这里改；`value-domain.ts` 也在这里改：手册对参数取值的说明（取值范围主张）的形状、对引文的机械核对和对字面值的应用，设计见 `docs/hub-r4-tasks/value-domain-claims.md`。

Hub 尚未提供取值范围主张；当前只有接收这些主张的模块和自动化用例检查，无主张时不起作用。模型、契约和 Hub 接收部分见设计页中的提案。

只在这里改模块，不改工作流里生成的副本；改了要升本包版本，再改工作流的 `embeds` 并重签。发布时 Hub 核对内嵌文件等于这里已发布的版本，所以要先发布本包（决定 153、154）。

## 持久化通道与互斥组合

产品命令规则可以声明 `persistence_channels`（命令留下的状态活过运行器每个用例的清理，例如落在设备磁盘、写到对端设备）和 `forbidden_combinations`（产品文档禁止放进同一卷的两组命令）。两者都是锁定命令树的路径前缀，按完整路径段匹配，可选 `with_parameter` 写明某个可选参数给出时才算；不读命令文字，没有正则。模块里 `caseProfile` 把一个用例已解析的命令分到通道和互斥两侧，`volumeOrder` 把有通道命令的用例排到卷尾（其余次序不变），`volumeConflicts` 找出同一卷里两侧都在的组合（可以是同一个用例）。照 InfoTest 的 `persistence.py`（`case_channels`、`order_volume`、`coexist_violations`）；InfoTest 用正则读工作簿文字，这里用已解析的命令身份。测试在 `command-policy.test.ts`。
