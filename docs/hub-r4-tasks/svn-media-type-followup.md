# 任务：SVN 媒体类型映射合入后的旧测试变红，回执要保留服务器原话

依据：`docs/hub-r4-tasks/svn-media-type.md` 的合入（`7ce86f1f`）；所有者的规矩"事实只来自带版本的规则和核对过的观察；观察到的、声明的和推断的分开"。

## 现象

`7ce86f1f` 合入后，`node --test hub/knowledge/svn-declared-parser.test.ts` 有 5 项失败（该测试在 `hub/knowledge/`，上一件任务只跑了 connectors、系统包、contracts、docs，没跑到）：

- `receipt.requests[0].media_type` 现在是 `text/plain`，测试期望服务器说的 `application/octet-stream`；
- 原件的 `media_type` 同样变成 `text/plain`（见下面第 2 点，这一项是有意的设计变化）；
- `undeclared-list` 模式原来期望整份产出失败（"没有支持此媒体类型的核心解析器"，未声明的 octet-stream 原件 fail-closed），现在 `.adoc` 被系统包映射成 `text/plain`，不再失败。

## 判断（集成者）

映射放在系统包（`media_types_by_extension`）是对的：系统包知道自己那台服务器把文本都标成 octet-stream，产品包不该为这个毛病在每个输入组上写 `parser: 'text@1'`（那是上一层的权宜做法，保留，不删）。但有两处要改：

1. **回执要记服务器说了什么。** `ReadManifest.requests[].media_type` 是观察到的事实，应保持服务器的 Content-Type（缺省时仍是现有的默认值）；映射后的类型只记在原件上。两者不同，就说明系统包规则起了作用（读清单带系统包版本）。不要把映射结果写回观察到的那一栏。
2. **原件的 `media_type` 记生效的类型**（映射后的 `text/plain`）：这是规则起作用的声明性解释，字节一个都没动。

## 要做的

1. `hub/connectors/http.ts` 的 `HttpExchange` 加 `serverMediaType`（服务器说的，缺省时用现有默认值），`mediaType` 仍是生效的；`hub/connectors/read.ts` 里 `requests[].media_type`（约 462 行）改用 `serverMediaType`，其余（入库、函数拿到的 view、回显扫描）仍用生效的类型。若要改 `ReadManifest` 形状先说明理由；能不改形状就不改，改了要 `npm run gen:contracts` 并交出生成差异。
2. `hub/connectors/README.md`、`packs/system/svn/README.md` 各补一句：回执记服务器原话，原件记生效类型。
3. 改 `hub/knowledge/svn-declared-parser.test.ts`，**保留每一项断言的意图**，逐项在提交说明里写清楚改了什么、为什么：
   - 第一项测试（产品包 adoc 组显式声明 `text@1`）原样保留；
   - 回执的 `media_type` 断言保持 `application/octet-stream`（现在靠第 1 点成立）；
   - 原件的 `media_type` 断言改为映射后的 `text/plain`，并加一条：回执与原件两栏不同；
   - 字节不变、NUL 计数（`nulRemoved`）的断言原样保留；
   - "声明组才解析、未声明 fail-closed"：未声明的 `.adoc` 现在由系统包规则解析，所以 `undeclared-list` 改成用**映射表里没有的扩展名**（例如 `.bin`）的原件，仍期望整份失败并带现有的说明；另加一个 `.adoc` 的 `undeclared-list`，期望成功；
   - 声明组的警告文字断言（"服务器媒体类型 application/octet-stream，按来源声明以 text@1 解析"）：先看实际行为——如果映射后不再触发这条警告，说明这条警告在 `.adoc` 上变成多余，改成断言"不出现这条警告"；如果产品包声明和系统包映射同时作用时出了别的行为，写进回报，不要自己拍板。
4. 全量：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=2` 对 **`hub/**/*.test.ts`、`packs/**/*.test.ts`**（不是只跑相关目录）、`contracts/**`、`.github/checks/*.test.ts`；`tests/acceptance/` 里涉及 SVN、source-read、知识产出的场景。报每一组的数量。

## 分支、路径和规矩

- 分支和工作树：`svn-media-type-followup`，目录 `agy-trees/svn-media-type-followup`（集成者已从 hub-redesign 开出，依赖已链接）。
- 可以改的路径：`hub/connectors/http.ts`、`hub/connectors/read.ts` 及它们的测试，`hub/knowledge/svn-declared-parser.test.ts`，`hub/connectors/README.md`、`packs/system/svn/README.md`；若必须改 `contracts/src/resources.ts`，先说明理由。别的路径要改先说明。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰线上 Hub、钥匙串、环境配置文件和真实系统；测试只用合成数据；`git commit -s`，只暂存明确路径）。不放松任何旧断言；每条改动的断言在提交说明里逐条解释。若系统包有文件变动要升版本并重签（`node packs/system/svn/api.ts check` 看是否需要）。

完成后在终端里回报：提交号、各组测试数量、改了哪些断言和理由、没做完或拿不准的地方。
