---
title: Skill hooks proposal
---

# 技能自带 hooks.json 提案

## 范围

本次只增加本任务页和 `docs/hub-r4-tasks/skill-hooks-proposal.patch`。补丁未应用，不改模型、生成文件、包清单或运行时代码。

## 待所有者决定

当前 `contracts/model.json` 的 `formatProposals.packFiles` 没有包根的 `hooks.json`，所以技能根目录的钩子不能发布。补丁保留所需的模型一条、结构声明、包核对、原样安装检查和 case-compile 钩子及其清单改动；原改动的多段解释注释已删。

选项一是批准新增合法文件位置，再审阅和应用完整补丁；选项二是继续不允许包根钩子。建议先决定通用技能钩子的合法位置，再决定是否保留 case-compile 的提问钩子。Circle 独立任务已改为不给子代理 question，不能把本提案当作该限制已经生效的依据。

case-compile 提案通过会话开始时记下的会话号区分主代理和子代理；同一目录中的多个会话会共享记录。这个做法是否需要保留，随上述决定一起审阅；本次没有启用，也没有转移到别的目录绕过模型。

## 检查和限制

生效树只有本任务页和未应用补丁，没有运行改动；未运行单测。没有改 `contracts/model.json`、`contracts/codes.json`，没有生成或安装依赖，没有访问测试环境或使用者的 Circle 数据。

来源：11-12 任务书 A7，以及 `docs/hub-r4-progress.md` 中 case-compile 3.15.0 所列的待定技能钩子。
