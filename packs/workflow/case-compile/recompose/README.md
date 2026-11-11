# recompose 1.2.0

本地版本 1.2.0（2026-11-12）：原始用例与手册冲突交使用者决定，说明及本地工具采用统一措辞，内嵌 command-tools 1.1.0。读取已存重组结果时明确接受 1.1.3 和 1.2.0。本次只提交本地，不发布。

case-compile 的独立工作阶段。共享规则来自父目录 tables 和 functions，由 testing/gen-recompose.ts 生成副本；运行发布时单独 stage，不把父目录 README、api.ts 或测试文件带入包。
