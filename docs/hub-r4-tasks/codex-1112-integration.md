# 11-12 本地集成

按本轮任务书审阅并合入 A1–A7 与 B1–B3；Circle A8 留在独立分支。版本安排来自派活方，不记作所有者决定。本页不改 docs/hub-r4-progress.md。

范围：六个受影响包的版本、清单与版本记录，case-compile 生成器及四个合成 Excel 样例、既有版本断言、共享重组读取代码及生成副本；CHANGELOG.md、docs/compatibility.md、docs/compatibility.en.md 和本页。MCP 机器引用契约由 B1 分支交付。

保留旧重组结果的明确版本，不改变历史记录。最终只在 infotest-pass-audit 运行一次 npm test，单元测试共享通道并发设为 2；其他完整检查不重复运行。测试、跳过及未决项逐条写在任务书同目录的外部进度与报告中。无 push、发布或部署，不访问 homes/、真实测试床或设备。
