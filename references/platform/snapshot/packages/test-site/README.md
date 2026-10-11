# @infosec/test-site

按 SMP-V03-01 实现的本地测试站与 V03 操作纵切（P2-6）。测试站是真实 HTTP 服务（仅监听 127.0.0.1，账号为虚构测试夹具）：登录失败计数与 5 次/15 分钟锁定、MFA 60 秒窗口（码只经站点侧模拟器带外可达）、会话建立/登出/失效。驱动层把页面结果分类为 logged-in / credential-error / locked / mfa-timeout / mfa-failed / session-expired 等结构化结论；口令与 MFA 码只经平台的敏感待输入通道进入驱动，平台记录与驱动结果中不落任何凭据原文（测试以记录扫描断言）。

页面状态以确定性 `data-state` 标记判读，属 HTTP 流程级验证；规格第 3 节的视觉状态判读（截图/感知层）不在本步范围（视觉模型属 OPEN-07）。

本地验证：`npm install && npm run typecheck && npm test`。
