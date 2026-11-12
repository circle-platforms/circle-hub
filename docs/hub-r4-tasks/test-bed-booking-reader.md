# B3：知识层经台架包读取已冻结的预订（#110）

来源：所有者全量计划 #110/#147/#199；所有者 2026-10-30 的决定：台架的清单、预订、租约和释放归 test-bed 包，回注层不证明租约，操作记录只写设备和台架。基线 aded2ffd，`fix/test-bed-booking-reader`。

## 允许路径

- `packs/workflow/test-bed/{api.ts,README.md,pack-files.ts,pack.json,pack.test.ts}`
- `packs/workflow/test-bed/functions/{bed-key.ts,booking.ts,booking.test.ts,conclude.ts,match.ts}`
- `hub/knowledge/{feeding.ts,operation-device.ts,operation-device.test.ts}`
- 本任务页、`CHANGELOG.md`

## 决定

知识层自己写了一份台架清单形状、设备租约键和设备指针的读取（`bookedInstalls`、`reproductionLease` 的租约行解析、`operation-device.ts` 的清单读取）。这三者由 test-bed 包写出（`conclude.ts`、`match.ts`），包一改，知识层读出的设备、台架或构建会悄悄变空，核对悄悄变宽。

做法与 `hub/dispatch` 已有的先例相同：读取放在写入的包里，经 `packs/workflow/test-bed/api.ts` 对外。

- 新增叶子模块 `functions/bed-key.ts`：`bedDeviceKey`、`parseBedDeviceKey`，设备租约键只在这里写。`conclude.ts`、`match.ts` 里所有手写的设备键都改用它（包括 `match.ts` 里原本没有被 issue 提到的两处）。
- 新增 `functions/booking.ts`：`frozenBeds`、`bookedInstalls`、`bookedBedLease`，复用包自己的 `devicePointer`。`frozenBeds` 对三种情形分别回答：没冻结清单返回 null；冻结了读不懂的清单返回问题；读得懂返回台架到设备的表。
- 知识层删掉自己的三份读取，改调包的 `api.ts`。唯一的行为变化：冻结了读不懂的清单时，操作记录的设备和台架声明被拒绝，并说明形状由台架包定义；原来当作“没有清单”原样接受。
- 包版本 1.2.17 → 1.2.18，清单摘要重新生成。读写行为不变。

不改 MCP 六工具、外部 schema、生成协议、迁移、配置、租约表或权限。

## 验收

- 契约测试：`installsOf` 写出的键、`devicePointer` 给出的指针，经 `bookedInstalls` 读回同样的构建；只订了一台设备就只得到那一台的构建；同名设备在另一台架里是另一台设备；没有观察、清单摘要缺失、探测的是别的清单、观察不是 observed 的情形都不产生构建；只订地址的租约不算台架租约。
- 写法守卫：`conclude.ts`、`match.ts` 再出现手写设备键时测试失败。
- 知识层：冻结了读不懂清单的运行，其操作记录的设备和台架声明被拒；同一声明对读得懂且含该设备的清单被接受。该测试在原实现上失败（已实证）。

## 实际验证

见 PR 说明。仅合成数据与临时 PostgreSQL；没有真实台架、设备或部署。

## 仍待办（本批不做）

#34 的目录遍历（核心导入产品包）是另一个需要所有者决定的设计；`hub/knowledge` 现在也经 `api.ts` 导入工作流包，与 `hub/dispatch` 的既有做法一致，是否保留这种依赖方向属于架构决定。
