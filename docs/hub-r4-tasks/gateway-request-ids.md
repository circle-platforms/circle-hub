# 任务：网关上机前记请求 id、按它去重和只读查询、拒绝带阶段，结果按派发身份归属

依据：

- 决定 35“上真实台架”第 7、8 问（`docs/hub-r4-progress.md`）：改网关（所有者自己的服务）；上机前记请求 id，按它去重，提供只读查询；拒绝时写明阶段和是否已上机；网关改好以后，结果按派发身份归属并认证。网关在 circle-hub 之外，第一步改的是网关自己的仓库，授权就是这一条。
- 设计 `docs/hub-r4-device-run.md` 第 4 节：现在网关的拒绝不带阶段，一律按未知冻结；对账时“查无记录”不能当作没执行，因为网关先上机后记账。第 6 节第 7、8 问是原来的问题。
- 模型：`node tools/show-element.ts D02 D03 D04 B06 P07 V03`。用到的几条：
  - D04 R[4]：目标拒绝须带拒绝阶段；D04 R[6]：“查无记录 = 没执行”只在目标先记请求 id、拒收过期请求、按记录作答时成立；
  - D03 F[4]、R[7]：重试安全类；不安全或去重前提未认证时，按目标的请求记录核对，都没有才记未知；
  - B06 F[0]：请求 id = 意图键 + 尝试次数，带 notAfter；B06 F[10]：结局里的“目标拒绝（带拒绝阶段）”和“已证明未执行（凭目标的请求记录）”；
  - D02 R[1]、R[4]、R[6]：前提默认为假，置真要“目标 + 目标版本”上的认证；“结果按派发身份归属”没认证时动态层记无判定；
  - P07、V03 R[5]：动态层的通过和失败，只在“只认本次运行、有收尾标记、设备归属已证明”时是事实。
- 网关现状（网关仓库 `compile-excel-server`，和 circle-hub 同一级的目录，只读看过）：
  - `gateway/tools.py` 的 `Gateway.case_submit`：先 `framework.launch_run` 起 runner，之后才 `state.record_task` 记任务、审计 `case_submitted`。`task_id` 由网关用模块、第一个用例号和毫秒时刻拼出，调用方给不了自己的 id；同一份工作簿再交一次就再跑一次。
  - `gateway/tools.py` 的 `Gateway.call`：任何拒绝都回 `{"ok": false, "error": <文字>}`，审计记 `tool_refused`，没有阶段，也不说碰没碰设备；`gateway/service.py` 把它标成 `isError`。
  - `gateway/state.py` 的 `tasks` 表只有已经起跑的任务，没有请求 id；`next_delivery` 拿同一落位目录的下一次投递时刻给结果划界。
  - `gateway/framework.py` 的 `report_run_dir`、`batch_logs` 和 `gateway/agent/jumphost_agent.py` 的 `op_results`：本次的报告目录按修改时间落在“投递前 3 秒”到“结束后 60 秒或下一次投递”之间来认，结果行按 url 里含这个目录来认。归属靠时间窗，不靠派发身份。
  - `gateway/auth.py`：替谁执行由 `X-Circle-Hub-Actor` 头并进调用主体，进审计和租约持有人。Hub 一侧的 `hub/dispatch/transport.ts`（hub-job-dispatch 分支）发的是 `x-circle-hub-operator`，名字对不上：网关现在看不到 Hub 的作业，也记不下代表谁。
  - Hub 一侧的 `hub/dispatch/service.ts`（同一分支）：意图里已经有 `request_id`（意图键加 `:1`）和 `not_after`；重试安全类写死为 `unsafe`；提交回答对不上就记未知（“缺拒绝阶段不能当作未执行”）；逐用例结论一律 `no_verdict`（“结果按派发身份归属尚未认证”）。

- 分支和工作树：
  - 第一步（网关）：网关仓库从它的 `main` 开 `request-ids`，目录 `compile-excel-server-request-ids`，现在就能开始。集成者开好，并照网关仓库的 `docs/development.md` 备好 Python 环境和 `gateway/vendor/cex_core`（这一份不入库）。
  - 第二步（Hub）：`dispatch-gateway`，目录 `circle-hub-dispatch-gateway`，等 hub-job-dispatch 合并进 hub-redesign、第一步合进网关的 `main` 以后，集成者从 hub-redesign 开。`hub-device-run.md` 的“决定 35 的答复落到这里”一节里落到 `hub/dispatch` 的三件（第 13–15 条）也在这条分支上做，免得两条分支改同一批文件。
    - 第 44 项注：hub-variables 第一步排在 dispatch-gateway 之后。那一件把执行器定义里能写变量的地方限定为期望值（`target`、`manifest_sha256`、只读核对条件里的 `equals`、`at_least`、`sha256`），这一步加的字段（`retry_safety`、`premises`、`actor`、`probes`、`refused_tools`、`side_effects`、`clock_skew_ms`、`reconciliation`、`conformance`、`read_retry_when`，和 `receipt`、`result` 里加的指针）都只照字面；调用执行器的钥匙改写成定义里的 `credential`（`${secret:名字}`），不再经 `executor update --secret`。dispatch-gateway 不用为它改什么。
