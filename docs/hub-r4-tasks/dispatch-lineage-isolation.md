# B3：同字节历史任务与新任务隔离

来源：#145“同一个用例文件，历史用例上机记录影响新的任务”；所有者全量计划授权，基线aded2ffd，fix/dispatch-lineage-isolation。

## 允许路径

- `hub/dispatch/{service.ts,rounds.ts,journal.ts,README.md,lineage-isolation.test.ts}`
- `hub/dispatch/{service,cli,recovery,review-first,rounds}.test.ts`
- `hub/dispatch/testing/context.ts`
- 本任务页、`CHANGELOG.md`、`docs/compatibility.md`、`docs/compatibility.en.md`

## 规则与边界

B06效果身份基于血缘/条目/槽位/次序，D04未知/未结束冻结仍按物理目标阻止派发，V07轮次和窗口应属于本次冻结任务。现service按S全局收集attempts/轮次/时间窗且bytesKey全局，可能把独立历史任务当作当前重试。

先做确定合成重现：同一RecordsKit、相同S/用例/执行器，两个合法独立plan+verify血缘，第一已完成且释放后，第二不读取旧job作为自身结果并能按自身窗口开始；相同运行/同血缘重复仍拒绝，旧未知在同物理目标继续阻止。结果身份仍核原请求/作业/摘要，不改外部认证前提。

若重现成立，仅以完整原binding区分同效果范围，不按runID随意清空retry历史；旧版无binding/不完整记录保持保守阻止且说明恢复/对账。旧记录不可改写/删掉，不把已处置未知变未执行，不放宽持有物理资源或原意图重发规则。更改unique-key必须保证同scope并发原子唯一，兼容读取旧key记录；跨scope新key需明确兼容记录。测试用合成脚本端口，不证明真实设备成功。

## 验收

新旧血缘/相同血缘修订/未知冻结/风险处置/请求协议安全重试/轮次窗口/legacy-key/并发意图；运行dispatch全包测试、类型、相关动态acceptance。先确认失败原因，未完成前不声称#145已修复。

## 已观察与实现

- 同一RecordsKit相同字节、第一作业完整结束，独立plan/verify血缘取得自己的资源租约后，当前基线确定在全局S历史检查抛AlreadyDispatchedError（ended=true）。初始时间推进使租约过期/释放失败，改为同一合成时钟排除竞争原因后，才取得这项确定失败。
- 内部唯一键加入核验后的lineage根（保留轮次/attempt）；按字节索引读取后逐原job reservation核对run/plan/ancestor/root一致性，只把同血缘意图交给原重试/轮次/窗口算法。不是按新run清历史，不改物理占用reserve规则。无/不一致legacy绑定保持拒绝，原无轮次/attempt键及日志原字节保留。
- 部分已有测试直接定位内部key，改为带原fixture lineage；远端submit控制检查index里对应精确request_id的已提交意图，而非只证明任一相同S键存在。原回滚、并发、杀进程恢复、unknown、no-resend、请求协议和窗口断言保留。
- 新独立9控制通过：历史已完成同S新任务、同血缘新核验拒绝、两种旧key兼容、无binding旧意图拒绝、不一致血缘拒绝、独立轮次/窗口、风险确认不擦旧unknown、旧未知明确在物理占用处阻止。9项0失败/跳过。
- dispatch全包388通过、0失败/跳过（首轮含最初2个新控制）；后增legacy/窗口控制与recovery/rounds/request-protocol专项32通过、0失败/跳过，再加最终不一致绑定/物理占用专项9通过。没有将未运行计为通过。
- `node --test tests/acceptance/32-r5-dispatch-rules.test.ts tests/acceptance/25-test-bed.test.ts`：9通过、0失败/跳过，临时Hub/PG+合成系统，包含未知收据对账不重交、服务重启报告、test-bed租约/边界。
- 类型退出0，fixture repetition由实际frozen requirement声明，不额外写测试port未声明字段。docs检查333通过、0失败/跳过。
- 不涉及模型/生成schema/包依赖，内部持久key兼容事实已同步中英compatibility历史。回滚旧二进制仍保守地全局阻止，不能保持本修复跨任务隔离；旧记录不迁移/重写。不同版本进程并行写同数据库未作为支持场景验证。
- 合成临时MCP/脚本VerificationPort可证明Hub安全控制和归属，不代表真实包/执行网关/设备成功。未做部署、外部操作或#194安全边界修改，未手动关闭issue。
