# 任务：效果类与写声明（D03）、效果前边界（P11）装配上

依据：

- 决定 35 第 13、16 项（`docs/hub-r4-progress.md`）：D03 和 P11 的边界也装配上；D04 R[0] 的修订确认。
- 对照模型的复核 `docs/hub-r4-model-review.md` 第 2 节第 6 条：效果前边界和全局边界政策表没装配，D03、P11 只部分落实。
- 模型：D03 F[0]–F[10]、R[0]–R[7]；P11 R[3]（效果前边界逐次核对的各款）、R[4]；D04 R[0]–R[6]；C06 R[0]、R[2]、R[3]；W03 F[0]、R[3]、R[4]；B05 F[6]；B06 F[0]–F[10]；D01 R[6]；D02 R[0]；D07 R[0]；B02 R[4]；W06 F[7]。待定项“全局边界政策表的归属”已定：随核心版本发布。用 `node tools/show-element.ts D03 P11 D04 C06 W03 B05 B06 D01 D02 D07 B02 W06` 读。
- 上真实台架的设计 `docs/hub-r4-device-run.md` 第 4、5、7 节。hub-job-dispatch 分支上：`hub/dispatch/service.ts` 写意图时把效果类“作业”、重试安全类“不安全”、署名“服务账号代表发起用户”写死（约 105 行）；`proof.ts` 的 `verifyInput` 核了放行条件；允许的效果表、全局政策表、任务包政策表和预算都没核；`hub/dispatch/README.md` 的 Needs 要 effect@1、request@1、executor@1 进合约。
- 同一批写的 `gateway-request-ids.md` 第二步（分支 `dispatch-gateway`）在 hub/dispatch 里做按请求 id 核对、拒绝阶段、前提的认证（执行器定义的 `premises`）、逐台探测和结果归属。这一件在它之上做，不重复做那几件。
- 合约里 `RunRecord.policy`（所用全局边界政策表的版本）和 `RunRecord.executors`（执行器登记的摘要，W06 F[7]）已有，没人填。

- 集成者先做（模型文字归集成者），开分支前提交：
  - 效果前边界每一款越界的固定码，进协议码（P11 R[3]“越界即拒，给固定码”）；租约和围栏沿用 LEASE_UNAVAILABLE、LEASE_EXPIRED、FENCING_STALE；
  - P11 R[3] 的“候选层内容一律不外发”：决定 25 以后 Hub 里没有候选层，这一款改写或删去；
  - D04 的变更记录写明 R[0] 的修订（预订类租约按血缘持有）所有者已确认，test-bed-ownership 那一页也提到，记一次就够；B05 F[0] 的动作种类补上“租约”（词表 action_kind 已有）；这两处代码不用改；
  - 下面第 2 条加的词表轴在 W03 的变更记录里写来源（W03 F[0] 原文，决定 35 第 13、16 项）；
  - 架构第 1 节“效果不在这个里程碑”那句。
- 分支和工作树：`d03-p11-boundary`，目录 `circle-hub-d03-p11-boundary`，从 hub-redesign 开出。
  - 等这些合并以后，由集成者开出并通知：
    - 这一批：hub-job-dispatch、hub-case-runtime、hub-case-workbook、hub-device-run、core-fixes 等；
    - 未知普查的六件，其中 hub-unknown-exits 加请求记录，第 7 条要用；
    - 同一批写的 `dispatch-gateway`（改 `hub/dispatch/**`）、test-bed-ownership、kb-unversioned（改 `contracts/src/pack.ts`、`hub/runs/engine/start.ts`）。
  - `w04-rulings-ledger`、`v07-repetition` 也改 `contracts/src/pack.ts`、`hub/runs/packs/validate.ts`、`hub/dispatch/**`，排在这一件后面。
