# packs/system/plm

The system pack of the PLM query service (brief section 8): reads only. The service answers HTTP 200 with an envelope
`{code, msg, data}` (code 1000 ok) and shares its `/plmquery/` prefix with a write route, so the profile lists every read
route one by one (method and path template) and has no write route.

| Read | Gives |
| --- | --- |
| `plm:bug:<id>`, `plm:story:<id>` | the original answer, content `{id, kind, title, fields, html_fields}` (every HTML field as plain text, empty lines dropped) and meta `{id, kind, title: "缺陷 <id> <title>" or "需求 <id> <title>", status}`; an id the service does not know is a failed read (unavailable to callers) |
| `plm:bugs:<id>+<id>+...` | the original answer, content `{bugs: [{id, status, title}], unread: [<ids>]}` (up to 50 ids, sorted numerically, deduplicated); unreturned ids listed in unread |
| `plm:products:<any>` | the product list (`GET /plmquery/product/all/`) |
| `plm:builds:<product id or encoded names>` | a product resolved by explicit id or all requested names, and its build list; content `{product, product_resolution, builds: [{id, name, stories, scope_note}]}`; the original is the build array after product selection, or the enveloped product list when names remain unresolved or ambiguous |

Profile: roles `plm-oauth` (the same login as the agile platform: the token works for both) and `plm-api`; auth
`login_token` (password `sha512_base64`, envelope code 1000 ok); routes `products`, `builds`, `bug-detail`
(`POST /plmquery/bug/detail/`), `story-detail` (`POST /plmquery/story/detail/`), all read.

Functions: `functions/plm.ts` (detail and batch readers, `buildsPlan`, `buildsProject`, HTML-to-text helpers). Not published: `api.ts`, this README,
`plm.test.ts`.

Test: `node --test --test-concurrency=1 "packs/system/plm/*.test.ts"` (the profile is read-only by construction: no route outside the four reads,
the write path of `tests/fixtures/plm` unreachable; bugs and stories with numbers and strings as ids, HTML fields, an unknown
id). The end-to-end test binds `plm:story` and `plm:bug` as expected sources of a review.

Needs: none.

## 批量需求读取

`plm:stories:<编号>+<编号>+…` 使用现有只读需求详情路由；最多 50 个编号，数值排序、去重。内容为 `{stories: [{id,status,stage,title,fields_absent,fields_nonscalar}], unread: [...]}`。标量状态和阶段独立保留原样；缺字段以 null 占位并列入 fields_absent，非标量值以 null 占位并列入 fields_nonscalar，原值保留在原件；应答未包含的编号列入 unread，是确定的应答事实，不推断已交付或已关闭。调用方把更多编号分成每组至多 50 个。

合成验证：`node --test --test-concurrency=1 packs/system/plm/*.test.ts`。真实需求状态与阶段取值由集成者核实，当前不需要新词表轴。

可选构建需求范围：`plm:builds:<产品编号>` 的原件仍保留原样数组，content 在 1.2.0 合并产品解析结果，构建项保留 `{id,stories,scope_note}` 并增加 name。管理员在资源设置里配置 `settings.build_story_field`，字段名需先核实真实原件；只接受该顶层字段的正整数编号数组（数字或字符串），不猜字段、不解析自由文本。没配置、字段缺失或形状错误时 stories 为 null，scope_note 指出具体缺口并请求用户给出编号。合成测试中的字段名只是结构示例，不能作为真实字段默认值。

## 1.2.0：修复字段声明和产品名字解析

缺陷详情 content 回传 `fix_field` 和 `fix_notes`。`settings.bug_fix_field` 为非空字符串时 `fix_field` 原样是该字段名，否则为 null。不猜 fix 等默认名字，不从其他字段兜底，也不判这条缺陷有没有该字段；消费方检查 fields。`settings.bug_fix_actions` 是 JSON 字符串数组（动作码闭集）时，`fix_notes` 只收 `actions` 里 `action` 与数组成员完全相等、且 `comment` 非空的条目，按原顺序写成 `{action, date, actor, comment, index}`；comment 原文不改，HTML 按本包既有方式转纯文本，原件仍保留应答。没配置或形状不对时 `fix_notes` 为 null，`fix_notes_note` 和读取说明写明缺的是 `settings.bug_fix_actions`。不按正文挑选动作。需求详情和批量缺陷输出不加这两个字段。设置在 system.json 的 bug 读取说明中声明（当前 system@1 没有设置 schema）。动作码必须由集成者在真实只读冒烟后照原件核实，再配置部署资源。本包没有读取或修改真实资源设置。

`plm:builds` 现在使用规划函数，最多两次请求：

- 数字键保留原来的产品编号查询，只读构建列表。content.product 为 `{id, name: null}`：编号由调用方明确给出，未查询产品名，不虚构名字；product_resolution 为 resolved 不表示另行证明产品存在。
- 名字键是逐个 URI 编码的名字，以字面的 `+` 分开；名字中的加号编码为 `%2B`。产品名整串先 NFKC，再按 `/` 切开（全角 ／ 经 NFKC 也成为分隔符），各段 trim、String.prototype.toLowerCase 后逐个别名精确匹配，必须包含请求的每个名字。先读产品列表，正好一条匹配才按其编号读构建列表；零条为 unresolved，多条为 ambiguous，二者都不请求构建。
- content 为 `{product, product_resolution, builds}`。每个构建为 `{id, name, stories, scope_note}`，保留 story-trace 的配置需求范围行为；name 原样取记录的 name，没有则为 null。原始构建数组不改，不推断发布状态。
- `settings.build_story_field` 仍只表示部署声明的顶层需求字段；无声明或字段不可用时 stories 为 null，scope_note 写明缺哪个事实并请求需求编号。产品原件无法解析时读取失败，要求重读产品列表并核实 id/name，不把不可读当零个匹配。

