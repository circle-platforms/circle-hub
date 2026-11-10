# 控制台技术描述与指标可读性

来源：所有者 2026-11-09 批准的全量 Issue 计划，按最新 main 的独立任务分支交付。基线 `aded2ffd`，分支 `fix/console-readability`。本批处理 #201、#206 和 #240 的耗时比较图子项，关联 #199；#240 其余图表口径继续保留跟踪。

## 允许路径

- `hub/server/console/packs.ts`、`packs.test.ts`
- `hub/server/console/charts.ts`、`charts.test.ts`、`tasks.ts`
- `hub/server/console/README.md`
- `docs/hub-r4-tasks/console-readability.md`
- `CHANGELOG.md`

## 方案

- 依照 `PackFunctionRef` 的 module 和可选 export（默认 default）逐字段显示，不转换整个对象；解释器标识原样保留，原始路径和名称按 HTML 转义。
- 工作流区域和种类同名时只留一个区域层；通用技能、产品、系统仍保留有意义的分类。
- 比较图可声明独立指标名，耗时调用使用“耗时（毫秒）”；提示、可访问读数和表格共同使用该指标。单数据 Stat 也显示单位。数量图默认行为保留。
- #202 当前主线未重现，不借机改变数量过滤或导航。

## 验收

先运行新增回归复现，再修复：函数默认/具名导出、解释器、HTML转义；各包种类面包屑；耗时多值图/单值/零值，数量图无变化。运行控制台定向测试、类型与文档检查。浏览器验证使用合成页面与隔离 Chrome，不连接真实业务系统。

## 结果

- 修复前两个定向文件共 11 项：8 通过、3 失败，分别重现结构化函数、重复面包屑和指标读数问题。修复后 11 通过、0 失败、0 跳过。
- `node --test "hub/server/console/*.test.ts"`：50 通过、0 失败、0 跳过。
- `node --test hub/server/console.test.ts`：19 通过、0 失败、0 跳过，涵盖真实 HTTP 页面、权限中性返回及资源。
- `npm run typecheck`：首轮新增测试夹具漏 csrf，修正后退出 0。
- 隔离 Chrome 对实际渲染函数产生的合成详情/比较图页面检查，深浅主题 × 1440/1024/390，共 12 图；验证模块/导出/解释器可见、面包屑、CSS加载、耗时提示与表格指标、单值单位。它是临时合成渲染服务器，不是生产路由或真实任务验证；HTTP路由覆盖由上面的19项完成。未做真人可用性研究。
- `npm run test:docs`：333 通过、0 失败、0 跳过。
- 未运行全量 unit、acceptance、Linux隔离和部署验证；不据本批关闭 #240 其余观测语义问题。
