# 通用技能包 source-read（R5 工作项 A5）

分支 `source-read`。依据：决定 72（`docs/hub-r4-progress.md`）、`docs/hub-r5-brief.md` 工作项 A5。

通用技能包 `packs/workflow/source-read`（包种类先用现有 `workflow`，待 A1 合入后再改为 `skill`）：不绑定产品线；每个系统包声明的读路由对应一个可选输入（缺陷 `plm:bug`、需求 `plm:story`、构建 `plm:builds`、脑图文档 `agile:mindmap`、构建页 `buildsite:listing`、手册文件 `manual:file`、SVN 文件 `svn:file`），零要求项；`start_run` 时 Hub 按现有连接器读原件，回答里返回每份来源的原件引用、投影、版本绑定状态与矛盾计数。`SKILL.md` 写清 Circle 怎么用它在任意工作里取原件。测试用合成系统包夹具：每种路由一例、编号不存在、路由未声明、来源不可达，都有对应的拒绝或未知出口。

可改路径：

- `contracts/src/pack.ts`
- `contracts/generated/schemas/requirements.v1.schema.json`
- `packs/workflow/source-read/**`
- `docs/hub-r4-tasks/source-read.md`

规矩：只按结构判定，不许关键词匹配；仓库只用合成数据（产品 Meridian、lumen-api，地址 192.0.2.0/24）；不删不跳测试；改包内文件同提交升版本重签；测试并发不超过 2；不碰钥匙串、环境配置文件和任何真实系统。