- 可以改的路径（行号照现在的写，合并以后以函数为准）：
  - `contracts/src/resources.ts`：写声明、executor@1（连同 dispatch-gateway 加的字段，从 `hub/dispatch/definition.ts` 移过来）、effect@1，都登记在它的 `schemas` 里，不改 `index.ts`；
    - 这一件排在 hub-variables 第一步之后。移的时候连同 hub-variables 加的 `credential`、源定义的模式（`ExecutorSource`）和能写变量的那几处（只有期望值）一起移；写声明和环境类别都只照字面，不许写成变量。
  - `contracts/src/pack.ts`：requirements.json 的允许的效果表；
  - `contracts/model.json`：只加第 2 条点名的词表轴 `effect_trigger`；照生成器重新生成 `contracts/generated/**`；
  - `hub/dispatch/**`；
  - `hub/runs/engine/start.ts`：写运行记录时填 `policy` 和 `executors` 的两行；
    - hub-variables 也改 `start.ts`，开头读一次变量、参数过凭据扫描，段落不同，这一件照合并后的写。
  - `hub/runs/engine/deps.ts`、`hub/ports.ts`（两边都用的才放这里）、`hub/server/assemble/hub.ts`：第 3 条读政策版本和执行器登记的端口；
  - `hub/runs/api.ts` 和引擎里一个新函数：第 4 条第 7 款按冻结的包版本重跑点名的检查；
  - `hub/runs/packs/validate.ts`：效果表的发布校验；
  - `hub/server/cli-job.ts`：只改 `executor list` 那一行；
  - 第二步：`packs/workflow/case-compile/**`，和 hub-device-run 加的验收场景 `tests/acceptance/28-device-run.test.ts`；
  - 对应的测试和 README。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据，版本线 10.6 以后，地址只用 192.0.2.0/24 和 2001:db8::/32；`git commit -s`）。所有者的规矩：
  - 未知只是过渡状态，写明缺的事实和下一步动作；
  - 枚举只来自生成的词表；
  - Hub 只核验，不生成内容，不调用模型：外发的字节就是核验运行里重算比对过的那份，派发时不重新生成；
  - 核心里没有产品、网关或命令的字：政策表只按效果类、是否可逆和环境类别写，网关的工具名和字段照旧只在执行器定义（部署数据）里。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `contracts/**`、`hub/dispatch/**`、`hub/runs/**`；第二步加 `packs/workflow/case-compile/**` 和验收里的派发场景。每条先写改前失败、改后通过的测试。

## 要做的

1. **写声明**（D03 F[0]–F[10]）：
   - 形状放 `contracts/src/resources.ts`：
     - 交互方式（F[0]）：作业类固定是“提交一次，再读状态和结果”，声明里写这个值；
     - 效果类、重试安全类、署名方式（词表 effect_class、retry_safety、signing）；
     - 是否可逆（F[2]）；目标键的写法（F[1]）；受众（F[3]）；
     - 核对证据：回读用哪个调用、哪个指针（F[5]）；
     - 前置条件：前状态怎么读、和什么比（F[6]，D04 R[5]）；
     - 拒绝阶段的指针（F[7]，D04 R[4]，dispatch-gateway 加的那一处）；
     - 是否写 Hub 记录（F[10]）。
     - 有序多步（F[9]）这一轮用不到，不加，写进 README。
   - executor@1 移进合约，提交那个调用带一份写声明。执行器只能声明“作业”（D07 R[0]），别的整份拒绝。executor@1 再加环境类别（D01 R[6]，词表 environment），第 3 条的政策表要用。
   - `service.ts` 写意图时从声明取效果类、重试安全类和署名，不再写死。已登记、没有声明的旧定义读作现在写死的那三个值，`executor list`（`hub/server/cli-job.ts` 的 `executorCommand`）标“写声明未写”，管理员用 `executor update` 补上。
   - 测试：声明各字段的正反例；执行器声明“同步写”被拒；旧定义照旧能派发并被标出。
2. **允许的效果表**（W03 F[0]、R[3]、R[4]）：
   - requirements.json 加 `effects`，每行：资源种类；动作（写声明里的调用）；效果类（取自资源的声明）；参数范围（取值集合，或包里 `policies/` 下的政策表）；放行条件（本运行哪些要求项必须满足、哪份产物的摘要）；触发方式；次数和时长预算；期限；是否可选。
   - 触发方式进词表，加一个轴：`effect_trigger`，标签“触发方式”，owner W03，取值 `runner_session`“由运行者会话经效果写入发起”、`hub_template`“放行条件满足后由 Hub 按模板派发”（W03 F[0] 原文）。
   - 运行冻结的就是它锁定的包版本里的这张表（`pack_digest`）。运行者收窄（W03 R[3]）这一件不做，写进 README。
   - 发布校验只核资源种类本身定得了的：
     - 执行器种类的行，效果类只能是作业（D07 R[0]）；
     - `hub_template` 的行只许作业类的种类（W03 R[4]）；
     - 行里引用的政策表要有正例和反例（C06 R[0]）。
   - 两条要看具体实例的核对挪到派发时，在第 4 条的第 1、2 款里核：署名是本人凭据的行只许 `runner_session`（D03 R[5]）；效果类和实例的写声明不一致的拒绝。写声明在管理员登记的执行器定义里，是部署数据，发布时还没有。
   - 测试：每条发布规则的正反例；两条派发时的核对各一对正反例；没有 `effects` 的包和现在一样。
