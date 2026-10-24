# packs/product/lumen-api

A second, invented product to prove that the core is product-neutral (brief section 9, scenario 8): Lumen API, a REST
service whose catalog `commands@1` holds endpoints, not CLI commands. It is reviewed by the same `case-review` workflow pack,
read through the same system packs (the document store) and produced by the same knowledge service, with no core change.

## The pack

| File | Content |
| --- | --- |
| `product.json` | `product@1`: one name `Lumen API`; `sync` (start `manual:file:lumen/releases.md`, plan `functions/sync.ts`); `select_build` `functions/select.ts`; catalog `commands@1` (entry kind `definition`, producer `endpoints`, complete, case-insensitive); producer `endpoints` (slot `spec` <- source role `spec`) |
| `functions/sync.ts` | the release list (a Markdown table: build, version, build time, release time, the path of the endpoint reference in the document store) -> one build per row, its own base, line = the first two numbers of the version, source `spec` = `manual:file:<path>`; a row that does not parse (or whose path leaves the store) is skipped with a note |
| `functions/select.ts` | the newest released build of the line asked for (else of the newest released line); a line without a release gets its newest build, said so in the basis |
| `functions/endpoints.ts` | the endpoint reference (markdown@1) -> one `definition` per section titled `<METHOD> <path>` at `/endpoints/<METHOD>/<segments>`, catalog-entry@1 data (`words` = method and path, one signature from the parameter table: exact int/string/enum/port types, explicit JSON boolean optional, typed bounds and JSON enum arrays) |
| `functions/common.ts` | table rows, lines, ISO times, version order |

An endpoint is cited as `<METHOD> <path> <values...>`, the values in the order of its parameter table: `GET /v1/pools 500` is
out of range for `limit` (1-100), the expected refutation of a negative case. Not published: `api.ts`, this README, the tests
and `testing/` (the release list, the 2.1.0 reference, a 2.0.4 reference without DELETE, and a review mind map).

## How to test

```
node --test "packs/product/lumen-api/**/*.test.ts"
node --test packs/workflow/case-review-verify/end-to-end.test.ts
```

`functions.test.ts`: the profile, the plan, the build choice and the producer against the product@1 shapes on good,
malformed and hostile input, in process and in the Hub sandbox. The end-to-end test syncs the product from a WebDAV stub
through the manual-store system pack into two roots (2.0 and 2.1), reviews the mind map on both lines with `case-review`
and shows that the same membership statement (`DELETE /v1/pools/{id}` exists) holds on 2.1 and is contradicted on 2.0.

## Decisions and limits

- The releases and references live in the document store (read as `manual:file:<path>`): the build-site system pack reads
  only XML and HTML files, and a second product needs no new system pack.
- Endpoint words are the method and the path as written (braces kept); the parameters are positional.
- No manual, no defects, no aliases: the product is deliberately small.

## Needs from other packages

None.


## 参数结构语法 2（R4 / U22，包 1.1.0）

`lumen-endpoint-parameters@2` 是本包给合成 API 参考声明的完整八列语法，列名和顺序必须精确为 `name | type | optional | minimum | maximum | minLength | maxLength | values`。type 只支持 contracts 已声明的 int/string/enum/port；optional 是精确 JSON 布尔 `true`/`false`，不能从说明推断。数值约束是完整非负安全 JSON 整数，空单元格代表该约束未声明；enum 的 values 是非空且无重复的 JSON 字符串数组，其余类型的该列必须空。错列、错值或未知 type 拒绝该 endpoint 的目录生产，并给来源作者在下次同步前修订的出口；不把坏参数忽略成无参 endpoint。旧三列中文说明表不再是参数语法。1.0.0 的旧结果不改，参数域和 optional 字段按旧规则限定；1.1.0 重产新根，真实迁移由集成者另行授权。

参数表缺席不当作零参数：零参数同样需要显式空表。缺字段、非法字段、重复端点或截断均使 grammar.complete=false，核心目录保留未完整核对状态；补结构字段后重产。本次续接未运行验证。
