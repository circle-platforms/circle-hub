# B1 运行器合约读取审计

范围：case-compile 的 block-runtime.ts 及它调用的 runtimeMethod/sourceDocument、blocks/block-restore。只读核对导出器结构；未运行、导入或复制 InfoTest 实现或业务值。初查基线为 6ea6511b；现已同步 cursor 的 6d8b225f / case-compile 3.8.3。该提交将 checkpoint_two_argument 加入闭集 RUNTIME_ADDITIONS；本分支没有改 runtime-contract.ts。

## 直接读取的 runtime 字段

| 路径 | 读取处 | 原始格式与身份边界 |
| --- | --- | --- |
| runtime.block_model | packs/workflow/case-compile/functions/block-runtime.ts:9–11 | B1 的 @2 声明，当前 stripAdditions 在 runtime-contract.ts:66–76 删除整个成员，包含全部嵌套字段 |
| runtime.checkpoint_two_argument | block-runtime.ts:55 | B1 新增声明；现由 cursor 的 RUNTIME_ADDITIONS（runtime-contract.ts:55）完整剥离。原导出器里的同名字符串是条目 dispatch 的分支，不是 runtime 同名字段，不能混为一谈 |
| runtime.found_times_supported | block-runtime.ts:56 | 原始 runtime 字段，应保留在原身份中。InfoTest_Engine/main/case_compiler/excel_contract.py:515 导出此键；Hub runtime-contract.ts:99 本来就要求它是布尔值。false 不能因添加块能力而被改成 true 并沿用旧身份 |

结论：逐个核对这三个读取后，**未发现第三个“原始格式没有、B1 读取、又未剥离”的直接 runtime 成员**。此结论限于表中源文件与当前版本，不代表执行器实际实现了这些能力。缺能力仍记 unknown、不能派发。

## block_model 内嵌成员

这些字段属于整块被剥离的 @2 声明，不进入原件身份；它们仍进入 @2 合约自己的内容摘要。

| 成员 | 消费结构与检查 |
| --- | --- |
| schema | block-runtime.ts:11 与包 tables/blocks-format.json 的 runtime_schema 完全相等 |
| default_assertion.{object,method} | :16 选择默认断言，必须对应 profile 的唯一 literal_assertion 调用 |
| operators[].{op,expected,object,method,matching} | :19–23 按断言族及 literal/register 来源精确选择一个映射 |
| differs.{object,method,matching} | :19–23 必须 exact_text；不以正则型 not_found 代替全文不等 |
| output_methods[].{object,method,output} | :35–38 机械核对应调用产生完整原文，不从方法名字猜输出 |
| reserved_registers、capture_registers | :39–41 名称冲突与 H 列捕获能力 |
| checkpoint_expected_register、checkpoint_result_register | :57–58 检查点 H/I 寄存器能力 |
| restore_registers | :46 还原必须显式开启 |
| restore_methods[].{object,method,raw_input,complete_command_parse,role_checks,effect_scope_checks,root_parameter} | :44–50 发送前完整语法、角色、范围及锁根守卫 |
| restore_methods[].target_parameter | block-restore.ts:28–34 另由恢复准备读取，写入确定的目标路径、前导参数、自动化测试环境与冻结清单摘要；不是回显解析 |

## 条目、配置与计划字段

- 原条目：runtimeMethod 取原 e/f 对应的 object/method；block-runtime.ts:45 从原 signature.parameters 读 name/kind；这些都是原字段，不能剥掉。InfoTest_Engine/main/case_compiler/excel_contract.py:1138 的 checkpoint_two_argument 为 dispatch 枚举分支，也不是新增字段。
- @2 条目：:47、:61–62 读取 authority.parameters[name].role、type.declaration.catalog_type，及 authority.effects[].command_scope。authority 是 reader 从 typed_authority 和顶层 types/roles/effects 解析而来；这四处新增声明已由 stripAdditions 删除。没有额外在原条目顶层读取 B1 私有字段。
- profile：block_model、allowed[].object/method/parameters 是独立发布配置，不是原合约字段，不应从原身份“剥离”。配置与 @2 合约均须冻结摘要。
- 计划：output/save_as/block_kind/restore_for/keywords、operator/count/register/actual_register/comparison 都来自结构解析后的块模型；不来自运行器原合约，也不由设备回显推断。
- catalog.root 是 Hub 锁定命令树依据；对象闭集来自原 objects。这两者不能用模型自报或任意字段替代。

## 验证注意

testing/typed-fixtures.ts:8–14 的 signTypedRuntime 会重算“恢复出来的原合约”摘要。它适合创建合成新原件，但单靠它不能证明“给既有原件加 @2 声明后原摘要不变”；漏剥字段可被重签的新原件掩盖。迁移身份测试必须先固定独立原件字节和摘要，再加声明、剥离、逐字段/字节比较；不能用同一剥离函数同时生成期望身份和被测身份。cursor 的修复已在 runtime-contract.test.ts 中追加针对固定原件的对照；本分支保留这些断言，不改成自签期望。