3. **全局边界政策表**（C06 R[3]）：
   - `hub/dispatch/policy/boundary.json`，按“效果类 × 是否可逆 × 环境类别”放行或拒绝，带正例和反例；版本是它的摘要，随核心发布。
   - 内容照现在的授权：生产环境只放行“无”和“读”；测试和共享环境放行“作业”；“同步写”和“通知”一律拒绝，等所有者另行授权（AGENTS.md：真实系统只读）。
   - start_run 把当时的政策表版本写进 `RunRecord.policy`；把执行器登记写进 `RunRecord.executors`：每个执行器的定义摘要存成一个对象，记录里放这个对象的摘要。派发时政策表版本不同，或所用执行器的定义摘要和这份登记里的不同，就拒绝，下一步是开新修订（照 W06 R[0] 的做法）。别的执行器改了不影响。
   - `RunRecord.executors` 里每个执行器的定义摘要，用 `start_run` 那一次的变量取值解析后的定义算（和 hub-variables 作业钉住的是同一种）；开跑以后执行器定义引用的变量改了，也算登记变了，派发照样拒绝，下一步开新修订。
   - 怎么读到：架构第 3 节只许 runs 导入 knowledge（api）、rules、refs 和 records；执行器登记在 `hub/dispatch` 的 `ExecutorRegistry`，它的 `list(by)` 对非管理员抛错，而 start_run 是以运行者的身份跑的。所以：
     - `deps.ts` 的 `RunsEngineDeps` 加一个端口，给出政策表版本和登记快照的摘要；
     - 在 `hub/server/assemble/hub.ts` 接上，作为 Hub 内部的读，不核运行者；
     - 两边都用的类型才放 `hub/ports.ts`。
   - 测试：表的每一格；样例都过；两项写进运行；政策表换了被拒；所用执行器改了被拒，别的执行器改了照常派发。
4. **效果前边界**（P11 R[3]）：`hub/dispatch/boundary.ts`，一个函数，写意图之前每次都调，按次序核，前一款不过就不往下核：
   1. 动作在这次运行冻结的效果表里；
   2. 参数在那一行的范围内；
   3. 放行条件满足（`verifyInput` 现在核的那些搬进来，或由它调用）；
   4. 次数和时长预算没用完（按这一行已写的意图计）；
   5. 租约和围栏有效（现有的持有者和围栏核对）；
   6. 全局政策表放行；
   7. 任务包政策表用编译时同一个脚本、同一张表重跑通过（C06 R[2]），行里写要重跑的检查号。被判对象只有 runs 会建（`evaluate.ts`），dispatch 碰不到，所以：
      - `hub/runs/api.ts` 加一个函数：按运行冻结的包版本，对存着的已受理提交重跑点名的检查，返回各自的结论；
      - dispatch 经端口调它，不把引擎的逻辑抄进 `hub/dispatch`；
   8. 外发的字节就是核验运行里重算比对过的那份（支持结论里的摘要等于 S），并过凭据扫描（B02 R[4]）；
   9. 外发内容所引的源文件或结果，可见范围窄于声明的受众，又没有覆盖它的分享时拒绝；受众快照里映射不到主体的成员按超出处理。这一款只对声明了受众空间的写（通知、评论）起作用；执行器的作业没有受众空间，写进 README。
   - 越界即拒：给集成者登记的码；effect@1 记“未发出”，拒绝的码和哪一款记在派发动作或 effect@1 上，不记成 `validate` 动作（B05 F[6] 把提交和上传的边界核对与效果前边界分开；`lineage.ts` 的 `authorOriginOf` 也读全部 validate 动作，一条不带会话的会让作者来源不完整）；对方一次都不调用。预算用完时写明是哪一行；相关要求项在它声明的各层记未完成（预算用完），经 hub-unknown-exits 第 10 条接进运行的那条路给出。
   - 没声明 `effects` 的包，第 1 款一律拒绝，不留旧路。所以第二步要和这一步一起合并，至少要在下一次真实派发之前合并。
   - 测试：每一款一个越界用例，桩网关收到 0 次提交；全过时正常派发；核的次序；没有效果表的包被拒。
