# R5 合成验收：T7 与 T8-1

仅允许修改本任务页、docs/hub-r5-test-map.md，以及新增的 tests/acceptance/T7*、T8* 文件。重读 hub-r5-tests、两份覆盖表后，已有覆盖只引用；旧测试和实现不改。未知普查使用 run list --unknown 的 listRunInventory，遍历世界中的全部运行与最新受理结果，逐条核缺事实、结构化出口和附加 gaps。未实现的审批等机制列为问题，不用替代行为冒充通过。

输入仅合成；全部检查并发不超过 2；合入前 typecheck、docs、contracts、hub、packs、acceptance（含 oracle）全量，记录计数。提交签署且带指定合作者；合入经带说明的 merge-locked。

中断前首次全量：docs 245、contracts 336、Hub 3183 通过（1 项既有环境跳过）、packs 3042；acceptance 158 通过、1 失败。失败只来自本次新增反例：误把不完备目录中的树外命令预期为已反驳。lumen-api/functions/endpoints.ts:13 显式声明 grammar.complete=false；现行规则必须保留 pending / integrity_unproven 与 missing + exit，不能用不存在断言代替。已修正新增断言：完备目录须有 violation 与 not_member 反驳；不完备目录须有结构化未知，两者均不得满足。没有改旧测试或实现。聚焦两项通过；接着同步最新主线并重跑全量。
