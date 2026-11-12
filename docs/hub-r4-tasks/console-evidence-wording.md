# B6：权限、核验范围、交付与容量说明

来源：所有者 2026-11-09 全量计划；任务基线 aded2ffd，分支 fix/console-evidence-wording。关联 #221、#222、#223、#233、#199。

## 允许路径

- `hub/server/console/operations.ts`、`pages.ts`、`capacity.ts`、`space-capacity.ts`、`README.md`
- `hub/server/console.test.ts`、`console-results.test.ts`、`console-team-capacity.test.ts`
- `docs/hub-r4-tasks/console-evidence-wording.md`、`CHANGELOG.md`

## 实施边界

修正系统生成说明：管理员仅查看有权访问记录；按工作流要求执行适用检查，未执行不当通过；交付分区标题不声称下游已采用；容量限额计算不称计费。保持正式合约状态、协议字段和用户正文原样，不变更权限或计量规则。当前 adopted 是界面内部分组键，不更改证据模型。

## 验收

运行受影响的真实渲染/HTTP、结果分区与容量测试，核对完整交付和未知、不适用/未检查页面仍如实显示。类型和文档检查；浏览器以合成页面验证中文提示可见、窄屏不丢失。

## 实际验证

- 三个定向HTTP回归修复前3失败，修复后 `console.test.ts`、`console-results.test.ts`、`console-team-capacity.test.ts` 共32通过、0失败、0跳过；原有未检查/不适用、当前生产结果与模型评论分离、私人记录中性返回和管理员容量控制仍通过。
- `npm run typecheck`：退出0；`npm run test:docs`：333通过、0失败、0跳过。
- 隔离 Chrome 从临时测试服务的真实HTTP路由打开成员添加、任务列表、完整任务和团队容量：4页×深浅主题×1440/1024/390，共24图；核对文字、角色提示聚焦、CSS、容量弹窗。账号、结果与PG均为合成临时数据；任务结果端口为脚本化测试端口，不是线上业务结果。窄屏截图人工检查，不作为真人研究或生产验收。首轮容量截图仅打开根页，补充可见性断言发现隐藏Inspector中的锚点不构成实际打开；改从真实“团队容量”入口对应的 `?capacity=team` 详情页打开弹窗，最终24图全部通过可见性断言。
- 未运行全仓unit/acceptance、Linux隔离或部署验证。
