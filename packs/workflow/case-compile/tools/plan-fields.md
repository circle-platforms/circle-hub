# 计划字段一览（由 slots.schema.json 生成；带 * 的是必填；“—”后面是 schema 对这个字段的说明）

## 条目的 plan 槽：1 到 1 条陈述；陈述的 data：
bucket*: string（非空）
blocks*: 列表（至多 256 项），每项：
  下列之一
    · kind="CONFIG"：对象：
      id*: string（非空）
      kind*: 固定为 "CONFIG"
      call*: 对象：
        object*: string（非空）
        method*: string（非空）
        args*: 列表，每项 string
        keywords*: 对象；其余键的值：string | integer（0..）
      cleanup: boolean — true 将步骤标为末尾清理段；仅放置非只读、正文未净抵消且未命中 contract.cleanup 运行器自动清理的改配步骤，按产品声明逆序执行对应逆操作，不能从文字猜测；存盘等由执行器在收尾时做的命令禁止标为 cleanup:true
      input_register: string（非空）
      author_step_refs: 列表（至少 1 项，至多 32 项），每项 string（非空，至多 64 字符） — 本块实现的作者步骤编号列表（本块不实现作者步骤时省略）：写本条重组记录里作者步骤的 id（items/<n>.json 的 atoms 里 kind 为 action 的 id，如 ["a2"] 或 ["a2", "a3"]），不是序号；每条作者动作原句至少要有一块写它的编号，没有的 check-plan 拒绝并点名；保真核对按它确定性定位步骤，写了不存在的编号会在生成保真简报时被点名拒绝；不改变命令语义
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="OBSERVE_ASSERT"：对象：
      id*: string（非空）
      kind*: 固定为 "OBSERVE_ASSERT"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      assertions*: 列表（至少 1 项，至多 64 项），每项：
        id*: string（非空）
        output*: string（非空）
        op*: string（非空）
        literal*: string（非空）
        count: integer（1..）
        quote*: 对象：
          reference*: string（非空）
          text*: string（非空）
        expectation*: string（非空）
        criterion: string（非空） — Id of the typed criterion in criteria[] that holds your own checkpoint for this author expectation. Write it only when the expectation node carries no literal declaration. The checkpoint is a model judgment, status 未确认, decided by the device run; no independent review is needed and none is started. The criterion's quote, operator and literal (or count, or relation) must equal this assertion's.
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="OBSERVE_ONLY"：对象：
      id*: string（非空）
      kind*: 固定为 "OBSERVE_ONLY"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="CAPTURE"：对象：
      id*: string（非空）
      kind*: 固定为 "CAPTURE"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      register*: string（非空）
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="SELECT_CELL"：对象：
      id*: string（非空）
      kind*: 固定为 "SELECT_CELL"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      from*: string（非空）
      register*: string（非空）
      table*: 对象：
        format*: "delimited" | "key_value"
        separator*: string
        columns*: integer（1..）
        header*: boolean
      column*: integer（1..）
      select*: 下列之一
        · 形状 1：对象：
          row*: integer（1..）
        · 形状 2：对象：
          where*: 列表（至少 1 项），每项：
            column*: integer（1..）
            value*: string
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="CAPTURE_COMPARE"：对象：
      id*: string（非空）
      kind*: 固定为 "CAPTURE_COMPARE"
      left*: string（非空）
      right*: string（非空）
      relation*: string（非空）
      output*: string（非空）
      quote*: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].quote
      expectation*: string（非空）
      criterion: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].criterion
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="EXPECT_FROM"：对象：
      id*: string（非空）
      kind*: 固定为 "EXPECT_FROM"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      expected_from*: string（非空）
      op*: string（非空）
      output*: string（非空）
      quote*: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].quote
      expectation*: string（非空）
      criterion: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].criterion
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="SLEEP"：对象：
      id*: string（非空）
      kind*: 固定为 "SLEEP"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="STEP"：对象：
      id*: string（非空）
      kind*: 固定为 "STEP"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      output: string（非空）
      register: string（非空）
      cleanup: 同 plan.data.blocks[]（kind="CONFIG"）.cleanup
      input_register: string（非空）
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="RESTORE_FROM"：对象：
      id*: string（非空）
      kind*: 固定为 "RESTORE_FROM"
      call*: 同 plan.data.blocks[]（kind="CONFIG"）.call
      register*: string（非空）
      for*: string（非空）
      author_step_refs: 同 plan.data.blocks[]（kind="CONFIG"）.author_step_refs
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="OBSERVE_DIST"：对象：
      id*: string（非空）
      kind*: 固定为 "OBSERVE_DIST"
      payload*: 对象；可带其它键
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="OBSERVE_MEMBER"：对象：
      id*: string（非空）
      kind*: 固定为 "OBSERVE_MEMBER"
      payload*: 对象；可带其它键
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
    · kind="OBSERVE_EXIT"：对象：
      id*: string（非空）
      kind*: 固定为 "OBSERVE_EXIT"
      payload*: 对象；可带其它键
      description: string（非空） — 一行中文，说明这一块做什么（不是抄作者步骤），写进工作簿 D 列；单行，无首尾空白，不以 = 开头。只是说明，不是命令、断言或期望的依据，场景保真核对也看不到它