- 可以改的路径：
  - 第一步，只在网关仓库：`gateway/tools.py`、`gateway/state.py`、`gateway/framework.py`、`gateway/prune.py`、`gateway/agent/jumphost_agent.py`（只在结果改按落位目录取的那几行）、`gateway/service.py` 的版本号、`ces_version.py`、`tests/gateway/` 的新测试和受影响的旧测试、`docs/gateway.md` 的工具表和运维要点。不改 `gateway/vendor/**`（同步来的判据代码）、`gateway/gates.py`（上机前检查本身不动）、`requirements*.txt`、`install.sh` 和 `.github/**`。
  - 第二步：`hub/dispatch/**`；`hub/server/cli-job.ts`（加 `job conformance`，改状态和恢复的输出）。不改 `contracts/`（`executor@1` 还在 `hub/dispatch/definition.ts` 里）、`hub/records`、`hub/leases`。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。另外：
  - 网关仓库也不推送、不打 tag：推 `v*` tag 会触发它的发版工作流 `.github/workflows/release.yml`。不连跳板机、不装网关、不跑真框架；网关测试只用 `tests/gateway/conftest.py` 的假框架和假结果库。提交照 circle-hub 的写法：一句英文祈使句，`git commit -s`。
  - 网关是 Python 写的，改动只在网关仓库里；circle-hub 里不进任何 Python。
  - 所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作，能自动走的下一步就自动走；枚举只来自生成的词表；Hub 只核验，不生成内容、不调用模型；核心不出现网关和产品的字：网关的工具名、头名、字段位置、阶段词和状态词都写进执行器定义（部署数据），Hub 代码里一个也不出现。
- 验证：
  - 第一步，在网关工作树里：`python -m pytest tests/gateway -v`，再全量 `python -m pytest tests/ -v`。
  - 第二步：`npx tsc --noEmit`；`node --test --test-concurrency=1 'hub/dispatch/**/*.test.ts' 'hub/server/**/*.test.ts'`。

## 第一步：网关（网关仓库）

1. **请求 id 进 `case_submit`。**
   - 加两个参数：`request_id`（字母、数字和 `:._-`，最长 128）和 `not_after`（UTC 的 ISO 8601 时刻）。两个要么都给、要么都不给；都不给的老调用照现在的样子跑，回执里写明“没有请求记录”。
   - 收到就先算工作簿摘要，在租约核对之前，在 `state.db` 的新表里写一行请求记录：`request_id`、调用主体（含 `X-Circle-Hub-Actor` 带来的那一段）、工作簿摘要、`not_after`、收到时刻、状态“已收到”。重复的请求不管租约在不在，都按记录作答。
   - 查重、比 `not_after` 和写这一行在同一个写事务里（照 `StateStore.acquire` 的 `BEGIN IMMEDIATE`），`not_after` 用拿到写锁时的时刻比。
   - 测试：带和不带 `request_id` 各一次；只给一个参数被拒；两个线程同时交同一个 `request_id`，只有一个往下走，另一个拿到同一份记录。

2. **按请求 id 去重。**
   - 同一个 `request_id`、同一个摘要再来：不再检查、不再上机，原样回记录里的回答（受理过的回原回执，拒绝过的回原拒绝）。
   - 同一个 `request_id`、摘要不同：拒绝，阶段是受理，没上机，原记录不动（同 B06 R[2]：带原键而内容不同，从不静默改绑）。别的调用主体拿同一个 `request_id`：同样拒绝，不透露原记录。
   - 已过 `not_after` 的请求：拒绝，阶段是受理，没上机，也记下来，之后查询答“已拒收”。
   - `cexg gc`（`gateway/prune.py`）不删 `not_after` 还没过的请求记录；删了别的，就记下删到哪个时刻，第 5 条查不到时要带上它。
   - 测试：每种各一条；同一 `request_id` 交两次，假框架只跑一次（数 runner 起了几次，不看回答）；gc 之后查询带上删到的时刻。

