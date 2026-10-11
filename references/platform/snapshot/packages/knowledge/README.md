# @infosec/knowledge

对象 B 的最小实现（P2-3）：来源修订（内容 SHA-256、active/withdrawn 状态）与不可变知识快照（成员在创建时冻结），全部按 (tenantId, scopeId) 分区（ADR 0012）。快照冻结的是成员集合；修订的撤回状态按实时读取——快照创建后撤回的来源在回答时同样不得作为依据（V01-02 的被测行为）。

本地验证：`npm install && npm run typecheck && npm test`。
