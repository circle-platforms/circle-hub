# T8：第 31 轮原因传递与交付修复

依据：所有者 2026-11-16 的 T8 任务书和完整只读诊断。在指定 hub-next-7 分支直接提交，原 tip ec5941ba9d；不推送、不部署、不改运行中主目录。真实诊断和离线重放材料留在私有验收目录，不进入 Git。

## 可改路径

- 合并 wp/claude/plumb-example 的 plumb 示例、测试、清单与 case-compile 嵌入声明。
- hub/server/text.ts、text.test.ts、README.md；hub/dispatch/api.ts、bed-lifecycle.ts、bed-state.test.ts、README.md；hub/ports.ts；hub/runs/engine/dispatch-results.ts、其测试与 README.md。
- contracts/src/tool-shapes.test.ts 的授权文字摘要钉值，其余输入、工具与服务钉值不动。
- packs/workflow/case-compile 的交付、下载、报告函数、技能文字、测试、生成工具、样例与清单；版本为 3.21.2，plumb 为 1.0.1。其他包字节如改变则另升号。
- 中英文 compatibility、CHANGELOG、本文与 doc-set 登记。私有进度、重放和交接按所有者指定位置保存。

## 决定与边界

模型漏写的作者冲突不能从散文猜出；未曾提交的条目不能凭笔记变成 Hub 具名结论。保留这个边界，补齐结构示例和逐条修复提示。未派发 result 仅为预检引用，不能说设备输出已取回；原因与成员可读事实从 Hub 传到导出和本地工具。机器资料保留原身份、期限和观察；使用者报告显示角色、本地分钟和实际执行次序。

最后写法采用同一谱系内、Hub 可完整导出的最近受理计划；不把它是否上过机混为一谈。未派发作业仍须核对工作簿摘要和完整用例范围。整批未派发可披露已知 Hub 原因，不捏造设备历史；没有可核验结论或具名事实时非零退出，stdout.hints 逐条给缺口和合法示例，其他条目与未知报告仍保留。

设备 evidence 保持单字符串，只接受一个文件中连续的一段，不增加跨文件拼接形式。程序只按已有身份语法检查内部引用，不按散文关键词归因。使用者报告按本包完整尾注格式省略技术身份；上游原始结论、判定数据与冻结来源保持完整，不按关键词改写周围事实。报告不把动态完整性字段名直接当作可读缺失事实；设备自报映射与 Hub 未采用必须分别保留。

## 验证

先在旧实现或隔离旧字节上复现红灯，使用合成 fixtures；再运行类型、合约、case-compile、plumb、scripts/real、受影响 server/dispatch/engine 和 docs。私有三份 sim 回放最后各跑一次并保留只读收据；它们不连接 Hub 或设备，不证明真实系统修复。含 PG 的检查由 T8 持有外部互斥锁；全量回归由整合者再跑。
