# adjudicate 1.1.8

本地修正 1.1.8（2026-11-14）：同步 `testing/gen-recompose.ts` 生成的共享 `functions/text.ts` 与 `functions/recompose-evidence.ts`（接受 recompose `1.2.4` 与 authority `1.1.8`）；能力与核对规则相对 1.1.7 不变。本次不发布。

本地合并候选 1.1.7（2026-11-12）：acceptsPack 接受 recompose stage 1.2.3；能力相对 1.1.6 不变。本次不发布。

# recompose-adjudication 1.1.6

本地合并候选 1.1.6（2026-11-12）：acceptsPack 接受本包 1.1.5/1.1.6；能力相对 1.1.5 不变。本次不发布。
本地合并候选 1.1.5（2026-11-12）：与 recompose 同步接受 1.2.1 并重签清单；能力相对 1.1.4 不变。本次不发布。

本地版本 1.1.4（2026-11-12）：同步共享的重组版本读取代码；已存 1.1.3 的来源继续可读。本次只提交本地，不发布。

case-compile 的独立工作阶段。共享规则来自父目录 tables 和 functions，由 testing/gen-recompose.ts 生成副本；运行发布时单独 stage，不把父目录 README、api.ts 或测试文件带入包。
