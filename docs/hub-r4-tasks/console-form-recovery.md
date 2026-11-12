# B4：知识与记忆编辑恢复

来源：所有者 2026-11-09 批准的全量计划。基线 `aded2ffd`，分支 `fix/console-form-recovery`。处理 #203/#204，关联 #199。

## 允许路径

- `hub/server/console/index.ts`、`pages.ts`、`spaces.ts`、`memory.ts`、`interaction.ts`、`presentation.ts`
- `hub/server/console/form-recovery.ts`、`form-recovery.test.ts`
- `hub/server/console-memory.test.ts`、`console-knowledge.test.ts`
- `hub/server/console/README.md`
- `docs/hub-r4-tasks/console-form-recovery.md`、`CHANGELOG.md`

## 方案及边界

- 已明确拒绝的知识/记忆写入在错误页面保留可安全回显的编辑字段与旧版本条件，给字段/表单级说明，可修正再提交。记忆拒绝会存储旧意图回执，修正后必须生成新幂等键，不能沿用旧键触发 IDEMPOTENCY_MISMATCH；结果未知时则保留原键。不覆盖新版本，也不把拒绝显示为保存。
- 只支持具体编辑动作的白名单字段；密码、文件、未识别字段不回显；凭据扫描拒绝不将疑似秘密写入响应或页面。
- 断线或发送后无法读结果清除忙碌语义、保留浏览器输入并提示结果未知。保持防重提门，用户核对已有记录后明确继续编辑；不自动重发。
- 服务端明确拒绝、登录失效、来源无权/不存在、服务器错误不混为同一恢复状态。保持CSRF/来源/个人epoch边界。

## 验收

回归先复现：服务端JSON/版本/大小错误后保留安全字段、原版本键、字段提示与转义；凭据/不透明权限错误不回显受保护内容。浏览器模拟发送失败、回复未知、可修复400与二次提交，验证按钮/忙碌状态、字段、CSRF与幂等键；按实际结果填写，未测不报通过。

## 实际验证

- 先加真实 HTTP 回归，旧页面确定因缺少 markdown 编辑字段失败；修改后安全草稿保留、拒绝不落库、修正后新键保存通过。
- 控制台目录全部测试 + `console-memory.test.ts`、`console-knowledge.test.ts`、`console-csp-nonce.test.ts`：最终 66 通过、0 失败、0 跳过。
- 追加真实 HTTP 知识 JSON 错误恢复、修正保存及凭据扫描拒绝回显测试；定向两个文件 10 通过、0 失败、0 跳过（包含在上述范围中，不相加）。
- 隔离 Chrome 首轮在旧脚本因缺恢复控件失败。最终六种结果（发送前断开、发送后断开、保存后跟进GET失败、500、不可解析结果、明确400）× 深浅主题 × 1440/1024/390：36 图、30次合成POST；二次点击、历史页恢复与“继续编辑”本身均不多发请求。检查原键/新键、busy/disabled、输入和字段说明位置。截图来自临时合成渲染服务器，真实 HTTP 路由验证由上述测试承担。
- 人工检查窄屏截图时发现字段错误处于 textarea 的横向flex容器内，修复共享 field helper 将错误放在输入框下方；再次浏览器几何断言与截图检查通过。
- `npm run typecheck`：退出 0。
- `npm run test:docs`：333 通过、0 失败、0 跳过。
- 验收 `12-console-security.test.ts`：5 通过、0 失败、0 跳过；`48-knowledge-console-memory.test.ts`：8 通过、0 失败、0 跳过。初次命令误写51文件名，仅运行了12并报告5项，已改用正确48文件单独运行，不能把未执行文件算通过。
- 未跑完整unit/acceptance、Linux隔离、实际部署或真实业务模型，不作线上修复结论。
