# 平台 Web 工作台 demo（已否定的旧方案）

用户已明确否定本方案：它将 A 做成产品/任务表单，未正确表达 harness 与 B/C/D/E。它不再是当前界面基线，保留用于记录纠正历史。新的候选见[五种 Harness 方案](../harness-concepts/README.md)。

本地交互原型，源代码为 TypeScript。用户要求先看成熟产品页面，随后指出第一版过度聚焦排障、文字混乱；当前版以产品、完整任务和原生 Web 交互组织界面。设计参考与取舍见[视觉和交互说明](../../docs/design/workspace-design-language.md)。

首页可以选择产品、发起目标或继续任务，覆盖查资料、方案评审、开发修复、测试、设备操作和发布。任务页支持对话、步骤与证据联动、变更、执行和交付查看。其他页面提供资料、执行资源、方法、人员权限和审计的交互示意。

角色切换、回答、执行、状态和数据都是样例；没有后端登录、强制鉴权、持久业务状态、真实模型或设备连接。输入只保存在本页内存中，刷新后重置。演示内容不能作为产品支持或安全通过证明。

## 本地查看

在独立工具环境中准备 TypeScript 5.9.3，设置 `INFOSEC_TYPESCRIPT_PATH` 指向其编译器。不需要在业务 packages 中安装依赖。

```sh
node demo/workbench/build.ts
node demo/workbench/serve.ts
```

打开 `http://127.0.0.1:4173`。预览服务仅绑定本机回环地址，不是部署服务；结束查看后停止此进程。支持 `INFOSEC_DEMO_PORT` 指定端口。

浏览器检查使用研究沙盒的 Playwright 与独立 Chromium：

```sh
INFOSEC_LAB_ROOT=/path/to/isolated-lab PLAYWRIGHT_BROWSERS_PATH=/path/to/browser-cache node demo/workbench/verify.ts
```

检查范围及当前结果见 [verification.json](verification.json)。[首页截图](screenshots/workbench.png)、[任务截图](screenshots/task-space.png)、[权限截图](screenshots/permissions.png)与[窄屏截图](screenshots/mobile.png)均为合成演示。没有真实模型、设备或后端鉴权验收。