5. **丢回复的逐类处理**（D03 R[1]–R[3]、R[7]，D04 R[1]、R[6]）：
   - 把 dispatch-gateway 做的按请求 id 核对放进一张表 `satisfies Record<RetrySafety, …>`，四类都写全：
     - 同键安全且去重前提已认证 → 同键重发，以目标的应答为准；
     - 时间窗内去重 → 照 dispatch-gateway 的定：按目标的请求记录核对，不在窗内重发（它的 README 记了偏离 D03 R[7]）。窗内同键重发只在执行器定义里另有一个明写的前提标记时才做，这一种只在设了这个标记的合成执行器上测；
     - 可容忍重复 → 重发一次，标“可能重复”；
     - 不安全或前提未认证 → 按目标的请求记录或回读核对，都没有才记未知、按目标键冻结、发处置请求。
   - 前提默认为假（D02 R[0]），认证照 dispatch-gateway 写进执行器定义的 `premises`。网关声明哪一类照 dispatch-gateway 的定，这一件不改；另外几类在声明了它们的合成执行器上测。
   - 未知写明缺的事实（有没有执行）和出口（核对，hub-unknown-model 的 exit）。
   - 测试：桩网关分别声明四类，各丢一次回复；前提未认证时都按不安全；出口字段。
6. **前状态**（D04 R[5]、B06 F[5]）：写声明给了前状态读法的，派发前在同一个网关租约里读一次，和绑定的值比，不等就拒绝；目标不支持条件写的，记“未绑定前状态”（现在的 `before_state_bound: false`）。测试：相等、不等、不支持各一。
7. **效果记录和请求记录**：
   - 每次派发写 effect@1（B06：意图键，请求 id 和 notAfter，动作摘要，目标键，覆盖条目集，效果类和重试安全类，前状态，写入身份，结局和追加标记），和现有的动作记录并存；旧的 action detail 记录不改。
   - 派发的处置请求写成请求记录（hub-unknown-exits 加的形状）。规则直接写在这里（决定 35 第 25 项：不加工具，Hub 在回答里写明下一步该谁做什么）：
     - 受众是管理员；
     - 下一步原文：“管理员从目标自己的审计记录只读取证，然后运行 `circle-hub job dispose <作业摘要> --reconcile <编号> | --keep-unknown | --mark-failed --reason <原因>`”。核心文字里不写网关、跳板机这类字；
     - 期限照 hub-unknown-exits 给请求的规则；
     - 了结它的是 `job dispose` 写的处置动作，动作的 detail 里写这条请求的号。命令照旧，不加工具。
   - 测试：一次正常派发、一次丢回执，effect@1 的字段齐全；请求能列出来；`job dispose` 以后请求了结，列表里不再算没回答的。
8. **注解不变**：这一轮没有工具会引发派发，submit_result 的注解照旧。submit_result 受理后由 Hub 按 `hub_template` 的行派发（D06 R[4]）另开；那时注解按调用者被分配的包里最宽的一行推出。README 写明。

## 第二步（hub-pack-findings 合并以后；开分支时它已经合并，就接着第一步做，一起交）

- case-compile 的 requirements.json 声明派发那一行：资源种类是执行器，动作是提交，效果类作业；放行条件是全部必需要求项满足和工作簿的摘要 S；触发方式 `hub_template`，这一轮由管理员命令代 Hub 触发；次数 1，时长取执行器的最长运行时间。升版本，重签。
- 验收里的派发场景（hub-device-run 加的 `tests/acceptance/28-device-run.test.ts`）照这张表跑通；删掉这一行，派发被效果前边界拒绝。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