3. **上机前后的状态都记下来，任何时候都能答“上没上机”。**
   - 状态依次是“已收到”，然后是拒绝（带阶段），或“启动中”“已启动”。状态词由网关定，写进 `docs/gateway.md`。
   - `task_id` 在起 runner 之前定下，和请求记录写在一起（现在是起完才写 `tasks` 表）。
   - `framework.launch_run` 生成的 runner 脚本第一步先写一个开始标记文件（`framework.TASK_FILES` 加一项），之后才进 pytest。runner 是唯一碰设备的东西，没有这个标记就没碰过设备。
   - 网关重启后看到“启动中”：有开始标记就是上过机，照常按 `task_id` 读状态；没有开始标记、存活锁也空着，就是没上机，记成“没启动”并写原因。
   - 每次状态变化在审计链（`gateway/audit_chain.py`）里追加一行，带 `request_id`。
   - 测试：用打桩让流程停在“记了请求、还没起 runner”和“起了 runner、还没记已启动”两处，重新加载状态后查询分别答“没启动”和“上过机”；`cexg audit-verify` 照样通过。

4. **拒绝带阶段和“是否已上机”。**
   - `Gateway.call` 的拒绝回答加两个字段：`stage`（网关自己的阶段词）和 `reached_device`（布尔）。
   - `case_submit` 的阶段照代码的次序：受理（参数、请求 id、过期、摘要不符）、租约、上机前检查（`gates.freeze`、`gates.check`）、床忙、落位（`framework.stage_case` 的摘要核对）、起 runner。这些都在 runner 之前，`reached_device` 一律是 `false`；起了 runner 以后不再有拒绝，只有状态。
   - 别的碰设备的工具（`env_prepare`、`probe_show`、`bed_topology`、`init_device`）拒绝时也带这两个字段，照实写：登录设备以后才失败的是 `true`。
   - 有 `request_id` 时，拒绝也写进请求记录；审计的 `tool_refused` 带上 `request_id`、`stage` 和 `reached_device`。
   - 测试：每个阶段造一次拒绝（坏 base64、过期、租约不对、自毁命令、床忙、落位摘要不符、起进程失败），断言 `stage` 和 `reached_device: false`，假框架一次也没跑。

5. **按请求 id 只读查询。**
   - 加一个只读工具：按 `request_id` 查请求记录。要 `jumphost:run`，不要租约，不碰设备；名字照网关现有的 `case_*` 起，写进工具表，`readOnlyHint` 为真。
   - 找到时回：`request_id`、状态、阶段（拒绝时）、`reached_device`、`task_id`（启动了才有）、工作簿摘要、收到时刻、`not_after`。“启动中”先按第 3 条判定再回。
   - 找不到时回：找不到，加上网关自己的当前时刻和第 2 条 gc 删到的时刻。Hub 只在网关的当前时刻晚于 `not_after`、而且 `not_after` 晚于删到的时刻时，才把“找不到”当成“没执行”（D04 R[6]）。
   - 查询和第 1 条写记录走同一把写锁：查询时刻晚于 `not_after` 时，要么看得到记录，要么之后到的这个请求一定按过期拒收。
   - 别的调用主体查别人的记录，回答和“找不到”同形。
   - 测试：每种状态查一次；找不到时带两个时刻；一个线程在写记录、另一个在查，`not_after` 卡在两者之间，断言不会出现“查的时候找不到、之后又启动”的次序。

6. **结果按派发身份归属。**
   - 每次投递一个自己的落位目录，目录里带上这次的 `task_id`；最后一级仍是第一个用例号（现在 `submit_autoid` 就是落位目录名）。这一级怎么放，先照假框架夹具（`tests/gateway/conftest.py` 的 `FAKE_TEST_XLSX` 按目录名取模块和用例号）验证；框架对目录名的要求写进 `docs/gateway.md`，真框架上的核对由集成者只读做。
   - `case_results` 只从这个目录对应的报告里取结果行、日志和会话，不再用投递时刻、结束后 60 秒和 `state.next_delivery` 划界；回答里回显 `request_id` 和 `task_id`，写明结果是按本次落位目录取的。回执也回显 `request_id`。
   - `cexg gc` 照新的目录形状清理。
   - 测试：同一份工作簿（第一个用例号相同）用两个不同的 `request_id` 先后交，第二次在第一次结束后一分钟内到：两次的结果、日志、会话互不串；落位目录外造一份同名的报告目录（像本地入口跑出来的），不被取到；gc 前后的计数。

7. **版本号升一个次版本**：`ces_version.py` 和 `gateway/service.py` 的 `SERVER_INFO` 一起改（`tests/test_onboarding.py` 核两处一致），不打 tag。`docs/gateway.md` 写明新行为从这个版本起有；Hub 按 `initialize` 回答里的这个版本号认证。