steps*: 列表，每项：
  object*: string（非空）
  method*: string（非空）
  args*: 列表，每项 string
  keywords*: 对象；其余键的值：string | integer（0..）
  cleanup: 同 plan.data.blocks[]（kind="CONFIG"）.cleanup
  precondition_source: 对象 — 前置步骤来源（可选）：若本步是为使作者命令或触发动作生效而从手册或示例补齐的前提步骤（含对应 cleanup:true 逆清理）且未在重组 sources.states 列出，填锁定 knowledge/ 手册条文或示例的引用及逐字原文，供 Hub 核对引文并列入保真豁免：
    reference*: string（非空）
    text*: string（非空）
  author_step_refs: 列表（至少 1 项，至多 32 项），每项 string（非空，至多 64 字符） — 本步实现的作者步骤编号列表（本步不实现作者步骤时省略）：写本条重组记录里作者步骤的 id（items/<n>.json 的 atoms 里 kind 为 action 的 id，如 ["a2"] 或 ["a2", "a3"]），不是序号；每条作者动作原句至少要有一步写它的编号，没有的 check-plan 拒绝并点名；写了不存在的编号会在生成保真简报时被点名拒绝；不改变命令语义
  description: string（非空） — 这一步做什么的一句话，写进工作簿 D 列，运行报告按它显示步骤
expects*: 列表，每项：
  text*: string（非空）
  quote*: 对象：
    reference*: string（非空）
    text*: string（非空）
  after*: integer（1..）
  op: "not_found" — Use not_found to check absence; omit it to retain the existing found check
  basis: "model_judgment" — 显式声明 model_judgment 时 text 是模型选择的设备可观察检查文字；不写时维持引文片段规则
  rationale: string（非空） — model_judgment 的非空理由；声明是模型判断，Hub 不断言其语义正确
replacements*: 列表，每项：
  case*: string（非空）
  bed*: string（非空）
command_identities: 列表 — 可选的模型身份声明；通常省略。Hub 从 steps 的完整设备命令行按锁定树解析 CommandIdentity，不要求模型填写类型值。若主动声明，commands_known 逐项核结构并与 Hub 解析身份集合完全比对，不一致记违规；不得用声明代替解析，每项：
  对象；可带其它键
