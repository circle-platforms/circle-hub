# 任务：失败归因先对照设备回显，照 CES

依据：决定 118（同一次复现：第一次失败时设备已点名缺的配置"not listed in the synconfig peer configuration"，模型却按心跳时间改计划，白跑一轮作业）。CES `skills/compile-excel/SKILL.md` 第 5 条：失败运行的输出是实际一侧，只用来理解失败；通用模型 V08 假设集：各假设写预测，下一项区分性观察按读执行。

- 分支和工作树：`attribution-from-echo`（从 hub-redesign 9c59f4d3e 开出）。
- 可以改的路径：`packs/workflow/case-compile/SKILL.md`，case-compile 升 3.9.12 的版本文件（`pack-files.ts`、`pack.json`、`tables/workbook-format.json`、`pack.test.ts`、`publish.test.ts`、`samples/**`、`README.md`）；`docs/hub-r4-progress.md`（决定 118 补一句）。
- 规则：同前；SKILL 不超过 8000 字，只删重复句和合成示例，不删规则。

## 做了什么

1. 第 9 步：回显点名的命令或配置先在锁定命令树和手册读到再改计划；回显说明不了的推断（时序、等待）是判断，写明预测，下次在被测命令前加只读观察区分，不符就换假设。
2. 清理段一条写明逆序只在同一设备内约束、设备之间不限（与 3.9.11 的配对一致）；删掉与后文重复的"清理步骤与其他步骤同一形状"一句和两处合成地址示例，SKILL 仍在 8000 字以内。

## 不做

- Hub 不核对归因内容（V08 的假设集尚未实现，见暂缓清单）；不新增设备只读探测工具（直接操作设备的包装器仍等所有者定）。
