# N2 管理员控制台表单（wp/cursor/n2-admin）

## 五行设计（动手前）

1. **改哪些文件**：`hub/server/console/{command-form,team,packs,operations,manage,connections,team-actions}.ts` 及对应测试；按需拣入 Codex 的 `command-parameters`/`command-registry`/`command-bridge`（及上传引用所需的 CLI 最小片）；进度本文件。
2. **对外接口**：不新增写库 API；表单一律 POST `/console/admin/do/<action>` → `command-bridge` → 同名 `circle-hub` CLI；六个 MCP 工具输入不变。
3. **数据从哪来**：字段与 argv 由 `COMMAND_PARAMETERS` + `REGISTERED_ACTIONS` 生成；团队/工作流/连接下拉用展示名，`value` 仍传内部编号；上传文件经既有原件登记得到 `src:<sha256>` 再交给 `executor add|update` / `doc put --reference=…`。
4. **怎么验**：无 PG 的 `command-form`/页面表单单元测试 + `npx tsc --noEmit`；实例上打开团队/管理操作/连接页点表单看结果页。
5. **会影响谁**：管理员控制台写路径与结果文案；成员验收步 1/2/7 的可达性；不宣称测试环境已按团队隔离，直至 Boss 合入环境授权。

## 交付（2026-11-14）

### 拣入
- Codex `1ec24795d7`（上传 `--reference=src:…` + bridge + pack.install/uninstall + doc.put）
- Codex `0f47e07870`（executor.assign/unassign）
- Codex `34638d6365`（pack.activate/deactivate/retire、lease/bed 参数与 bridge）
- 最小合约支撑：`ResourceAssignmentSubject` + `authorizations` 对 `exe_` 的主体解析（无完整 Kant 环境投影 / model gen）

### 已通的表单
- 成员：添加（既有）/ 邀请码 / 令牌 / 重置密码 / 停用启用；结果页一次性凭据
- 团队：新建/加人/移出/删除；团队详情工作流逐条与**批量多选**分配；业务系统分配
- 包：发布结果页按 kind 收尾（skill 安装 / product 启用 / workflow 分配 / system 跳转接入）；详情页安装/卸载/启用/退役/分配表单
- 环境：连接→运行环境 上 doc.put、executor-add（上传→src 引用）、executor-assign（诚实标注未宣称隔离）

### 措辞
- 管理操作页去掉「只执行四种操作」
- pack/resource 分配成功输出用团队名，不再打印 `tm_…` / `usr_…`

### 验证
- `npx tsc --noEmit` 通过
- 无 PG 定向：38 项相关单测（含本次 n2-admin-forms / Codex 拣入测试）全绿 0 skip

### 实例上怎么看
1. 管理员打开 `/console/operations/member` 加人；`/console/team` 建团、加人、批量分配工作流与业务系统
2. `/console/team/<成员>` 用表单重发邀请码/令牌、重置密码、停用启用
3. `/console/operations/pack` 发布 skill/workflow 后结果页直接安装或分配；`/console/skills|workflows/<id>` 同表单
4. `/console/connections?tab=environments` 上传清单/执行器定义、分配执行器（页面写明隔离未闭合）

### 缺口
1. **测试环境按团队隔离未闭合**：N2-env（`canUseEnvironment` / MemberEnvironments / 预订与派发守卫）与完整 Kant 合约生成未合入本树；表单可调 `executor assign`，但不得声称成员侧已按分配过滤。
2. **业务技能按团队分配**：通用 skill 仍全员安装规则；带业务的技能团队分配仍待 Codex 方案。
3. **基线/租约/占用清理**：`lease.*` / `bed.*` 已进 `REGISTERED_ACTIONS` 与 ACTIONS，运行环境页尚未铺完整操作行（仅登记+分配）；基线录制等可后补同页表单。
4. **成员自己为新客户端发码**：仍须管理员重发（Codex 方案未接）。
5. **兼容页 docs/compatibility***：拣入未改兼容页；Boss 合入时按需补 History。
6. **完整 model80 / schema gen**：本树只加了 `ResourceAssignmentSubject` 源类型，未跑 `gen:contracts`（主协调）。
