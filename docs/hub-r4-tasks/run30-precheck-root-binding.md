# 第 30 轮命令域预检冻结引用修复

## 范围与来源

整合者于 2026-11-16 委派独立 worktree 修复最终整合评审发现的冻结引用混用，以 `fix/run30-package@58df4825b6` 为基线。允许修改本页及 `packs/workflow/case-compile/functions/command-obligations.ts`、`command-domain-precheck.ts`、`command-domain-precheck.test.ts`。不修改 Hub、运行环境、包清单、版本和生成物；整合者合并后重新生成清单。

## 修复与边界

旧路径的完整语法来自已过滤的冻结目录，probe 引用却从原始目录查找，另一根同名条目能够借用合法命令身份。同根另一 revision 的空签名条目也能借用别处签名。新增红测分别观察到一次不应发生的注入 reader 调用。

现在共享 `commandDefinitions` 产物保留精确引用，只接受同冻结根、按声明 words 生成的精确路径及可选 64 位小写十六进制 revision。预检仅在该产物中按完整引用选择声明，并要求所选声明独立解析出与完整语法相同的完整参数身份。无效或缺失绑定只披露缺口，不调用 reader。

这不增加设备运输、清理、净态判定、挂起或派发门禁；缺原生成器仍以显式声明及缺口披露。所有回归使用合成输入和注入 reader，不访问真实设备或业务系统。

## 验证

新增三项回归在修改前为 5 过、3 失败，其中跨根与跨 revision 各报告 `reader_calls = 1`。修改后预检、合约与清理规则共 42 项通过、0 失败、0 跳过；加入 authority-scope、inverse-alternatives、plan-commands 共享解析回归后共 79 项通过、0 失败、0 跳过。`npx tsc --noEmit` 返回 0，`git diff --check` 无错误。未重复完整包验收或设备验收。
