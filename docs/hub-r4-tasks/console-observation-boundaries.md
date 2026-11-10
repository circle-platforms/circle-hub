# B6：客户端位置、未观测空档与登记拓扑

来源：所有者全量计划，#224、#225、#199；基线aded2ffd，分支fix/console-observation-boundaries。

## 允许路径

- `hub/server/console/{tasks.ts,connections.ts,README.md}`
- `hub/server/console-clients.test.ts`
- `hub/server/console-observation-boundaries.test.ts`
- 本任务页、`CHANGELOG.md`

## 核实与修改范围

main客户端声明已按initialize/登记名/令牌标签显示，没找到“执行位置：本机 Circle”，保留声明原值，不补造地点或客户端。仍存在未观测空档被命名“客户端本机处理”的确定问题：改为调用间未观测区间，不能据其归因客户端计算/用户/网络或执行地点。

连接列表来自有效令牌及其登记/最近initialize声明，不是在线连接探测；令牌last_used_at也不是持久在线证据。将客户端计数/区段改为已登记，最近时间明确凭据使用；拓扑说明登记/配置关系，不代表实时在线或调用成功。近24小时只保留既有有记录使用统计，未记录不判离线。系统启用/运行环境占用/冻结既有正式标签和算法不改，声明客户端如含Circle原样保留。

## 验收

先真实HTTP回归未使用/最近使用凭据同列但无在线推断；显式非Circle客户端名保持原样。任务合成两个确定调用之间长空档仅标未观测，事件/跨度数值不改。主题×三宽度真实临时HTTP/合成端口浏览器核对，成员权限/令牌撤回仍原规则，记录水位不变。相关console/client/member测试、类型、文档实际结果完工记录。

## 实际结果

- 两个新增回归修复前确定失败：有效未使用凭据仍列为“已连接”，任务空档名为“客户端本机处理”。修复后原始59,800毫秒边界保持，未造客户端耗时或地点。
- `node --test hub/server/console-observation-boundaries.test.ts hub/server/console-clients.test.ts hub/server/console.test.ts hub/server/console/member-reads.test.ts`27通过、0失败/跳过；`node --test "hub/server/console/*.test.ts"`47通过、0失败/跳过。最后补充拓扑常显说明后新增2项再次通过、typecheck退出0；`npm run test:docs`333通过、0失败/跳过。
- 真实临时HTTP路由的连接页/成员所选客户端、脚本化任务端口的未观测空档，三页×两主题×三宽度共18图通过。任务时间戳在合成callLog读取端口注入100/200毫秒调用及59,800毫秒空档，非真实模型延迟。查表格精确值、成员不见其他唯一客户端标签、记录水位不变、内容可见，未触生产。
- 首次权限夹具拿通用“管理员”两字作不可见断言会命中解释文案，改为唯一其他账号客户端标签，未改权限。浏览器最初精确匹配h2.textContent会含隐藏tooltip正文，改取已见DOM类并正高度断言；检查截图后将拓扑登记/在线边界增为常显meta，并重新完成18图，非仅隐藏文案探针。
- 未找到旧部署“执行位置：本机Circle”于当前main；不把历史表述当当前复现。客户端真实声明/登记名称、凭据/撤销和正式状态轴不改。未运行全仓unit/acceptance/Linux、真实客户端在线观测或部署；不引入在线探测。
