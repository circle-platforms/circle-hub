# 任务：解析失败的原因传到调用方，收下合法编码，中文换行处的引文比对

依据：

- xlsx-parser 的交接（`hub/refs/README.md` 的 “Needs from other packages” 一节，在 xlsx-parser 分支上）：
  - 所有解析器都拒收一份上传时，`recognize()` 把原因丢了，上传和开跑的回答里看不到确定的原因；
  - 中文手册在两个字中间硬换行时，现在的引文比对要求模型在那里写一个空格，否则对不上。
- 未知普查 `docs/hub-r4-research/unknown-sweep.md` 第 2 节的潜伏缺陷：合法的 GB18030、GBK、Big5、UTF-16 编码和不带实体的 DOCTYPE 被拒，`recognize()` 吞掉原因（`hub/refs/text-decoding.ts:99-104`、`parsers/xml.ts:358`、`parser.ts:266-280`）。
- 进度页决定 37。

- 分支和工作树：`refs-diagnostics`，目录 `circle-hub-refs-diagnostics`（从 hub-redesign 开出，依赖已装好）
- 可以改的路径：
  - `hub/refs/**`（`parser.ts` 的 `recognize()`、`text-decoding.ts`、`parsers/xml.ts`、`quote.ts`）和测试；
  - `hub/rules/quote-vectors.json` 里受第 3 条影响的两条向量；
  - `hub/server/upload.ts`、`hub/server/tools.ts` 里上传回答的那一段，`hub/runs/engine/inputs.ts` 里绑定被拒的那一段；
  - `contracts/model.json`：只加一个协议码，照第 1 条写，照生成器重新生成，`--check` 要过。

  别的路径不动。K2 和 kb-links 也改 `tools.ts`、`inputs.ts`，只动必要的几行，合并时集成者对齐。
- 规则：同前（不推送、不建 PR、不发布、不部署；不碰 7420、钥匙串、环境配置文件和任何真实系统；测试只用合成数据；`git commit -s`）。所有者的规矩：未知只能是过渡状态，写明缺的事实和下一步动作；枚举只来自生成的词表。
- 验证：`npx tsc --noEmit`；`node tools/gen-contracts.ts --check`；`node --test --test-concurrency=1` 对 `hub/refs/**`、`hub/rules/**`、`hub/server/**`、`hub/runs/**`、`contracts/**`。

## 要做的

1. **解析失败的原因传到调用方**：
   - `recognize()` 保留最后一个拒收的解析器给的 ParseError（规则名和说明，不回显原文）；
   - 上传和开跑绑定被拒时，回答写出这个确定的原因和改法；
   - 协议码加 `SOURCE_UNPARSEABLE`，修正说明写“上传能按声明格式解析的文件，或换用对应的解析器”；
   - 测试：xlsx、xml、json 各一份解析不了的上传，回答里有那条原因。
2. **收下合法编码**：
   - 带 BOM 的 UTF-16 LE 和 BE、GB18030、GBK、Big5，按声明或 BOM 解码，Node 自带的 TextDecoder 就够；
   - 不带实体声明的 DOCTYPE 照常解析，带实体的照旧拒绝；
   - 解不出来的写明是哪种编码、在第几个字节。
   - 测试：每种编码一份合成文件，正反例各一。
3. **中文换行处的引文比对**：
   - 规则：一段空白两侧任意一边是东亚宽字符或全角字符时，比对时去掉这段空白；两边都是拉丁字母、数字或符号时，照旧折成一个空格（`set 10 0` 和 `set 100` 仍然不同）；
   - 改 `hub/rules/quote-vectors.json` 里“空白折叠不删除”“引文多一个空格就不同”两条向量，各加中文的正例和拉丁的反例；
   - 规则写进 `hub/refs/README.md`，判定和诊断用同一个函数。

完成后在终端里回报：提交号、测试数量、没做完或拿不准的地方。
