# B6：时间线事件与持续时长

来源：所有者 2026-11-09 全量计划，基线 aded2ffd，分支 fix/console-timeline-events；关联 #226、#199，#240单位另见#250。

## 允许路径

- `hub/server/console/charts.ts`、`charts.test.ts`、`README.md`
- `docs/hub-r4-tasks/console-timeline-events.md`、`CHANGELOG.md`

## 实施与验收

当前任务已给Hub校验、要求项和结果等记录设置point=true，但tooltip与表格仍按end-start显示0。事件保留点标记、记录时间，持续时长显示“未记录”；明确起止的span保留毫秒观测，包括真正零时长，不根据数值0反推事件。表格独立可读，说明/正文原样转义，不改时间戳与协议值。

先加点事件/实测零/非零时长/恶意标签回归，再检查受影响控制台HTTP及浏览器深浅三宽度。真实事件耗时没有观测仍未知，不声称测得零耗时。

## 实际验证

- 修复前chart文件6通过1失败，明确事件行仍写0。修复后 `node --test "hub/server/console/*.test.ts" hub/server/console.test.ts hub/server/console-results.test.ts`：77通过、0失败、0跳过。首轮tooltip正则跨多个嵌套div误读别的区间，改用精确tip边界后通过，未删真实零/8毫秒对照。
- 实际持续区间提示改用毫秒而不舍入到0秒；事件表格有独立记录类型、一个原始ISO时刻、结束时间—、跨度未记录；aria/title含事件范围。图形点/线保持由原point标记决定。
- 临时合成HTTP任务路由隔离Chrome：深浅主题×1440/1024/390共6图，展开表格、聚焦Hub校验点，逐行断言事件耗时未记录而区间保留数值。结果端口为脚本化合成，不代表线上检查耗时；没有业务写入。首轮手机截图仍在Inspector视图，仅DOM断言不能证明图表可见；改走正式 `view=record` 完整记录入口并增加实际高度断言后，最终6图通过。
- `npm run typecheck`：退出0；`npm run test:docs`：333通过、0失败、0跳过。未跑全仓unit/acceptance、Linux隔离或部署验证。
