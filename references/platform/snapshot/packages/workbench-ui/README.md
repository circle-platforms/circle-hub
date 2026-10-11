# 前端工作台

这是平台的 React / TypeScript 前端。当前先在浏览器里设计和检查交互，后续由桌面宿主承载同一套界面。它已经有独立工程、页面路由、公共组件、状态接口、宿主接口和浏览器检查。

首次打开是 Agent 会话。左边管理会话，中间持续对话，右边查看上下文、文件、终端和浏览器。切到“平台管理”，分别进入知识与记录、长期工作、执行与资源、能力与方法。用户已认可这套前端方向，当前继续完善交互。新增“插件”页可选择 Circle 或 InfoSec 组合，并单独启停四个对象的界面组件。

## 运行

需要 Node.js 24 和 npm。在仓库根目录执行：

```sh
npm --prefix packages/workbench-ui ci
npm --prefix packages/workbench-ui run dev
```

开发地址是 `http://127.0.0.1:4190`。查看打包后的页面：

```sh
npm --prefix packages/workbench-ui run build
npm --prefix packages/workbench-ui run preview -- --port 4192
```

构建预览地址是 `http://127.0.0.1:4192`；本轮已在 Otty 中实际打开。两个服务都只监听本机。没有注册托管项目或部署公共站点。

## 现在可以操作什么

- 新建、重命名和切换会话，保留草稿与消息；输入任何自然语言，不要求选择任务类别。新消息等待实际 Agent 接入。
- 展开样例工具的输入与输出，从调用跳到对应对象的记录。
- 添加本地文本文件，引用资料的指定修订；查看另一修订不会偷偷替换已有引用。
- 在 B 中查找和导入资料，在 C 中查看长期工作与保存暂停/取消请求，在 D 中查看资源与请求控制，在 E 中按会话加载能力或提交候选评审。
- 查看操作记录、切换预览角色、使用全局搜索、调整会话侧栏宽度、切换浅色/深色主题；窄屏用弹层打开导航和上下文。

初始内容全部是合成样例。用户输入保存在当前浏览器的 `infosec.workbench.preview.v1` 项中，设置页可以恢复样例。添加文本最多保存前 256 KB，截断时明确说明。没有上传服务端；这份本地预览不提供敏感资料存储保障。

Agent、模型、SSH、设备浏览器、后端鉴权和桌面进程尚未接入。终端输入会明确显示“未执行”。暂停会话只改变 A 的会话状态；C 的请求意图与 D 的实际运行状态分别显示。

## 代码放在哪里

| 位置 | 作用 |
|---|---|
| `src/workbench.tsx` | 可注入数据、宿主和插件列表的应用入口 |
| `src/plugins` | 插件契约、注册器、组合选择、错误边界与内置清单 |
| `src/app` | 应用布局、路由、运行上下文与管理导航 |
| `src/components` | 按钮、弹层、提示、搜索和公共侧栏 |
| `src/features` | 会话、上下文侧栏和 B/C/D/E 管理页面 |
| `src/platform/types.ts` | 前端需要的数据类型、`WorkbenchGateway` 与 `PlatformBridge` |
| `src/platform/browser.ts` | 浏览器文件选择、下载和剪贴板 |
| `src/preview` | 合成数据、本地状态及预览角色，供页面开发使用 |
| `src/styles` | 统一颜色、间距、字体、组件样式与响应式布局 |
| `test/browser.ts` | 使用隔离浏览器检查用户交互和跨对象边界 |

页面只使用注入的接口。接平台服务时需要实现真实会话流、查询、命令受理、请求标识及错误/未知状态；不能把本地同步方法直接当成后端完成回执。预览角色和重置方法也只属于开发适配器，正式版由服务端身份和权限结果驱动。

桌面宿主需要另行实现受限的 IPC、进程管理、文件访问和同一执行会话的浏览器展示。本包没有 Electron Main/Preload/Host，也没有复制 ZCode 源码。ZCode 的研究结论见[来源记录](../../docs/research/zcode-desktop-framework.md)。

组件使用 React Router、Radix、Lucide 和 React Resizable Panels。依赖版本固定在 lockfile 中，页面布局与业务表达由本项目维护。

## 检查

```sh
npm --prefix packages/workbench-ui run format:check
npm --prefix packages/workbench-ui run test:plugins
npm --prefix packages/workbench-ui run build
cd packages/workbench-ui
npx playwright install chromium
npm run test:browser
```

浏览器检查默认自己启动 `dist` 预览，结束后关闭；使用端口 4191，不影响开发页。已有浏览器缓存可设置 `PLAYWRIGHT_BROWSERS_PATH`。输出的截图和回执放在被 Git 忽略的 `artifacts/browser`，回执记录测试源文件、构建文件摘要和实际浏览器版本。

[本轮验证记录](../../docs/validation/workbench-ui-20261010.md)说明实际检查范围。通过这些检查不表示真实模型、平台服务、桌面功能或设备验收完成。

## 插件化与 Circle

当前支持随应用打包的第一方 UI 插件，可提供页面、会话面板、上下文组件和输入区操作。停用只收起界面，保留数据；它不取消执行，也不授予业务权限。Circle 组合仍是前端预览，没有接入真实 Circle。

具体分工、Circle 1.0.4 的现有接入能力与缺项见[插件化工作台设计](../../docs/design/pluggable-workbench.md)，最新结果见[插件检查记录](../../docs/validation/workbench-plugins-20261011.md)。现有接口用于前端开发，还不是可对外发布的通用插件 SDK。
