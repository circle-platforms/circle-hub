# 任务：按条件列出 PLM 缺陷

依据：决定 111（所有者，2026-11-01：问 NetPjm 的缺陷页为什么能多条件过滤，随后选"现在做，重放前补上"）；通用模型 A05 R[0]、R[1]、R[3]，D05 R[8]。

所有者在重放里问"看下 plm 上 jiangyz 我自己名下多少 bug"，Hub 答不了：PLM 系统包只声明了按编号读缺陷和需求，没有声明查询服务的缺陷列表接口。这个接口按 product、status、severity、assignedTo、openedBy、lastEditedDate_start/end 过滤，不分页（2026-10-12 只读探测记下的结构）。

- 分支和工作树：`plm-bug-list`（从 hub-redesign 开出）
- 可以改的路径：
  - `packs/system/plm/**`（加路由 `bug-list` 和读法 `plm:bug-list`，升 1.3.6）；
  - `packs/workflow/source-read/**`（加输入槽 `defect_list`，升 0.1.3）；
  - 以上的测试。
- 规则：真实系统只读；新路由只放行列出的参数，只用 GET；上线前用生产 Hub 的管理员读取重新观察一次接口，参数或应答形状和记录的不一样就停下来报告。

## 要做的

1. 路由 `GET /plmquery/bug/`，query 只收七个参数；读法函数按名逐个核对值，至少一个条件。
2. 回答原样给出每行的标量字段，带过滤条件、行数和说明（不分页是观察到的；Hub 没核对服务端行数上限；空列表不说明没有）。
3. source-read 的 `defect_list` 槽接收 `plm:bug-list`。
4. 发布 plm 1.3.6 和 source-read 0.1.3，把生产的 PLM 资源切到 plm 1.3.6，用管理员读取观察一次，再重放。
