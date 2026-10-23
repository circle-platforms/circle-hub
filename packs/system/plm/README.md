# packs/system/plm

The system pack of the PLM query service (brief section 8): reads only. The service answers HTTP 200 with an envelope
`{code, msg, data}` (code 1000 ok) and shares its `/plmquery/` prefix with a write route, so the profile lists every read
route one by one (method and path template) and has no write route.

| Read | Gives |
| --- | --- |
| `plm:bug:<id>`, `plm:story:<id>` | the original answer, content `{id, kind, title, fields, html_fields}` (every HTML field as plain text, empty lines dropped) and meta `{id, kind, title: "缺陷 <id> <title>" or "需求 <id> <title>", status}`; an id the service does not know is a failed read (unavailable to callers) |
| `plm:bugs:<id>+<id>+...` | the original answer, content `{bugs: [{id, status, title}], unread: [<ids>]}` (up to 50 ids, sorted numerically, deduplicated); unreturned ids listed in unread |
| `plm:products:<any>` | the product list (`GET /plmquery/product/all/`) |
| `plm:builds:<product id>` | the build list of a product (`GET /plmquery/build/?product=<id>`, a plain array) |

Profile: roles `plm-oauth` (the same login as the agile platform: the token works for both) and `plm-api`; auth
`login_token` (password `sha512_base64`, envelope code 1000 ok); routes `products`, `builds`, `bug-detail`
(`POST /plmquery/bug/detail/`), `story-detail` (`POST /plmquery/story/detail/`), all read.

Functions: `functions/plm.ts` (`detailPlan`, `detailProject`, `htmlText`). Not published: `api.ts`, this README,
`plm.test.ts`.

Test: `node --test packs/system/plm/plm.test.ts` (the profile is read-only by construction: no route outside the four reads,
the write path of `tests/fixtures/plm` unreachable; bugs and stories with numbers and strings as ids, HTML fields, an unknown
id). The end-to-end test binds `plm:story` and `plm:bug` as expected sources of a review.

Needs: none.

## 批量需求读取

`plm:stories:<编号>+<编号>+…` 使用现有只读需求详情路由；最多 50 个编号，数值排序、去重。内容为 `{stories: [{id,status,stage,title}], unread: [...]}`。状态和阶段独立保留原样；缺字段为 null，未返回编号单列，不推断已交付或已关闭。调用方把更多编号分成每组至多 50 个。

合成验证：`node --test --test-concurrency=1 packs/system/plm/*.test.ts`。真实需求状态与阶段取值由集成者核实，当前不需要新词表轴。

可选构建需求范围：`plm:builds:<产品编号>` 的原件仍保留原样数组，新增 content `{builds: [{id,stories,scope_note}]}`。管理员在资源设置里配置 `settings.build_story_field`，字段名需先核实真实原件；只接受该顶层字段的正整数编号数组（数字或字符串），不猜字段、不解析自由文本。没配置、字段缺失或形状错误时 stories 为 null，scope_note 指出具体缺口并请求用户给出编号。合成测试中的字段名只是结构示例，不能作为真实字段默认值。

Batch story fields `status` and `stage` preserve JSON scalar values (including numbers, booleans and explicit null).
`fields_absent` names fields the successful original did not contain; no missing lifecycle value is inferred.
The unreleased package stays at 1.1.0; story projection fixes only require re-signing this manifest.

Closure B2: storiesProject retains the entire batch when status or stage is not a scalar. It emits fields_nonscalar,
separate from fields_absent and explicit null; the workflow counts these observed fields outside the scalar-status groups.
A regression feeds this actual projection into story-traceability instead of manufacturing the marker in a fixture.
