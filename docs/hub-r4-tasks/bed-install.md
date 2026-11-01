# 任务：给自动化测试环境装构建，照 InfoTest

依据：决定 117（所有者，2026-11-02：复现一条发现于新构建的缺陷时，自动化测试环境装的是旧构建，旧构建上没有缺陷要的配置；所有者先问"先看看跳板机是否有升级函数"，看过后选"照 InfoTest 接上并升级"）。

跳板机上 InfoTest 框架有升级函数，和本地镜像逐字节相同：`lib/apv/apv.py` 的 `upgrade`，以及升级用例 `smoke_test/system/upgrade/99999999{0,1,2}.py`（conf 里第 i 台设备一个，镜像名取环境变量 `test_build`，已是目标就跳过，床内文件服务器缺镜像先下载，再 `system update`、等重启、升级后 `show version` 核对）。跳板机网关 0.4.3 没有能调它的工具，Hub 也没有装构建的动作。

- 分支和工作树：`bed-install`（从 hub-redesign 8ff75be51 开出）；网关在 compile-excel-server 的 `gw-build-install`（从部署中的 f37e3ba 开出）。
- 可以改的路径：`packs/workflow/bed-install/**`（新包）、`packs/workflow/test-bed/**`（升 1.2.16）、`tests/acceptance/45-bed-install.test.ts`（新）、`tests/acceptance/42-r5-t4-4-reproduce.test.ts`（出口文字）；`docs/hub-r4-progress.md` 补记决定 117。
- 规则：同前（不推送、不建 PR；测试只用合成数据）。部署和发布经所有者同意（决定 117 的选项写明要改并重新部署跳板机网关，并给 Hub 育新构建的知识根）。

## 做了什么

1. **网关 0.4.4 `build_install`**：请求 `{schema: "bed-install@1", build, image}`；镜像名只许字母、数字和 `. _ -`，以 `.click` 或 `.array` 结尾，按升级用例的读法（第一个 `-` 之后到最后一个 `.` 之前，`_` 读作 `.`）正好是 build，否则上机前拒收。框架自己的升级用例逐字节复制进 `<暂存根>/<任务>/ist_install/`，带 `test_build` 跑，报告目录因此带任务号、归属唯一；请求协议、恢复和结果读取与 `case_submit` 相同。床上装的构建以设备自述为准：`env_prepare` 不再要求设备等于配置的构建，只要求落在同一段 conf 凭据里；同一租约的 runner 以设备自述的构建起（结果库构建表跟着它）。
2. **新工作流包 bed-install 1.0.0**：以 test-bed 的整台预订为前驱；客户端上传装构建请求（待核验产物槽 `request`），开运行写设备现在装的构建；每台负载均衡设备一个条目（框架升级用例号，`policies/install.json`）；提交 `reason`（要装的构建和依据）；检查 `install` 核对请求、镜像名、reason、整台预订和锁定构建，支持事实带派发参数；效果行 `install_build` 由 Hub 自己派发（决定 105）。
3. **test-bed 1.2.16**：没有环境装着要的构建时，下一步先写"整台预订一个设备够用的环境，再用 bed-install 装上"，只用现有构建时去掉 need.build；不写"升级"（决定 111）。
4. **验收场景 45**：合成网关上整台预订 → 上传请求 → 开装构建运行 → 受理后 Hub 派发一次，网关收到的正是核过的请求字节，每个升级用例一行结论；镜像名不是这个构建或前驱没有持有整台时拒收、什么都不发。
5. **bed-install 1.0.1**（首次真实会话后）：模型去 PLM 找镜像名，找不到就问用户要，还推荐在旧构建上复现。复现缺陷要在发现它的构建上跑、环境装的不是它时先装不问用户、镜像文件名在构建站上（入口页 → 版本线导航页 → 列表页条目的镜像链接），写进包说明、请求槽说明、SKILL 和拒收文字。

## 上线（集成者）

1. 跳板机网关升到 0.4.4（`releases/<提交>`，原子切换 `current`，备份旧发布与状态，`cexg check` 后重启服务）。
2. 用例执行器更新：`reconciliation.protocol_versions` 加 0.4.4，`premises.result_ownership` 换成 0.4.4 和它的证据；装构建执行器新登记：提交调 `build_install`（`install_b64` 绑定载荷），proof 指向 bed-install 的 `install`，收尾标记用 InfoTest 每例收尾都写的 `################# The passed check point num:`，资源键与用例执行器相同，不声明床面快照。
3. 发布 bed-install 1.0.0、test-bed 1.2.16，分配给用例编译的用户。
4. 知识：把新构建加进点名构建，同步并育苗，编译时才有它的命令树。

## 不做

- 不改 InfoTest 的升级用例和框架；不改派发关口的九款条件；不在 Hub 里核对构建库有没有镜像（以作业结果为准）。
