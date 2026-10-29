# 来源原件读取通用技能包（source-read）

通用技能包 `source-read`：在任意工作中按系统包路由读取平台原件（缺陷、需求、构建、脑图文档、构建页、手册文件、SVN 文件）。

## 依据与决定

- `docs/hub-r4-progress.md` 决定 72：
  - Hub 核心只放真相保证所依赖的内容；
  - 通用技能包：解释工件格式的能力，可安装，不随 Hub 发布；
  - 按编号读平台原件、在任意工作里单独核对，都是通用技能包，不是核心缺口。
- `docs/hub-r5-brief.md` 工作项 A5（负责人：agy）：
  - 通用技能包 source-read：每个系统路由一个输入（缺陷、需求、构建、脑图、构建页、手册文件、SVN 文件），零要求项，目标是提供原件引用、投影、版本绑定、矛盾计数；当前投影可能异步，不能把零要求项当成投影完成；
  - 不改核心。

## 契约与文件结构

- `workflow.json`：声明 7 个可选输入槽位（`defect`、`story`、`build`、`mindmap`、`build_page`、`manual_file`、`svn_file`），不绑定产品线（`product: { catalogs: [] }`），投影指向 `functions/project.ts`；
- `requirements.json`：零要求项（`requirements: []`）；
- `checks.json`：零检查项（`checks: []`）；
- `slots.schema.json`：空槽位模式；
- `functions/project.ts`：投影函数，未传入任何输入时报错拒绝（`source-read.no_source`），传入至少一个有效输入时成功返回空条目列表；
- `SKILL.md`：详细说明 Circle 如何在任意工作中使用本技能包取原件。

## 限制与规矩

1. 纯只读访问：通过系统包连接器读取外部原件，Hub 不发任何写请求；
2. 零要求项生产运行：Hub 在 `start_run` 时抓取原件，不需要模型后续 `submit_result`；喂入投影可能继续在后台执行，须按回执披露进行中或缺失事实，不以零要求项推断投影完成；
3. 合成数据：测试只使用合成数据（产品 Meridian、lumen-api，地址 192.0.2.0/24），不连接真实设备或外部平台；
4. 改动重签：修改包内声明文件后必须运行 `node packs/workflow/source-read/pack-files.ts --write` 重新计算散列并写入 `pack.json`。

同一来源相同的 `feeding_pending` 文案可能去重，不能将文案里的数字相加当成受影响步骤总数；需要计数时以逐条可读记录为准。
