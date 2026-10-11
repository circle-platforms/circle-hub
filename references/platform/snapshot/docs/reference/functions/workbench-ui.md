# 前端工作台

前端通过 `Workbench` 注入宿主、数据与插件列表。注册器检查插件标识、页面、依赖与接口版本，按启用状态组合路由和会话组件。原来的集中管理页已拆成独立模块。停用插件保留记录，页面出错时显示局部错误，并保留其余界面的操作能力。当前插件只负责第一方界面组合，Circle 的真实连接、动态安装与第三方代码隔离仍需单独完成，见[插件设计与边界](../../design/pluggable-workbench.md)。

`workbench-ui` 是实际可构建的 React / TypeScript 前端。左侧切换会话，中间与 Agent 工作，侧栏查看上下文、文件、终端和浏览器。平台管理中分别查看知识、长期工作、执行资源和能力方法。自由输入不自动套成固定流程，A 的会话、C 的工作和 D 的执行各有状态。

页面通过 `WorkbenchGateway` 使用数据，通过 `PlatformBridge` 使用文件选择等宿主能力。当前只接本地预览适配器，保存草稿、消息、引用和请求记录；它没有运行真实 Agent，也没有后端鉴权或设备连接。B 的修订查看不会改写已有引用，E 的会话加载不会发布候选方法。

浏览器检查覆盖会话保存、跨对象边界和不同角色的界面操作，详情见[前端验证记录](../../validation/workbench-ui-20261010.md)。后续要独立完成服务接入、真实流事件、权限强制路径和桌面宿主。页面可运行不表示这些系统能力已经完成。

这部分的函数用途和需要完善的地方，可以结合[项目说明](../../project-explanation.md)与[关键函数说明](../../design/critical-interface-contracts.md)阅读。

<details>
<summary>需要核对具体函数、原始签名和代码位置时展开</summary>

以下是提交 `3b98096057438cc4a89134562ea7f7d31059e696` 的静态代码目录。它包含内部帮助函数，不表示所有条目已经完成设计或通过测试。

<a id="fn-workbench-ui-app-app-usenarrow-function"></a>
## useNarrow

ID `fn-workbench-ui-app-app-usenarrow-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/App.tsx#L51)；SHA-256 `54e97f370b0053c7c552bc688cdf65368a239cf8231d9faf87aa52882521a031`。

```ts
function useNarrow()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-app-agentpage-function"></a>
## AgentPage