block_context: 对象：
  preconditions*: 列表，每项：
    id*: string（非空）
    state*: "present" | "absent" | "unmet"
    for*: string（非空）
    established_by*: 列表，每项 string（非空）
    quote*: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].quote
    missing: string（非空）
    next_action: string（非空）
  causal_links*: 列表，每项：
    from*: string（非空）
    to*: string（非空）
    quote*: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].quote
  responders*: 列表 — Who answers the request a host-command observation sends. One row per host observation block; every row's output must be the id of an observation block of this plan.，每项：
    output*: string（非空） — The id of the observation block this row explains: a blocks[].id of a block that returns device text (OBSERVE_ASSERT, OBSERVE_ONLY, CAPTURE, EXPECT_FROM, or a STEP that declares output). It is never a register name (the register of a CAPTURE or STEP is only the name its text is saved under), never the name of a selected cell and never a device name.
    kind*: "device" | "fixture" | "bed_service" | "undetermined" — Who answers: device (a frozen environment seat), fixture (an earlier step block of this plan), bed_service (a service declared in the frozen environment inventory) or undetermined (not known yet; also write missing and next_action).
    ref*: string（非空） — Identifies the answerer, by kind. device: one frozen runtime-profile device identity, exactly one of profile.seats[].device (not an executor object name and not a block id). fixture: the id of an earlier step block of this plan that provides the answer. bed_service: the host of a service of the frozen environment inventory (services[].host). undetermined: any non-empty text.
    quote*: 对象 — Verbatim source text that grounds the answerer; copy reference and text from the source.：
      reference*: string（非空）
      text*: string（非空）
    missing: string（非空） — Only for kind=undetermined: the fact that is missing.
    next_action: string（非空） — Only for kind=undetermined: the next step that would settle it.
criteria: 列表（至多 128 项） — Checkpoints you chose yourself for author expectations that carry no literal declaration (the author wrote a sentence, not the text to look for). Each entry is a model judgment, status 未确认: the Hub only checks that quote is the author's expectation word for word, that literal is a single line and that the entry equals its assertion; no independent review is needed and none is started, and the device run decides whether the checkpoint holds. quote: the author's expectation, copied verbatim from the original case. literal (or count, or relation): text the device output can contain. rationale: why you chose it. scope_root: the locked root of the command tree. A criteria_review input is read only when one is bound; leave it unbound.，每项：
  id*: string（非空）
  expectation*: string（非空）
  quote*: 同 plan.data.blocks[]（kind="OBSERVE_ASSERT"）.assertions[].quote
  kind*: "literal" | "count" | "capture_relation"
  operator*: "found" | "not_found" | "abs_found" | "found_times"
  literal: string（非空）
  count: integer（1..）
  relation: string（非空）
  rationale*: string（非空）
  scope_root*: string（非空）
obligations: 列表（至多 128 项），每项：
  expectation*: string（非空）
  status*: "asserted" | "unmet"
  assertions*: 列表，每项 string（非空）
  missing: string（非空）
  next_action: string（非空）
recomposition: 对象：
  receipt*: string（非空）
  record_sha256: string（至少 64 字符，至多 64 字符） — The 64 lowercase hex digits of sha256 over the canonical JSON of this case's recomposition record (late.json items[].late.recomposition.record_sha256). Required when the record is bound after the run started: the plan is checked against it, not against the receipt, which changes whenever another case of the same recompose run is accepted
  case_id*: string（非空）
  slots*: 列表，每项：
    slot*: string（非空）
    assertions*: 列表（至少 1 项），每项 string（非空）
  rebindings*: 列表，每项：
    slot*: string（非空）
    from*: string（非空）
    to*: string（非空）
    authority: string（非空）
    source_of_value: string（非空）
fidelity: 对象：
  brief_sha256*: string（至少 64 字符，至多 64 字符）
  steps*: 列表（至少 1 项，至多 256 项），每项：
    n*: string（非空，至多 64 字符）
    verdict*: "preserved" | "changed" | "unrealized"
    step_indices*: 列表（至多 256 项），每项 integer（1..）
    rationale*: string（非空，至多 4096 字符）
    model_judgment: 对象：
      status*: 固定为 "未确认"
      decided_by*: 固定为 "模型"
      model_version*: string（非空，至多 128 字符）
      task*: "match" | "choice" | "sequence"
      choice*: string（非空，至多 128 字符）
      confidence*: number（0..1） | null
      gate: 对象：
        action*: "pass" | "review" | "reject"
        reason: string（至多 512 字符）
      request_sha256: string（至少 64 字符，至多 64 字符）
  disclosure*: string（非空，至多 8192 字符）
  model_disclosure: 对象：
    status*: 固定为 "未确认"
    decided_by*: 固定为 "模型"
    model_version*: string（非空，至多 128 字符）
    request_sha256: string（至少 64 字符，至多 64 字符）
    prompt_version: string（非空，至多 128 字符）
    review_required_steps: 列表（至多 256 项），每项 string（非空，至多 64 字符）