合成验证：`node --test --test-concurrency=1 "packs/system/plm/*.test.ts"`；覆盖数字键、唯一名字、未找到、歧义、空构建列表、两族名字归一化、修复字段配置与未配置，并在临时 PostgreSQL、回环桩服务和真实连接器沙箱中核对实际请求次数与内容。未改既有桩数据；真实产品名和构建 name 字段仍由集成者冒烟核实。

第二步的 case-review 要求项与独立金标准不在本次改动中，等待集成者通知。

Batch story fields `status` and `stage` preserve JSON scalar values (including numbers, booleans and explicit null).
`fields_absent` names fields the successful original did not contain; no missing lifecycle value is inferred.
Since 1.3.2 the manifest signs the read description and function bytes together (the current version is in `pack.json`); raw originals remain unchanged.

复核 3：构建 content 每条新增 fields，逐字保留原始记录的全部 JSON 标量字段（含数字 id、name、布尔、null）；数组和对象不混作标量。顶层 id/name/stories 维持已有接口，原始 name 不 trim、不另取字段兜底。原件不变，workflow 通过 name 与绑定视图和可信构建上下文核对同构建、同根，再在条目 data/陈述中指明选中记录。

复核 8：构建需求数组每个值先由 idText 去首尾空白，再按正整数规则验证，并用同一份文字去前导零、去重、数值排序。不会把已通过验证的值再按未去空白的原串输出；空白、纯零和非整数仍不是有效需求编号。原始应答和原数组不变。

第二轮复核 1：产品未唯一解析时 builds 为 null（没有读构建列表），与已读的空数组区分；content 带 requested_names、按不同产品编号去重的 candidates 及下一步 note，投影 complete:false 同时进入读取清单。重复一条产品记录不制造歧义。story-traceability 已先检查 product_resolution，不能把未读列表当“没有该构建”。

第二轮复核 2：上述次序由集成者确认，独立金标准采用相同规则；toLowerCase 不承诺完整 Unicode case folding。请求名字规范化后若仍含 / 则为无效键，必须每族名字分别编码后用 + 连接，不读取产品列表后再伪报未找到。

第二轮复核 3：数字键仍只发一次构建请求，note 同时写进 content 和读取清单：产品编号取自读取键，没有对照产品列表核对，空构建列表不证明产品存在。需要核对产品身份时下一步对照产品列表或按名字读取；不把调用方给的编号当成已证明存在。

第二轮复核 5：真实连接器测试核对失败信封、无效键、901 字节标识及未解析读取清单，检查具体码、原因、实际请求和 original/coverage。集成者在 plm-fields-c3 的第 3 条答复中确认保留核心改动：hub/connectors/read.ts 的统一字节计数、严格解析和 executeRead 长度拒绝；hub/connectors/connectors.ts 的 reader.accepts 类型路由及 reader.read 长度原因；hub/connectors/README.md 的说明。只写实际字节数与 900 字节上限，不回显键；不放宽长度规则或请求权限。任务页的授权记录由集成者补齐。

## Story fields that are not single JSON values

Version 1.3.0 never rejects a story batch merely because one status or stage is an object or array. Scalar values and
explicit null remain unchanged. A non-scalar field is listed in fields_nonscalar, with null only as the content model's
placeholder; fields_absent remains separate. Its original raw JSON is retained in the original response artifact. The
consumer reports status_nonscalar and stage_nonscalar as observed counts, excluding these fields from scalar grouping;
this is a known observation, not an unknown lifecycle state. Other stories in the same batch remain readable.

Version 1.3.1 closes the counted external-id entry path with the connector core. Normal connector callers see its generic byte-limit refusal before the pack plan runs; the pack-specific name/id hint is only a defensive direct-call check, not a reachable connector reply. The paired story-traceability 1.0.6 stores build identity once and keeps the raw scalar fields in this content. Both manifests are re-signed; no live deployment is part of this change.

Closure c3 #2: signed stories text distinguishes scalar, absent and non-scalar fields and the observed unread list.
The connector owns the identity byte limit and normal callers receive its generic shortening instruction; this package
does not claim its defensive direct-call size advice is visible through the connector.

c3 #4：有权启动本任务包的有效读者看到确定的标识超长错误：实际 UTF-8 字节数、900 字节上限、缩短读取键的办法；不回显键，不发请求。沿用 inputs.ts 其他参数校验的 SUBMISSION_SCHEMA_VIOLATION，统一 start_run 参数码由模型修订决定。未分配任务包或无效读者仍只得到中性答复。

范围边界：超过 ExternalObjectId 的 8192 字符上层模式限制时，start_run 在输入绑定前已经拒绝，仍用上层模式的说明；本批没有改 contracts 或 start.ts。若要让这一层也给出同样的字节计数提示，由模型修订者在统一 start_run 参数拒绝契约时安排。

Closure B2: storiesProject retains the entire batch when status or stage is not a scalar. It emits fields_nonscalar,
separate from fields_absent and explicit null; the workflow counts these observed fields outside the scalar-status groups.
A regression feeds this actual projection into story-traceability instead of manufacturing the marker in a fixture.

缺席观察：读取声明的 `absent_codes` 包含 `plm.absent`。仅在原始应答已保存、根据全部可读且无其他读取故障时，Hub 将该码转为带系统、对象、读取时刻和应答键的 SOURCE_ABSENT；原件照存，检查读取独立的规范 JSON 观察。401/403、未读完或凭据保留不作缺席。
