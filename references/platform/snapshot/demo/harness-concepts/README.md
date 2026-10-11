# 五种 Harness 界面方案

用户否定上一版工作台后，按 A 是 harness、B/C/D/E 分别持有业务状态的要求重新制作。五个方案的信息组织和交互方式不同，尚未选定。说明与取舍见[方案对比](../../docs/design/harness-interface-alternatives.md)。

| 方案 | 主要组织方式 | 截图 |
|---|---|---|
| 1 会话中心 | 会话居中，四个对象独立入口与关联详情 | [查看](screenshots/01.png) |
| 2 双工作台 | Agent 使用区与平台管理区分开 | [Agent](screenshots/02.png) / [管理](screenshots/02-management.png) |
| 3 工程桌面 | Agent 与代码、终端、浏览器并排 | [查看](screenshots/03.png) |
| 4 多会话控制台 | 多会话并行，选中后继续交互 | [查看](screenshots/04.png) |
| 5 资源画布 | 现场与资源为主，Agent 会话停靠 | [查看](screenshots/05.png) |

界面支持切换方案、自由输入与草稿保留、工具输入输出展开、四个对象的记录查看、能力加载、暂停请求及维护权限反馈。全部是合成样例，没有模型调用、实际 harness、设备操作或后端鉴权；新输入只显示为等待 Agent，不用规则假装理解并创建固定工作流。

## 运行

使用独立 TypeScript 5.9.3 编译器，设置 `INFOSEC_TYPESCRIPT_PATH`。不在生产包中安装依赖。

```sh
node demo/harness-concepts/build.ts
node demo/harness-concepts/serve.ts
```

本地地址为 `http://127.0.0.1:4180`。构建同时生成可离线打开的 `dist/preview.html`。预览仅绑定回环地址，结束评审后可停止对应进程。

浏览器检查使用既有独立研究环境：

```sh
INFOSEC_LAB_ROOT=/path/to/lab PLAYWRIGHT_BROWSERS_PATH=/path/to/browser-cache node demo/harness-concepts/verify.ts
```

[检查记录](verification.json)绑定本轮源码。检查范围为原型交互及对象之间的状态示意，不是生产实现验收。
