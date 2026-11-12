# 新一组请求下发时，旧的一组作废（决定 150）

来源：所有者 2026-11-10“新的下发旧的应该作废”（决定 150）；基线 `origin/main` 43868676，分支 `fix/request-supersede`。

## 允许路径

- `contracts/model.json`、`contracts/generated/{protocol.ts,vocabulary.ts}`、`contracts/README.md`、`contracts/src/{vocab-axes.test.ts,model-w04-w10-v07.test.ts}`
- `hub/requests/{service.ts,service.test.ts,README.md}`、`hub/ports.ts`
- `hub/runs/engine/{requests.ts,requests.test.ts,submit.ts,README.md}`
- `hub/server/console/{tasks.ts,api.ts}`
- `tests/acceptance/59-request-supersede.test.ts`
- `docs/compatibility.md`、`docs/compatibility.en.md`、`docs/hub-r4-progress.md`、`CHANGELOG.md`、本任务页

## 问题

每次已受理的提交都会按当次结果下发一整组请求，请求以所绑提交的摘要为来源，所以两次提交的请求互不重复，也互不了结。只有修复请求在要求项满足时由下一次提交作答；澄清请求一直留在等待回应中。本机演示里提交过 56 次的一个运行列出 3,920 条等待回应的请求，实际只有 70 处缺口。

## 决定

- 请求服务加 `supersede`：给仍在等待的请求追加一条了结记录，带 `superseded` 标记，指向后来的结果记录。读出的请求多一个 `superseded: true`，`answered_by` 是那条结果记录。已回答或已作废的请求保持原来的了结记录。
- 运行引擎在受理提交、保存结果并处理完修复请求的作答之后，作废同一运行此前各次提交下发、仍在等待的请求（`supersedeEarlierRequests`）。请求的来源是提交内容的摘要，用提交记录的索引确认它确实是本运行的一次提交。以被作废请求为来源的逾期升级请求一并作废。
- 同一内容在别的提交之后再次提交并受理（甲、乙、甲）时，甲的请求此前已被乙作废，按键去重不会再写新的请求；这时先恢复甲的请求（`reinstate`，追加一条没有回答的了结记录，列表读最新一条），再作废乙的请求。只恢复被作废的请求，不恢复已回答的。
- 不作废的四类：带判据变更声明位置的判断请求、绑定派发作业的请求、要求重跑的请求、带包摘要的给包作者的修复请求。它们各有作答步骤，其中包作者修复请求的回答必须是包版本记录。
- 未受理的提交不作废任何请求：它没有成为当前结果。
- 任务页时间线把作废的请求写成“已作废”；控制台 JSON 接口的请求多一个 `superseded`，`answered` 对作废的请求为 `false`。
- 模型第 41 版：B07 R[10]、`request_status` 加 `superseded`。

## 验收

- `hub/requests/service.test.ts`：只作废等待中的请求；已回答的不动；再次作废不覆盖；作废后列表与单条读取一致、去重键不变；作废后的请求拒绝回答；来源记录不存在时拒绝；恢复只作用于被作废的请求，恢复后可以再次作废。
- `hub/runs/engine/requests.test.ts`：未受理的结果不作废；受理后普通请求和它的逾期升级被作废；已回答的、四类不作废的、来源不是提交的、本次提交自己下发的都不动；之后较早的那次提交再次受理时，它的请求和逾期升级恢复等待，另一提交的请求作废，已回答的仍是已回答。
- `tests/acceptance/59-request-supersede.test.ts`（真实 MCP 提交路径，合成评审包）：第一次提交后的请求全部等待；第二次不同内容的提交受理后，第一组全部作废且由同一条结果记录了结，等待中的只剩第二组；原样重交不新增也不再作废。这个测试在作废条件没有命中时失败过一次（当时按“来源是提交记录”判断，实际来源是提交内容的摘要），据此改为按提交索引确认。
- 合约：`npm run verify:contracts`，`contracts/src` 的版本与词表测试。

## 不做

- 不回溯处理已有的请求。
- 不改变请求的去重键和期限规则。
- 控制台请求列表的归并显示在控制台重排里做，不在这里。
