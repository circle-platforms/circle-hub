# 任务：自动化测试环境不带版本基线，照 CES 与网关

依据：决定 120。决定 119 上线后，两个执行器的独立预检都报设备版本不符：执行器定义的预检上下文写着装构建之前的构建，Hub 的版本探测没有运行锁定构建时拿它当期望值，没有它就报"缺少锁定构建"，让管理员在预检上下文登记一个构建。网关 0.4.4 起以设备自述为准（env_prepare 只在客户端给出编用例所用的构建时才比，没给就照查并注明没核对）；CES 的设备构建是这次工作的属性（登录后选定，不猜）。两者都没有环境级的版本基线。

- 分支和工作树：`no-build-baseline`（从 hub-redesign 8f03e5e9e 开出）。
- 可以改的路径：`hub/dispatch/probes.ts`、`hub/dispatch/service.ts`、`hub/dispatch/executors.ts`、`hub/server/cli-job.ts`、`hub/dispatch/README.md`、`hub/dispatch/testing/definition.ts`、`hub/dispatch/testing/context.ts`、`hub/dispatch/precheck-failures.test.ts`、`hub/dispatch/precheck.test.ts`、`tests/acceptance/28-device-run.test.ts`、`tests/acceptance/45-bed-install.test.ts`；`docs/hub-r4-progress.md`（决定 120）；本页。
- 规则：同前；只在写入关口拒收，已登记的定义照常读出（记录只追加，派生状态从记录重算）。

## 做了什么

1. 执行器定义的 precheck_context 不带 build 与 build_base：add/update 时拒收并说明怎么改；预检、观察和一致性核对组装上下文时也不从定义取这两项，规则之前登记的定义照常读出。
2. 版本只按运行锁定的构建判断：没有时，每个座位的版本自述记为设备观察（决定 112），只要求读出一个构建值，不按任何版本判断；绑定构建的条件同样只记录不判断。答复的 JobStatus.unjudged 与 CLI 的"未对照"列出这些座位和条件指针，不显示设备回显。派发照旧按核验产物与运行锁定的构建核对。
3. 测试：网关和设备都报另一个构建时，独立预检通过并列出未对照；带构建的定义在 add 和 update 时被拒；座位不符和缺产品绑定在锁定了构建的运行上照旧被拒；只读预检失败的回归改用座位数不足；两个验收测试的定义去掉构建。

## 不做

- 网关的 `[hub] build` 照旧：它只按 InfoTest 的规则选登录凭据段（看构建名里的品牌和平台标记，不看版本号），设备构建已以设备自述为准。
- 不再有"自动化测试环境装回哪个构建"这个待定事项：没有基线，下一个用例要哪个构建就由 bed-install 装上，已是目标构建就跳过。
