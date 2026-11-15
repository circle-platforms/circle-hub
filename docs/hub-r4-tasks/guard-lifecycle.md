# 守卫反馈与安装维护

使用者要求落实 Hook 调研方案，并在发现 `hub-redesign` 没有守卫实现后批准基线 `813447b79d`。工作仅在 `fix/guard-lifecycle`，不合并、推送、部署或修改现用 Home。

允许修改的路径：本任务页；`.github/checks/doc-set.json`；`docs/_config.yml`；`scripts/real/guard-lib.ts`、`scripts/real/circle-home.ts` 及其测试；新增 `scripts/real/guard-installation.ts`（测试放入现有 `circle-home.test.ts` 套件）；中英文兼容性页面。

基线已有 stdin 声明修复 `8322e3ce6a`、引号修复 `3d9bb7633e` 和扩展验证 `7c23415c27`，此次保留并联合验证。普通 CLI 参数抽取不在此次范围内。测试只使用合成临时 Home。

安装回执覆盖生成的守卫文件和已装技能字节。没有回执时必须由集成者显式提供已审查的原版本回执；受管文件被修改时拒绝覆盖。操作前由集成者停止会话，维护入口不声称能停止远端工具。

旧 Home 的 `--baseline` 文件是集成者审查的 JSON：`schema` 为 `guard-installation@1`，`profile` 为 `skills` 或 `ops`，`files` 为相对路径到 SHA-256 的映射，`skills` 为技能相对路径到 SHA-256 的映射。`files` 必须恰好覆盖 `hooks.json`、对应入口、`guard-lib.ts`、声明和生成器。集成者先将这些文件与已审查的原版本生成结果逐一比对，再提供回执；维护命令不从目标自行采信基线。技能摘要在显式更新后重新登记，更新前仍须运行既有包完整性与静态门禁。

部分既有本地工具没有 stdin 清单，维护入口披露未知数量而不猜测协议，运行时继续拒绝这些工具的 here-doc；已经存在但无效或不完整的声明会使维护失败。此次未强制改写其他工作流包。

验证结果（合成临时 Home）：

- `npx tsc --noEmit`：退出 0。
- `node --test scripts/real/circle-guard.test.ts scripts/real/circle-home.test.ts scripts/real/skill-script-safety.test.ts`：91 通过，0 失败，0 跳过。
- `npm run test:docs`：253 通过，0 失败，0 跳过。
- `git diff --cached --check`：退出 0。

新增拒绝反馈回归在修复前因错误推荐 `hub_list_task_packs` 失败，修复后通过；原测试中对只读配置推荐 `edit_file` 的断言已改为验证当前配置没有编辑能力。维护测试覆盖旧代码更新、修改过的规则拒绝覆盖、无凭据文件、基线回执、符号链接、技能字节变化、stdin 声明未知与无效，以及两个 profile 的整组技能安装。

未运行全量单元、数据库验收、设备或真实会话验证；未修改现用 Home、Circle 仓库或任何部署。