## 第二步：Hub 的派发连接器（`dispatch-gateway` 分支）

8. **代表谁按网关的头名发。** 执行器定义写明代表身份的请求头名字（部署数据）；值是代表的 Hub 用户和作业号，合网关头的字符限制（`gateway/auth.py` 的 `_ACTOR`）。`transport.ts` 里写死的 `x-circle-hub-operator` 去掉。测试：合成网关只认定义里的头名；值不合限制时一个请求也不发，报定义有误。

9. **提交带请求 id 和 notAfter。** 执行器定义里提交的参数绑定 `request_id` 和 `not_after`（意图里已经有）；回执加一处指针，回显的 `request_id` 和意图的相等才算受理。测试：回显不等，记未知（内容不符）、冻结。

10. **拒绝按阶段映射。**
    - 执行器定义的 `receipt` 加两处指针（阶段、是否已上机）和阶段词到 `effect_outcome` 的映射。
    - 提交回答是工具错误时（网关的拒绝走 `isError`），`transport.ts` 不再一律抛出：原文照旧先存，再交给派发按定义解释。
    - 阶段词映射到 `target_rejected`、而且“是否已上机”正好是 JSON 的 `false`：记“目标拒绝”和阶段原词，不冻结，释放网关租约，下一步写明。别的（词不在映射里、不是 `false`、缺字段）照现在记未知。
    - 同一个意图的下一次尝试：只有之前每次尝试的结局都是“目标拒绝（没上机）”或“已证明未执行”时才许，请求 id 的尝试次数加一；`dispatch.bytes:<S>` 这个业务键改成按尝试记。
    - 测试：每种拒绝各一条；没上机的拒绝之后同一个 S 第二次尝试成功，请求 id 尾数是 2；上过机或缺字段的拒绝冻结，第二次尝试被拒。

11. **丢回执先按请求记录核对，核对不了才是未知。**
    - 执行器定义加一个只读调用（网关第 5 条的工具），带回答的指针和状态词的映射，映射到 `effect_outcome`、`acceptance` 的现有码。
    - 提交超时、连接在发出后断开、进程在提交中退出：记“回执未取得”，下一步写明“到 not_after 之后按请求 id 只读核对”。`not_after` 一过就查：命令行进程还在就自己等着查，进程退出了由 `circle-hub job resume` 查。这是读，失败照读的规矩重试（D03 R[0]），从不重发提交。
    - 核对的结局：查到已启动、有 `task_id`，记成回执（受理、远端编号），接着读状态和结果；查到没上机的拒绝，同第 10 条；查到“没启动”，记 `proven_not_executed`、解冻；找不到，而且网关的当前时刻晚于 `not_after`、`not_after` 晚于 gc 删到的时刻，同样记 `proven_not_executed`、解冻，回答原文作证据；别的（找不到但时刻不够、状态词不认识、读了三次都失败）记未知、冻结，下一步照现在的管理员对账。
    - 查到已启动是目标的正面记录，后面照样核摘要和请求 id，不要认证；`proven_not_executed` 和“没上机的拒绝”这两种否定的结论，只在这个网关版本的“请求记录”前提认证过时才这样记（第 12 条），没认证照现在记未知。
    - 测试：合成网关（`hub/dispatch/testing/server.ts`）加上请求记录和查询，上面每个结局一条；进程在提交中被杀，重启后 `resume` 查到已启动，只读状态和结果，提交调用次数不增加；时刻不够时找不到，仍是未知。

12. **前提的认证。**
    - 执行器定义加 `premises`，两项：“请求记录和拒绝阶段”（D04 R[4]、R[6]）和“结果按派发身份归属”（D02 R[4]）。每项写认证过的网关版本（`initialize` 回答里的 `serverInfo.version`）和证据引用（`src:`）。
    - 每个会话连上时记下网关报的版本；和认证的版本不等，或证据引用解析不出，这一项就按没认证处理，结论写明“网关这个版本没有认证”。
    - `circle-hub job conformance --executor <编号> [--save <暂存目录>]`：在一个网关租约里只做不碰设备的四次调用：查一个从没发过的请求 id（找不到、带时刻）；交一份 `not_after` 已过的请求（拒收、阶段是受理、没上机）；同一个请求 id 换一份字节再交（拒收）；再查这个请求 id（找到、已拒收）。只打印阶段、码和摘要，原始回答照旧先存成源文件；集成者拿这些引用写进 `premises` 的第一项。
    - 第二项的证据来自第一个真实用例的结果回答（回显请求 id 和 `task_id`，报告在本次落位目录下）：所以第一个用例自己记无判定，认证以后的用例才可能有判定（`hub-device-run.md` 那一节第 7 条）。
    - 测试：`job conformance` 对合成网关跑通，四次调用的结局逐条对；版本不等时前提不生效；证据解析不出时不生效。

