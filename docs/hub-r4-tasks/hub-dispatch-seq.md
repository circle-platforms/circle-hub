# 派发序号与无跨机器墙钟依赖

所有者 2026-10-26 指定：Hub 分支 hub-dispatch-seq，从 hub-redesign 的 defdd1f3 开始；网关另仓 gw-no-wallclock，只本地提交。允许修改 contracts/src/resources.ts、由 tools/gen-contracts.ts 重生成的 effect schema、hub/dispatch 的实现/测试/文档，以及本页。不触碰发布包、凭据、配置、7420、真实系统、推送或部署。

## 规则与实现

1. 网关不按 Hub 的绝对截止判受理。Hub 仍在实际提交前、任何已授权同键重发前按自身时钟检查本地窗口，过期追加 not_dispatched、submit_invoked=false 与出口，不调用提交。
2. 每个执行器的 dispatch_sequence 在 PostgreSQL 事务内锁定、追加序号记录，取持久历史最大整数加一；允许空号，不允许重用或回退。独立于原血缘 sequence；初次派发、多轮派发都走同一分配器。
3. 每份执行器提交参数必须各绑定一次 request_id、dispatch_sequence、sequence_scope。sequence_scope 为稳定执行器身份，配合网关认证主体隔离回收线。完整准备参数纳入 action_digest；序号和流身份进入意图、效果记录。旧定义缺绑定会拒绝，不静默遗漏。升级登记须补两个序号参数，重新核验执行器和协议前提。
4. 日志身份只核对不透明 epoch 与认证主体，journal_since 等时间只保留记录。查空永远不能借两机器墙钟顺序证明未执行；仍有在途请求或已回收历史时保持未知、冻结和原件，要求明确原请求未启动/拒收事实或管理员具名处置。禁止新请求重交绕过。
5. 管理员正面远端编号对账也不再拿结果 submitted_at 与 Hub 的窗口比较；核对请求身份（有声明时）、远端编号、摘要和状态。旧 clock_skew_ms 不参与判定。
6. 网关 TTL 为绑定本机启动身份的单调时钟相对期限，Hub 消费相对 TTL 并按自己的接收点检查，不用网关绝对 expires_at。两仓库文档已更新。

## 合成验证

Hub 派发相关首轮 327 项，321 过、6 失败（旧墙钟期望）；收尾发现并更新原 R11 容差期望。最终 `node --test --test-concurrency=2 "hub/dispatch/*.test.ts"`：328/328，无跳过；npm run typecheck 通过；node tools/gen-contracts.ts --check：131 文件一致。新增覆盖并发分配、服务实例重建后的持久递增、发行方墙钟回拨不回退、序号进入请求摘要、执行器流隔离、签发方过期不发、正负 7 小时偏差和强制序号绑定。现有崩溃恢复、两进程至多一次、冻结和只读恢复覆盖保留。

网关全套使用串行 pytest；Hub 与网关同时验证时 Hub 并发为 1，单独全套 Hub 并发为 2。所有对象与设备应答均为合成，未使用真实设备/模型。
