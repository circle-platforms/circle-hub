# 任务：在装构建以设备上看到的为准

依据：决定 112（所有者，2026-11-01，"1管理员不再声明 按照设备实际显示为准"，随后选"预订时自动看一次"）；通用模型 A05 R[3]（观察只对它被观察的时刻成立）、B01、D05 R[8]。

此前自动化测试环境清单里的在装构建由管理员声明，搜索结论只能写"声明，未核对"。设备上实际装的构建只在派发前的版本探测里看一次，看完不留给搜索用。

- 分支和工作树：`bed-observed-builds`（从 hub-redesign 6cddf9473 开出）
- 可以改的路径：
  - `contracts/src/pack.ts`（上下文键 observations、DeviceObservation、投影输出 observe）和 `contracts/src/run.ts`（运行摘要 device_observations、运行记录 observation_context），以及 `npm run gen:contracts` 重新生成的文件；
  - `hub/dispatch/executors.ts`、`hub/dispatch/probes.ts`、`hub/dispatch/service.ts`；
  - `hub/runs/engine/deps.ts`、`projection.ts`、`start.ts`、`evaluate.ts`、`observations.ts`（新）、`testing/harness.ts`；
  - `hub/server/assemble/hub.ts`、`hub/server/text.ts`；
  - `hub/knowledge/feeding.ts`（回注版本绑定里的在装构建）；
  - `packs/workflow/test-bed/**`（升 1.2.14）、`packs/workflow/knowledge-contribution/**`（升 1.3.14，只改说明）；
  - 以上各处的测试，`tests/acceptance/25-test-bed.test.ts`、`tests/acceptance/42-r5-t4-4-reproduce.test.ts`，`docs/hub-r5-test-map.md` 的 T4-4 行，`docs/hub-r4-progress.md` 记决定 112。
- 规则：同前（不推送、不建 PR；部署和发布逐次请所有者点头；测试只用合成数据）。

## 做了什么

1. **观察记录**：执行器的只读版本探针每看一次设备，Hub 记一条设备观察：清单摘要和设备在清单里的 JSON 位置、回显抽出的值、唯一时的构建、按知识库解析的基础构建、时刻、来自哪次预订或哪个派发作业、探针原件的引用。派发前的版本探测也记。按清单摘要和设备位置从新到旧查。
2. **预订时看一次**：test-bed 预订成功后，投影列出预订到的设备；Hub 对其中有执行器版本座位的设备在一个短的网关租约里做只读版本探测，不派发。结果作为观察类主张写进运行，回答里印"预订时在设备上看到的构建：…装的是 …（设备回显，观察于 …）"。看不了的写原因：没有绑定同一份清单、指向这台设备的版本探针，或者执行器这次连不上（原因在管理员记录里）；并说明派发前的版本探测还会再看一次。
3. **搜索和环境事实**：workflow 的 context 加 `observations`，开始运行时冻结每台设备最近一次观察，投影和检查从同一份冻结的观察重新计算。构建一致或不一致都带观察时间；没观察过的设备写"没有观察记录（未知；预订时 Hub 会在设备上看一次）"，从不算不一致。清单里写的在装构建不再使用，写了只在解析记录里留一条提示。整次搜索的未知点名要的构建、没有观察记录的设备和最近一次观察到别的构建的设备。
4. **回注的版本绑定**：自动化测试环境的在装构建取自本次运行或前序预订在设备上看到的构建，不再读清单；两边都没有时的下一步改成"以预订了这台设备的运行作前序再交"。knowledge-contribution 的说明跟着改。
5. **可见范围**：搜索结果给出构建名和观察时刻（所有者选的做法）；探针原件的读取权限不变。
6. **没有派发服务的 Hub**：没有任何观察，每台设备都是没有观察记录（未知），不拒绝开运行；预订时写一条未知"Hub 没有接设备观察（派发服务）"。

## 没做

- 派发的环境快照（bed_snapshot）里没有在装构建字段，回注绑定读它的那段一直取不到值。派发前探测的观察已经按作业记下，回注要不要用它另开一件。
- 升级设备：test-bed 仍然没有升级动作。
