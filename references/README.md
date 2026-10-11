# 参考库从哪里读起

参考代码按职责建立索引，原件不拆散。当前收录 infosec-platform 提交 4ab6c5ea593eb1b1d71bed92374b3a013ba61ad9 的完整 427 份跟踪文件，包含 16 个 package，以及相邻的样本、原型、研究和文档。每个原件只保存一份。

| 入口 | 主要内容 |
|---|---|
| [B](platform/by-object/B.md) | 知识记录、快照和证据登记 |
| [C](platform/by-object/C.md) | 内存与 PostgreSQL 任务服务 |
| [D](platform/by-object/D.md) | 操作、租约、进程/浏览器控制，以及合成设备 driver |
| [E](platform/by-object/E.md) | 问答、评审、脑图/工作簿和规则式判断 |
| [A](platform/by-object/A.md) | 前端界面和组件参考 |
| [F](platform/by-object/F.md) | 共同格式、类型和支持材料 |
| [G](platform/by-object/G.md) | 测试、校准、模拟环境、协议 stub、模型评测与历史原型 |

完整 package 保留在 [platform/snapshot/packages](platform/snapshot/packages)，冻结合成样本保留在 [snapshot/samples](platform/snapshot/samples)。同一 package 涉及多个职责时，按文件列出索引，保留原依赖路径。

[来源清单](source-manifest.json)登记提交、源路径、目标路径、Git blob、SHA-256 和参考类别。共享 Circle 基线有 287 份原件，保存在 foundation/circle。源码未改；分类说明只是本轮归档安排，不是业务接口验收。

参考中的历史“已通过”、固定客户端版本、样本冻结和模拟角色，沿用其原记录的范围与时间。当前归档没有重新运行模型、设备、浏览器或数据库测试。llm-assessor 的外部桥接及实验脚本不进入生产运行路径。

源仓库仍保留原提交和记录。后续采用某项实现时，为正式模块建立当前输入、独立预期、权限与消费者检查，不在冻结原件上继续开发。