13. **逐台只读探测**（`hub-device-run.md` 那一节第 6 条）。
    - 执行器定义加 `probes`：每项一条命令（部署数据）、对哪些座位发、怎么从回答里取值（一条正则、一个捕获组）、期望（绑定值：锁定构建，或清单里这个座位那台设备的地址集合）。
    - 独立的 `job precheck` 和派发前的只读核对，都在同一个网关租约里逐台发；原始回答先存成源文件（B05 R[2]），再比；不符就“未发出”，写明哪个座位、哪一项（实际值只写进只有运行用户和管理员能读的结果）；读失败照读的规矩重试，不记未知。
    - 期望的地址集合从运行绑定的台架清单里按配置的座位取；Hub 代码不认设备类型和命令。
    - 测试：两个合成座位，一个版本不对，未发出；一个地址多一个，未发出；全对，接着派发；网关一直床忙，重试后记“未发出”和原因。

14. **运行器在 Hub 之外的动作记成观察**（那一节第 8 条，决定 35 第 9 问）。
    - 执行器定义加 `side_effects`：每项一句中文说明（部署数据）和可选的日志字面标记。
    - 结果源文件里逐项列出：有标记的，按本次存下的日志和会话原文查，写“本次日志里有这一项的标记”并带引用，或“本次日志里没有这一项的标记”；没有标记的，写成“运行器会这样做（执行器定义声明，Hub 看不见）”。从不写“发生了”或“没发生”。
    - 测试：合成日志里有一项的标记、缺另一项，一有一没有；结果不完整时这一段照写，不推断。

15. **只用运行权限的密钥**（那一节第 10 条，决定 35 第 11 问）。
    - 执行器定义加 `refused_tools`：网关的 `tools/list` 里不许出现的工具名（部署数据；网关按密钥的权限列工具，见 `gateway/service.py` 的 `tools/list`，管理级的那个只有管理密钥看得到）。
    - `transport.ts` 连上以后本来就逐页读工具清单；出现其中任何一个就断开，什么也不调用，precheck 和派发都记“未发出”，原因写“密钥权限超出运行权限”。
    - 测试：合成网关多列一个不许的工具，工具调用次数是 0，记未发出。

16. **结果归属认证以后的动态层**（决定 35 第 8 问）。
    - 结果回答加两处指针：回显的 `request_id`；每个用例日志里的收尾标记（标记文字是部署数据）。
    - 逐用例按定义的映射给 `pass` 或 `fail`，只在这几条都成立时：“结果按派发身份归属”在这个网关版本上认证过；回显的 `request_id`、远端编号和摘要都对上；这个用例的日志不过期、有收尾标记；设备归属已证明（第 13 条的探测在同一个网关租约里过了）。缺哪条就记 `no_verdict`、原因 `integrity_unproven`，写明缺的是哪条和下一步。
    - 限定一律带 `local_ops_not_excluded`（决定 35 第 10 问）。D02 R[5] 说本地入口没排除时结论最多为判断，它和 P07 合起来这一格怎么记，由集成者在模型里定；代码只在一个函数里决定这一格，定了只改那一处。
    - 测试：每缺一条各一例，`no_verdict` 带原因；全成立时 `pass`、`fail` 各一例；版本不等时退回 `no_verdict`。

17. **README**：`hub/dispatch/README.md` 写这一轮的偏离：认证暂时写在执行器定义里；“时间窗内去重”这一类这一轮不在窗口内同键重发（D03 R[7] 允许），只按请求记录核对。

## 集成者改的（终端不改）

- 模型：D02 R[1] 认证记录的形状（第 12 条先写在执行器定义里）；D02 R[5] 和 P07 合起来动态层怎么记（第 16 条）；D03 R[7] 这一轮的做法记成偏离。
- 设计 `docs/hub-r4-device-run.md` 第 4 节的表（网关拒绝、丢回执两行）和第 7 节的偏离，照这一页改写。
- 网关的发版和装到跳板机不在这一页，由集成者在第一步合进网关 `main` 以后做；装好以后跑 `job conformance`，把证据写进执行器定义。
- 现在 Hub 发的请求头名字对不上网关（第 8 条）：集成者可以先告诉 hub-job-dispatch 的终端，在合并前改。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
