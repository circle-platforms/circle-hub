# R5 合成验收：T7 与 T8-1

仅允许修改本任务页、docs/hub-r5-test-map.md，以及新增的 tests/acceptance/T7*、T8* 文件。重读 hub-r5-tests、两份覆盖表后，已有覆盖只引用；旧测试和实现不改。未知普查使用 run list --unknown 的 listRunInventory，遍历世界中的全部运行与最新受理结果，逐条核缺事实、结构化出口和附加 gaps。未实现的审批等机制列为问题，不用替代行为冒充通过。

输入仅合成；全部检查并发不超过 2；合入前 typecheck、docs、contracts、hub、packs、acceptance（含 oracle）全量，记录计数。提交签署且带指定合作者；合入经带说明的 merge-locked。

中断前首次全量：docs 245、contracts 336、Hub 3183 通过（1 项既有环境跳过）、packs 3042；acceptance 158 通过、1 失败。失败只来自本次新增反例：误把不完备目录中的树外命令预期为已反驳。lumen-api/functions/endpoints.ts:13 显式声明 grammar.complete=false；现行规则必须保留 pending / integrity_unproven 与 missing + exit，不能用不存在断言代替。已修正新增断言：完备目录须有 violation 与 not_member 反驳；不完备目录须有结构化未知，两者均不得满足。没有改旧测试或实现。聚焦两项通过；接着同步最新主线并重跑全量。

最终验证：同步 e85a7a3a 的 T1–T3、块计划、技能锁和重启验收后，按并发 2 完整重跑：docs 245 通过、contracts 336 通过、Hub 3183 通过 / 0 失败 / 1 既有环境跳过（本机已有 sandbox-exec，故不跑“缺 sandbox-exec 时默认拒绝”的反向分支）、packs 3042 通过、acceptance 含 oracle 183 通过 / 0 失败 / 0 取消 / 0 跳过。本次新增 4 项均通过；旧测试与实现没有修改。typecheck 与 gen-contracts --check 通过。过程中同步的 a7a71bf9 仅追加进度文档，没有变动运行代码、包或测试；最终另跑文档与静态关口。

本分支只完成可执行合成覆盖并记录未实现部分：覆盖表问题 8（同账号异族可放行）、9（缺独立变更集审批）、10（普通非作者账号复核前驱被拒）、11（核心直接依赖产品 adoc 实现）没有在验收分支修实现，不能把全量绿色解释为这些条款已满足。T7-2、T7-3、T7-5 的原有完整覆盖只引用不重写。T7-6 对本世界全部已存运行分页普查，不手选未知列表；人工出口还必须有真实存储的请求与 next_action。

原始、诊断、纠正后的聚焦及最新全量日志归档于本机验收工作目录的 wf/t7-t8-acceptance；日志与诊断脚本不入 Git。

同步进度文档后的最终静态补跑：typecheck 通过；gen-contracts --check 通过；docs 246 通过、0 失败、0 跳过（先前同步前的 245 计数保留为阶段记录）。本次合入回报使用最终 246。
