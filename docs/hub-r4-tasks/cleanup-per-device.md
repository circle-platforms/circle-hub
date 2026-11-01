# 任务：清理配对按设备逆序，照 InfoTest

依据：决定 118（所有者 2026-11-02 的目标"继续修复，直到 circle 成功复现为止"；所有者一贯要求"改的时候一定要看 ces 和 infotest 是怎么做的"）。

在真实自动化测试环境的两台负载均衡设备上复现一条缺陷时，计划依次在两台设备上各登记一个同步对端，清理也按设备先后各撤一条。用例编译的清理配对把所有设备的配置排成一条逆序：第二台的那条配置被运行器自带清理覆盖而跳过，它的显式逆命令剩下来，被判"清理段含没有对应执行命令的额外配置操作"，可计划明明执行过那条命令。InfoTest 的收尾核对（`main/case_compiler/tau_coverage.py`，CES 原样带入）只要后面任一处有逆命令就算覆盖，并记 `ordering_sensitive: False`；多余的清理行不报错。一台设备不会撤销另一台设备的状态。

- 分支和工作树：`cleanup-per-device`（从 hub-redesign d1fe899c3 开出）。
- 可以改的路径：`packs/workflow/case-compile/functions/command-obligations.ts`、`packs/workflow/case-compile/functions/cleanup-per-device.test.ts`（新）、case-compile 升 3.9.11 的版本文件（`pack-files.ts`、`pack.json`、`tables/workbook-format.json`、`pack.test.ts`、`publish.test.ts`、`samples/**`、`README.md`）；`docs/hub-r4-progress.md` 补记决定 118。
- 规则：同前（不推送、不建 PR；测试只用合成数据）。发布经所有者的目标授权，进行中的运行用已锁定的版本，不在一次计划运行和它的核验运行之间发布。

## 做了什么

1. 逆序只在同一设备内约束：每台设备的在用配置从后往前，取这台设备的清理步骤；设备之间先后不限。
2. 运行器自带清理覆盖的配置，它的显式逆命令放在本设备清理段的哪里都接受（剩下的由运行器收尾，InfoTest 的核对也不看顺序）；这时用例自己撤了它，合约支持里不再列为运行器收尾。
3. 剩下的清理步骤若是本设备某条在用配置的逆命令，照实说"不在同一设备的逆序位置"并点名它撤的是第几步哪条配置；只有在本设备撤不了任何在用配置的才说"没有对应执行命令的额外配置操作"。
4. 同一设备内未被运行器覆盖的配置仍按逆序配对，不变。

## 不做

- 不改运行器清理规则（决定 112），不改逆命令的判定（产品声明的逆操作规则、枚举互逆、前导参数）。
