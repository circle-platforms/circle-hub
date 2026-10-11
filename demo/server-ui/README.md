# Circle 企业能力交互 Demo

这是前端设计原型。用户从同一个 Circle 会话入口提出目标、附材料；需要补条件或决定具体动作时才回应。评审意见、Excel、代码差异和证据在会话旁按需展开。团队管理是授权入口，不要求用户切换两个产品，也不要求先选任务分类或 Agent。

输入只保存在当前浏览器。没有正式后台、公司 SSO、真实资料同步、模型调用、设备连接、真实代码修改或产品发布。演示中的意图路由和专业判断是固定样例，不是生产语义判定；状态机、角色切换与 localStorage 不能作为正式 B/C/D/E 的实现或安全边界。

## 本地运行

使用 Node.js 24：

```sh
npm ci
npm run dev
```

免登录本地地址是 http://127.0.0.1:4317/。默认打开会话；团队管理位于左下角。云端私有 Sites 链接需要 OpenAI 登录，这只是演示托管限制，Circle/server 的设计使用公司身份来源。

## 直接体验

1. 点击“评审这份测试用例”，发送。打开结果，逐条采用或保留意见，生成新修订并下载评审报告。
2. 点击“把这份脑图整理成 Excel”，发送。打开预览，生成工作簿并下载。原节点、未映射元素和程序检查随结果保留。
3. 自由描述目标并附材料。演示会加载对应固定流程；未知意图保留为普通交流，不默认变成 SSH 任务。
4. 需要限定动作批准时，在同一会话决定；后台演示继续后续检查。人员的审批权不因此变成设备操作权。
5. 团队管理查看资料、方法、权限、节点、观测、审计和研发记录。详细工作覆盖清单保留在 GitHub 设计检查文档，不做成日常菜单。

结构转换支持主题树 JSON / 单 sheet XMind content.json，生成真实的两表七列 .xlsx 并读取检查。完整 .xmind 包、多 sheet、附件和完整业务编译尚未接入。业务编译只演示有前置、步骤与预期的方案及其缺口，不替换已冻结结构合同。

## 检查与范围

```sh
npm test
npm run build
npm run test:browser
```

浏览器检查使用隔离 Playwright Chromium，可用 DEMO_BROWSER_EXECUTABLE 和 DEMO_BASE_URL 指定测试浏览器及地址。测试不读取个人浏览器资料。当前工作簿的独立 OOXML 检查使用 unzip，适用于本次 macOS 与 CI Linux 验证环境。

这些检查只验证前端流程、修订绑定、权限演示和结构产物，不证明语义质量、真实授权、长期持久运行或设备效果。

## 来源与许可

自有源码为 MIT。React、React DOM、Scheduler、Lucide、ExcelJS 及所声明运行依赖的许可保留在 public/third-party-licenses.txt，随静态制品提供。scripts/collect-licenses.ts 重新收集许可原件。

platform 覆盖与交互核对见：https://github.com/qingshanfeihu/circle-server/blob/demo/enterprise-platform-ui/docs/platform-workflows-and-interaction.md