ID `fn-workbench-ui-app-app-agentpage-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/App.tsx#L61)；SHA-256 `54e97f370b0053c7c552bc688cdf65368a239cf8231d9faf87aa52882521a031`。

```ts
function AgentPage({
  onActive,
  sideView,
  setSideView,
  panelOpen,
  setPanelOpen,
}: {
  onActive: (id: string) => void;
  sideView: SideView;
  setSideView: (view: SideView) => void;
  panelOpen: boolean;
  setPanelOpen: (open: boolean) => void;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-app-managementroute-function"></a>
## ManagementRoute

ID `fn-workbench-ui-app-app-managementroute-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/App.tsx#L136)；SHA-256 `54e97f370b0053c7c552bc688cdf65368a239cf8231d9faf87aa52882521a031`。

```ts
function ManagementRoute({ conversationId }: { conversationId: string })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-app-app-function"></a>
## App

ID `fn-workbench-ui-app-app-app-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/App.tsx#L167)；SHA-256 `54e97f370b0053c7c552bc688cdf65368a239cf8231d9faf87aa52882521a031`。

```ts
export function App()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-app-app-handler-callable-value"></a>
## App.handler

ID `fn-workbench-ui-app-app-app-handler-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/App.tsx#L206)；SHA-256 `54e97f370b0053c7c552bc688cdf65368a239cf8231d9faf87aa52882521a031`。

```ts
(event: KeyboardEvent) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-context-workbenchprovider-function"></a>
## WorkbenchProvider

ID `fn-workbench-ui-app-context-workbenchprovider-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/context.tsx#L23)；SHA-256 `e00b9c04f1a58fad243f25c1281c22326e313b267f0edef2fa77659f38b15dca`。

```ts
export function WorkbenchProvider({
  gateway,
  platform,
  children,
}: {
  gateway: WorkbenchGateway;
  platform: PlatformBridge;
  children: ReactNode;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-context-workbenchprovider-notify-callable-value"></a>
## WorkbenchProvider.notify

ID `fn-workbench-ui-app-context-workbenchprovider-notify-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/context.tsx#L35)；SHA-256 `e00b9c04f1a58fad243f25c1281c22326e313b267f0edef2fa77659f38b15dca`。

```ts
(message: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-context-workbenchprovider-perform-callable-value"></a>
## WorkbenchProvider.perform

ID `fn-workbench-ui-app-context-workbenchprovider-perform-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/context.tsx#L48)；SHA-256 `e00b9c04f1a58fad243f25c1281c22326e313b267f0edef2fa77659f38b15dca`。

```ts
(work: () => void, message?: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-context-useworkbench-function"></a>
## useWorkbench

ID `fn-workbench-ui-app-context-useworkbench-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/context.tsx#L60)；SHA-256 `e00b9c04f1a58fad243f25c1281c22326e313b267f0edef2fa77659f38b15dca`。

```ts
export function useWorkbench()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-app-navigation-usemanagementnavigation-function"></a>
## useManagementNavigation

ID `fn-workbench-ui-app-navigation-usemanagementnavigation-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/app/navigation.ts#L36)；SHA-256 `27dd7b8de6697437f5453ebf7114f51058fc0857f5d2f6e7e00bd23aa9ee3343`。

```ts
export function useManagementNavigation(): NavigationItem[]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-commandmenu-commandmenu-function"></a>
## CommandMenu

ID `fn-workbench-ui-components-commandmenu-commandmenu-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/CommandMenu.tsx#L8)；SHA-256 `3ac34f6285da82da93723e4b5128034ff10df12d28ef06b61c3aab839f1b0f65`。

```ts
export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-sidebar-sidebar-function"></a>
## Sidebar

ID `fn-workbench-ui-components-sidebar-sidebar-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/Sidebar.tsx#L15)；SHA-256 `8341f13894274d2a4cabffeb5f382fef4ff0b79e83ad41ac99805b9955b7dbaa`。

```ts
export function Sidebar({
  onSearch,
  onNavigate,
  onClose,
  activeConversationId,
}: {
  onSearch: () => void;
  activeConversationId: string;
  onNavigate?: () => void;
  onClose?: () => void;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-button-function"></a>
## Button

ID `fn-workbench-ui-components-ui-button-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L4)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function Button({
  children,
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement>)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-iconbutton-function"></a>
## IconButton

ID `fn-workbench-ui-components-ui-iconbutton-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L15)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function IconButton({
  label,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { label: string })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-modal-function"></a>
## Modal

ID `fn-workbench-ui-components-ui-modal-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L36)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function Modal({
  open,
  onOpenChange,
  title,
  description,
  children,
  wide = false,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: ReactNode;
  wide?: boolean;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-badge-function"></a>
## Badge

ID `fn-workbench-ui-components-ui-badge-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L80)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function Badge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "amber" | "blue";
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-emptystate-function"></a>
## EmptyState

ID `fn-workbench-ui-components-ui-emptystate-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L94)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function EmptyState({
  title,
  children,
}: {
  title: string;
  children?: ReactNode;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-permissionstate-function"></a>
## PermissionState

ID `fn-workbench-ui-components-ui-permissionstate-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L109)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function PermissionState()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-components-ui-datablock-function"></a>
## DataBlock

ID `fn-workbench-ui-components-ui-datablock-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/components/ui.tsx#L118)；SHA-256 `b63bfed550869f9244ae361458cb196573794d94d79539c50a5c9ff8e4c90f01`。

```ts
export function DataBlock({ title, value }: { title: string; value: unknown })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-contextpanel-contextpanel-function"></a>
## ContextPanel

ID `fn-workbench-ui-features-contextpanel-contextpanel-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/ContextPanel.tsx#L17)；SHA-256 `eb7ef9a5a16d5ab9448d8451309908cdd03799b0d084487a9d49c9e6aaab03d3`。

```ts
export function ContextPanel({
  conversation,
  view,
  onView,
  onClose,
}: {
  conversation: Conversation;
  view: SideView;
  onView: (view: SideView) => void;
  onClose: () => void;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-conversationview-toolmessage-function"></a>
## ToolMessage

ID `fn-workbench-ui-features-conversationview-toolmessage-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/ConversationView.tsx#L21)；SHA-256 `658908745f5eb274e482978461a7b8e9d94cb2b6e920a7e0374d92bf8faf68e6`。

```ts
function ToolMessage({ message }: { message: Message })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-conversationview-conversationview-function"></a>
## ConversationView

ID `fn-workbench-ui-features-conversationview-conversationview-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/ConversationView.tsx#L61)；SHA-256 `658908745f5eb274e482978461a7b8e9d94cb2b6e920a7e0374d92bf8faf68e6`。

```ts
export function ConversationView({
  conversation,
  onContext,
}: {
  conversation: Conversation;
  onContext: () => void;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-conversationview-conversationview-send-callable-value"></a>
## ConversationView.send

ID `fn-workbench-ui-features-conversationview-conversationview-send-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/ConversationView.tsx#L92)；SHA-256 `658908745f5eb274e482978461a7b8e9d94cb2b6e920a7e0374d92bf8faf68e6`。

```ts
() =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-conversationview-conversationview-attach-callable-value"></a>
## ConversationView.attach

ID `fn-workbench-ui-features-conversationview-conversationview-attach-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/ConversationView.tsx#L93)；SHA-256 `658908745f5eb274e482978461a7b8e9d94cb2b6e920a7e0374d92bf8faf68e6`。

```ts
async () =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-capabilitiescontext-capabilitiescontext-function"></a>
## CapabilitiesContext

ID `fn-workbench-ui-features-management-capabilitiescontext-capabilitiescontext-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/CapabilitiesContext.tsx#L5)；SHA-256 `58c03faead8dab7c32c63dcfc51cb67a80d6a84f5ebb6e89c5625daf50ae2373`。

```ts
export function CapabilitiesContext({
  conversation,
}: SessionContributionProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-capabilitiespage-capabilitiespage-function"></a>
## CapabilitiesPage

ID `fn-workbench-ui-features-management-capabilitiespage-capabilitiespage-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/CapabilitiesPage.tsx#L20)；SHA-256 `7521cd382f7b9412ffafd57bb91f315a78989dd06e62e340767409fb7f5ca8cf`。

```ts
export function CapabilitiesPage({ conversationId }: PluginPageProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-capabilitiespage-capabilitydetail-function"></a>
## CapabilityDetail

ID `fn-workbench-ui-features-management-capabilitiespage-capabilitydetail-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/CapabilitiesPage.tsx#L133)；SHA-256 `7521cd382f7b9412ffafd57bb91f315a78989dd06e62e340767409fb7f5ca8cf`。

```ts
function CapabilityDetail({
  capability,
}: {
  capability: Capability | undefined;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-capabilitiespage-messagecontext-function"></a>
## MessageContext

ID `fn-workbench-ui-features-management-capabilitiespage-messagecontext-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/CapabilitiesPage.tsx#L177)；SHA-256 `7521cd382f7b9412ffafd57bb91f315a78989dd06e62e340767409fb7f5ca8cf`。

```ts
function MessageContext({ title }: { title: string })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-corepages-auditpage-function"></a>
## AuditPage

ID `fn-workbench-ui-features-management-corepages-auditpage-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/CorePages.tsx#L16)；SHA-256 `e152c0f452e9a0d9953392849638ad6d99bc7cf889305458ed614dc13c75ced8`。

```ts
export function AuditPage()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-corepages-settingspage-function"></a>
## SettingsPage

ID `fn-workbench-ui-features-management-corepages-settingspage-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/CorePages.tsx#L63)；SHA-256 `e152c0f452e9a0d9953392849638ad6d99bc7cf889305458ed614dc13c75ced8`。

```ts
export function SettingsPage()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-executionpage-executionpage-function"></a>
## ExecutionPage

ID `fn-workbench-ui-features-management-executionpage-executionpage-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/ExecutionPage.tsx#L19)；SHA-256 `1b885e9bf4b382ce982ac2bee08e5f611a240e387304cab998436249c31d2fcf`。

```ts
export function ExecutionPage()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-executionpage-resourcedetail-function"></a>
## ResourceDetail

ID `fn-workbench-ui-features-management-executionpage-resourcedetail-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/ExecutionPage.tsx#L162)；SHA-256 `1b885e9bf4b382ce982ac2bee08e5f611a240e387304cab998436249c31d2fcf`。

```ts
function ResourceDetail({
  resource,
}: {
  resource: ExecutionResource | undefined;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-executionpanels-terminalpanel-function"></a>
## TerminalPanel

ID `fn-workbench-ui-features-management-executionpanels-terminalpanel-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/ExecutionPanels.tsx#L7)；SHA-256 `001a174238c57d26d4422b47784f9d5bf753018d398c447f6f470c3dd78ede71`。

```ts
export function TerminalPanel({ conversation }: SessionContributionProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-executionpanels-browserpanel-function"></a>
## BrowserPanel

ID `fn-workbench-ui-features-management-executionpanels-browserpanel-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/ExecutionPanels.tsx#L47)；SHA-256 `001a174238c57d26d4422b47784f9d5bf753018d398c447f6f470c3dd78ede71`。

```ts
export function BrowserPanel({ conversation }: SessionContributionProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-knowledgeaction-knowledgeaction-function"></a>
## KnowledgeAction

ID `fn-workbench-ui-features-management-knowledgeaction-knowledgeaction-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/KnowledgeAction.tsx#L6)；SHA-256 `10cee44028ecf19b007c3cb213c83ec1794f463f9de4133425dab0ad78bc1430`。

```ts
export function KnowledgeAction({ conversation }: SessionContributionProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-knowledgepage-knowledgepage-function"></a>
## KnowledgePage

ID `fn-workbench-ui-features-management-knowledgepage-knowledgepage-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/KnowledgePage.tsx#L15)；SHA-256 `2d54fa2df3257562923825b4fb4c1555ed079425df47b3554c901ecf078b438c`。

```ts
export function KnowledgePage({ conversationId }: PluginPageProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-knowledgepage-knowledgepage-importfiles-callable-value"></a>
## KnowledgePage.importFiles

ID `fn-workbench-ui-features-management-knowledgepage-knowledgepage-importfiles-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/KnowledgePage.tsx#L25)；SHA-256 `2d54fa2df3257562923825b4fb4c1555ed079425df47b3554c901ecf078b438c`。

```ts
async () =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-knowledgepage-sourcedetail-function"></a>
## SourceDetail

ID `fn-workbench-ui-features-management-knowledgepage-sourcedetail-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/KnowledgePage.tsx#L113)；SHA-256 `2d54fa2df3257562923825b4fb4c1555ed079425df47b3554c901ecf078b438c`。

```ts
function SourceDetail({
  source,
  conversationId,
}: {
  source: KnowledgeSource | undefined;
  conversationId: string;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-workcontext-workcontext-function"></a>
## WorkContext

ID `fn-workbench-ui-features-management-workcontext-workcontext-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/WorkContext.tsx#L6)；SHA-256 `bd26dca4cd40850b264e4a7e5a077a35e3310e96979f56eaab50b40087d3acfe`。

```ts
export function WorkContext({ conversation }: SessionContributionProps)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-workpage-workpage-function"></a>
## WorkPage

ID `fn-workbench-ui-features-management-workpage-workpage-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/WorkPage.tsx#L14)；SHA-256 `75d5cb06edd2925971f18106dc9b896272700ccba4c9cfc1f1d871416974af00`。

```ts
export function WorkPage()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-workpage-workdetail-function"></a>
## WorkDetail

ID `fn-workbench-ui-features-management-workpage-workdetail-function`；function / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/WorkPage.tsx#L99)；SHA-256 `75d5cb06edd2925971f18106dc9b896272700ccba4c9cfc1f1d871416974af00`。

```ts
function WorkDetail({ work }: { work: WorkRun | undefined })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-statusbadge-function"></a>
## statusBadge

ID `fn-workbench-ui-features-management-shared-statusbadge-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L12)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
export function statusBadge(value: string)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-factlist-function"></a>
## FactList

ID `fn-workbench-ui-features-management-shared-factlist-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L28)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
export function FactList({ values }: { values: Record<string, string> })
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-userecord-function"></a>
## useRecord

ID `fn-workbench-ui-features-management-shared-userecord-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L40)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
export function useRecord()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-userecord-openrecord-callable-value"></a>
## useRecord.openRecord

ID `fn-workbench-ui-features-management-shared-userecord-openrecord-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L44)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
(id: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-userecord-closerecord-callable-value"></a>
## useRecord.closeRecord

ID `fn-workbench-ui-features-management-shared-userecord-closerecord-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L45)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
() =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-pageframe-function"></a>
## PageFrame

ID `fn-workbench-ui-features-management-shared-pageframe-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L48)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
export function PageFrame({
  title,
  description,
  owner,
  action,
  children,
}: {
  title: string;
  description: string;
  owner?: string;
  action?: ReactNode;
  children: ReactNode;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-features-management-shared-recordstoolbar-function"></a>
## RecordsToolbar

ID `fn-workbench-ui-features-management-shared-recordstoolbar-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/features/management/shared.tsx#L77)；SHA-256 `86a7b4972c0d3bed2e29bd704e1af18e235ac7dc671c99bdea30402b465f2181`。

```ts
export function RecordsToolbar({
  search,
  onSearch,
  filter,
  onFilter,
  options,
  count,
  extra,
}: {
  search: string;
  onSearch: (value: string) => void;
  filter: string;
  onFilter: (value: string) => void;
  options: string[];
  count: number;
  extra?: ReactNode;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-platform-browser-browserplatform-pickfiles-callable-value"></a>
## BrowserPlatform.pickFiles

ID `fn-workbench-ui-platform-browser-browserplatform-pickfiles-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/platform/browser.ts#L4)；SHA-256 `0f10a110fbc70e838637f28834b07b413d29d3d947aca6a58a7ca27c98b19b1f`。

```ts
(): Promise<ContextRef[]> =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-platform-browser-browserplatform-download-callable-value"></a>
## BrowserPlatform.download

ID `fn-workbench-ui-platform-browser-browserplatform-download-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/platform/browser.ts#L30)；SHA-256 `0f10a110fbc70e838637f28834b07b413d29d3d947aca6a58a7ca27c98b19b1f`。

```ts
(filename: string, content: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-platform-browser-browserplatform-copy-callable-value"></a>
## BrowserPlatform.copy

ID `fn-workbench-ui-platform-browser-browserplatform-copy-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/platform/browser.ts#L40)；SHA-256 `0f10a110fbc70e838637f28834b07b413d29d3d947aca6a58a7ca27c98b19b1f`。

```ts
(text: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-pluginboundary-pluginboundary-getderivedstatefromerror-method"></a>
## PluginBoundary.getDerivedStateFromError

ID `fn-workbench-ui-plugins-pluginboundary-pluginboundary-getderivedstatefromerror-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/PluginBoundary.tsx#L11)；SHA-256 `5b2a17d892da2c08bdf1f43b4ba259372a8a23aa832c4be737eb46c40fdadda1`。

```ts
static getDerivedStateFromError()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-pluginboundary-pluginboundary-componentdidcatch-method"></a>
## PluginBoundary.componentDidCatch

ID `fn-workbench-ui-plugins-pluginboundary-pluginboundary-componentdidcatch-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/PluginBoundary.tsx#L14)；SHA-256 `5b2a17d892da2c08bdf1f43b4ba259372a8a23aa832c4be737eb46c40fdadda1`。

```ts
componentDidCatch(_error: Error, _info: ErrorInfo)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-pluginboundary-pluginboundary-render-method"></a>
## PluginBoundary.render

ID `fn-workbench-ui-plugins-pluginboundary-pluginboundary-render-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/PluginBoundary.tsx#L15)；SHA-256 `5b2a17d892da2c08bdf1f43b4ba259372a8a23aa832c4be737eb46c40fdadda1`。

```ts
render()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-pluginmanager-pluginmanager-function"></a>
## PluginManager

ID `fn-workbench-ui-plugins-pluginmanager-pluginmanager-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/PluginManager.tsx#L12)；SHA-256 `524cea11b472c183bf753e3fa9a18d2b26770e959c998360a847d9f537992674`。

```ts
export function PluginManager()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-context-pluginprovider-function"></a>
## PluginProvider

ID `fn-workbench-ui-plugins-context-pluginprovider-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/context.tsx#L14)；SHA-256 `f22154f859ec16f2612ff7598cb82e685f207b89418503b0edb1d2cc3fe73a61`。

```ts
export function PluginProvider({
  registry,
  children,
}: {
  registry: PluginRegistry;
  children: ReactNode;
})
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-context-pluginprovider-save-callable-value"></a>
## PluginProvider.save

ID `fn-workbench-ui-plugins-context-pluginprovider-save-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/context.tsx#L32)；SHA-256 `f22154f859ec16f2612ff7598cb82e685f207b89418503b0edb1d2cc3fe73a61`。

```ts
(next: PluginPreferences) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-context-pluginprovider-setenabled-callable-value"></a>
## PluginProvider.setEnabled

ID `fn-workbench-ui-plugins-context-pluginprovider-setenabled-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/context.tsx#L43)；SHA-256 `f22154f859ec16f2612ff7598cb82e685f207b89418503b0edb1d2cc3fe73a61`。

```ts
(id: string, enabled: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-context-pluginprovider-setpreset-callable-value"></a>
## PluginProvider.setPreset

ID `fn-workbench-ui-plugins-context-pluginprovider-setpreset-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/context.tsx#L53)；SHA-256 `f22154f859ec16f2612ff7598cb82e685f207b89418503b0edb1d2cc3fe73a61`。

```ts
(preset: "circle" | "infosec") =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-context-useplugins-function"></a>
## usePlugins

ID `fn-workbench-ui-plugins-context-useplugins-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/context.tsx#L65)；SHA-256 `f22154f859ec16f2612ff7598cb82e685f207b89418503b0edb1d2cc3fe73a61`。

```ts
export function usePlugins()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-constructor-constructor"></a>
## PluginRegistry.constructor

ID `fn-workbench-ui-plugins-registry-pluginregistry-constructor-constructor`；constructor / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L15)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
constructor(plugins: WorkbenchPlugin[])
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-constructor-visit-callable-value"></a>
## PluginRegistry.constructor.visit

ID `fn-workbench-ui-plugins-registry-pluginregistry-constructor-visit-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L59)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
(id: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-resolve-method"></a>
## PluginRegistry.resolve

ID `fn-workbench-ui-plugins-registry-pluginregistry-resolve-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L72)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
resolve(enabledIds: readonly string[])
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-normalize-method"></a>
## PluginRegistry.normalize

ID `fn-workbench-ui-plugins-registry-pluginregistry-normalize-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L84)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
normalize(value: unknown): PluginPreferences
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-change-method"></a>
## PluginRegistry.change

ID `fn-workbench-ui-plugins-registry-pluginregistry-change-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L109)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
change(enabledIds: readonly string[], id: string, enabled: boolean)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-change-add-callable-value"></a>
## PluginRegistry.change.add

ID `fn-workbench-ui-plugins-registry-pluginregistry-change-add-callable-value`；callable-value / internal；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L114)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
(item: WorkbenchPlugin) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-pages-method"></a>
## PluginRegistry.pages

ID `fn-workbench-ui-plugins-registry-pluginregistry-pages-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L128)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
pages(
    enabledIds: readonly string[],
  ): RegisteredContribution<PageContribution>[]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-session-method"></a>
## PluginRegistry.session

ID `fn-workbench-ui-plugins-registry-pluginregistry-session-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L135)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
session(
    kind: "panels" | "contextWidgets" | "contextActions",
    enabledIds: readonly string[],
    can: (permission: Permission) => boolean,
  ): RegisteredContribution<SessionContribution>[]
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-plugins-registry-pluginregistry-recordpath-method"></a>
## PluginRegistry.recordPath

ID `fn-workbench-ui-plugins-registry-pluginregistry-recordpath-method`；method / public；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/plugins/registry.ts#L146)；SHA-256 `758b25c0bfb4b683d3ef67b88e9e45ae4637f7851cb627739b1e5d513f334374`。

```ts
recordPath(
    enabledIds: readonly string[],
    owner: Owner,
    id: string,
    revision?: string,
  )
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-fixtures-createfixtures-function"></a>
## createFixtures

ID `fn-workbench-ui-preview-fixtures-createfixtures-function`；function / exported；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/fixtures.ts#L2)；SHA-256 `e13d58b519669b5d2c86e08a8306ed9c455ef86d7430e76283b3fc81bfc1909f`。

```ts
export function createFixtures(): WorkbenchSnapshot
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-constructor-constructor"></a>
## PreviewGateway.constructor

ID `fn-workbench-ui-preview-gateway-previewgateway-constructor-constructor`；constructor / public；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L28)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
constructor()
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-getsnapshot-callable-value"></a>
## PreviewGateway.getSnapshot

ID `fn-workbench-ui-preview-gateway-previewgateway-getsnapshot-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L31)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
() =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-subscribe-callable-value"></a>
## PreviewGateway.subscribe

ID `fn-workbench-ui-preview-gateway-previewgateway-subscribe-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L32)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(listener: () => void) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-can-callable-value"></a>
## PreviewGateway.can

ID `fn-workbench-ui-preview-gateway-previewgateway-can-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L38)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(permission: Permission) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-require-method"></a>
## PreviewGateway.require

ID `fn-workbench-ui-preview-gateway-previewgateway-require-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L40)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
private require(permission: Permission)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-restore-method"></a>
## PreviewGateway.restore

ID `fn-workbench-ui-preview-gateway-previewgateway-restore-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L43)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
private restore(): WorkbenchSnapshot
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-update-method"></a>
## PreviewGateway.update

ID `fn-workbench-ui-preview-gateway-previewgateway-update-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L70)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
private update(
    action: string,
    target: string,
    mutate: (draft: WorkbenchSnapshot) => void,
  )
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-conversation-method"></a>
## PreviewGateway.conversation

ID `fn-workbench-ui-preview-gateway-previewgateway-conversation-method`；method / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L93)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
private conversation(draft: WorkbenchSnapshot, id: string)
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-createconversation-callable-value"></a>
## PreviewGateway.createConversation

ID `fn-workbench-ui-preview-gateway-previewgateway-createconversation-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L98)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
() =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-renameconversation-callable-value"></a>
## PreviewGateway.renameConversation

ID `fn-workbench-ui-preview-gateway-previewgateway-renameconversation-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L118)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, title: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-savedraft-callable-value"></a>
## PreviewGateway.saveDraft

ID `fn-workbench-ui-preview-gateway-previewgateway-savedraft-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L125)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, text: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-sendmessage-callable-value"></a>
## PreviewGateway.sendMessage

ID `fn-workbench-ui-preview-gateway-previewgateway-sendmessage-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L131)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-setconversationstate-callable-value"></a>
## PreviewGateway.setConversationState

ID `fn-workbench-ui-preview-gateway-previewgateway-setconversationstate-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L152)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, state: Conversation["state"]) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-attachcontext-callable-value"></a>
## PreviewGateway.attachContext

ID `fn-workbench-ui-preview-gateway-previewgateway-attachcontext-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L162)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, ref: ContextRef) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-removecontext-callable-value"></a>
## PreviewGateway.removeContext

ID `fn-workbench-ui-preview-gateway-previewgateway-removecontext-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L169)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, refId: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-setcapability-callable-value"></a>
## PreviewGateway.setCapability

ID `fn-workbench-ui-preview-gateway-previewgateway-setcapability-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L176)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, capabilityId: string, enabled: boolean) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-requestwork-callable-value"></a>
## PreviewGateway.requestWork

ID `fn-workbench-ui-preview-gateway-previewgateway-requestwork-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L190)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string, request: "pause" | "cancel") =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-requestresourcecontrol-callable-value"></a>
## PreviewGateway.requestResourceControl

ID `fn-workbench-ui-preview-gateway-previewgateway-requestresourcecontrol-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L209)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-submitcapabilityreview-callable-value"></a>
## PreviewGateway.submitCapabilityReview

ID `fn-workbench-ui-preview-gateway-previewgateway-submitcapabilityreview-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L213)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(id: string) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-importsource-callable-value"></a>
## PreviewGateway.importSource

ID `fn-workbench-ui-preview-gateway-previewgateway-importsource-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L221)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(ref: ContextRef) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-setrole-callable-value"></a>
## PreviewGateway.setRole

ID `fn-workbench-ui-preview-gateway-previewgateway-setrole-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L242)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
(role: Role) =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-preview-gateway-previewgateway-resetpreview-callable-value"></a>
## PreviewGateway.resetPreview

ID `fn-workbench-ui-preview-gateway-previewgateway-resetpreview-callable-value`；callable-value / internal；主归属建议 G；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/preview/gateway.ts#L247)；SHA-256 `2bde375cc3e4ec9aad69cd45b98427ddf017139a3fedbc13cc415c96cce9513e`。

```ts
() =>
```

源码未提供相邻说明；目的、作用、错误/未知、消费者与验收需在契约中补齐。

<a id="fn-workbench-ui-workbench-workbench-function"></a>
## Workbench

ID `fn-workbench-ui-workbench-workbench-function`；function / exported；主归属建议 A；设计 source-indexed-needs-contract-review；本轮验证 unverified。

[源码](https://github.com/qingshanfeihu/infosec-platform/blob/3b98096057438cc4a89134562ea7f7d31059e696/packages/workbench-ui/src/workbench.tsx#L12)；SHA-256 `15cbe6d41b84a9fbb2fd3a6c0e5d272590b0ad4202eb1d5e866b11f73f0417bd`。

```ts
export function Workbench({
  gateway,
  platform,
  plugins,
}: {
  gateway: WorkbenchGateway;
  platform: PlatformBridge;
  plugins: WorkbenchPlugin[];
})
```

源码说明（原注释，仅作来源）

```text
/** Composition root. Hosts supply their data adapter and explicitly bundled UI plugins. */
```

</details>
