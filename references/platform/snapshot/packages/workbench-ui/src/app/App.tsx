import {
  ArrowUpRight,
  ChevronRight,
  FolderOpen,
  GitBranch,
  Moon,
  PanelLeft,
  PanelRight,
  Search,
  Settings,
  Sun,
} from "lucide-react";
import { Tooltip } from "radix-ui";
import {
  useEffect,
  useLayoutEffect,
  useState,
  useSyncExternalStore,
} from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import {
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import { CommandMenu } from "../components/CommandMenu";
import { Sidebar } from "../components/Sidebar";
import {
  Badge,
  Button,
  IconButton,
  Modal,
  PermissionState,
} from "../components/ui";
import { ContextPanel } from "../features/ContextPanel";
import { ConversationView } from "../features/ConversationView";
import type { SideView } from "../platform/types";
import { usePlugins } from "../plugins/context";
import { PluginBoundary } from "../plugins/PluginBoundary";
import { useWorkbench } from "./context";
import { useManagementNavigation } from "./navigation";
const roleNames = {
  engineer: "工程师",
  viewer: "观察员",
  expert: "方法维护者",
  maintainer: "平台运维",
};
function useNarrow() {
  return useSyncExternalStore(
    (callback) => {
      const media = matchMedia("(max-width: 1050px)");
      media.addEventListener("change", callback);
      return () => media.removeEventListener("change", callback);
    },
    () => matchMedia("(max-width: 1050px)").matches,
  );
}
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
}) {
  const { id } = useParams();
  const { snapshot, gateway } = useWorkbench();
  const narrow = useNarrow();
  const conversation = snapshot.conversations.find((c) => c.id === id);
  useLayoutEffect(() => {
    if (conversation) onActive(conversation.id);
  }, [conversation?.id, onActive]);
  if (!gateway.can("read-business")) return <PermissionState />;
  if (!conversation)
    return <Navigate to={`/agent/${snapshot.conversations[0]?.id}`} replace />;
  const main = (
    <ConversationView
      conversation={conversation}
      onContext={() => {
        setSideView("context");
        setPanelOpen(true);
      }}
    />
  );
  const panel = (
    <ContextPanel
      key={conversation.id}
      conversation={conversation}
      view={sideView}
      onView={setSideView}
      onClose={() => setPanelOpen(false)}
    />
  );
  if (narrow)
    return (
      <div className="agent-page">
        {main}
        <Modal open={panelOpen} onOpenChange={setPanelOpen} title="会话侧栏">
          {panel}
        </Modal>
      </div>
    );
  return (
    <div className="agent-page">
      <Group orientation="horizontal" id="conversation-layout">
        <Panel
          id="conversation"
          defaultSize={panelOpen ? "70%" : "100%"}
          minSize="40%"
        >
          {main}
        </Panel>
        {panelOpen && (
          <>
            <Separator
              className="resize-handle"
              aria-label="调整会话侧栏宽度"
            />
            <Panel id="context" defaultSize="30%" minSize={260} maxSize="50%">
              {panel}
            </Panel>
          </>
        )}
      </Group>
    </div>
  );
}
function ManagementRoute({ conversationId }: { conversationId: string }) {
  const { section } = useParams();
  const navigate = useNavigate();
  const navigation = useManagementNavigation();
  const { gateway } = useWorkbench();
  const { registry } = usePlugins();
  const page = navigation.find((item) => item.path === section);
  if (!page) {
    const plugin = registry.plugins.find((item) =>
      item.pages?.some((p) => p.path === section),
    );
    return (
      <div className="permission-state">
        <h2>{plugin ? "这个插件已停用" : "找不到这个页面"}</h2>
        <p>
          {plugin
            ? `${plugin.name}的记录仍然保留，启用后可以继续查看。`
            : "可以从插件页选择需要的页面。"}
        </p>
        <Button onClick={() => navigate("/manage/plugins")}>管理插件</Button>
      </div>
    );
  }
  if (page.permission && !gateway.can(page.permission))
    return <PermissionState />;
  return (
    <PluginBoundary key={page.path} name={page.label}>
      <page.component conversationId={conversationId} />
    </PluginBoundary>
  );
}
export function App() {
  const managementNavigation = useManagementNavigation();
  const { snapshot, toast } = useWorkbench();
  const location = useLocation();
  const navigate = useNavigate();
  const narrow = useNarrow();
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [activeId, setActiveId] = useState(() => {
    const saved = sessionStorage.getItem(
      "infosec.workbench.active-conversation",
    );
    return snapshot.conversations.some(
      (conversation) => conversation.id === saved,
    )
      ? saved!
      : (snapshot.conversations[0]?.id ?? "conversation-01");
  });
  useEffect(() => {
    sessionStorage.setItem("infosec.workbench.active-conversation", activeId);
  }, [activeId]);
  const [sideView, setSideView] = useState<SideView>("context");
  const [desktopPanel, setDesktopPanel] = useState(true);
  const [mobilePanel, setMobilePanel] = useState(false);
  const [theme, setTheme] = useState(
    () => localStorage.getItem("infosec.workbench.theme") ?? "light",
  );
  const panelOpen = narrow ? mobilePanel : desktopPanel;
  const setPanelOpen = narrow ? setMobilePanel : setDesktopPanel;
  const managing = location.pathname.startsWith("/manage");
  const currentSection = managementNavigation.find((item) =>
    location.pathname.includes(`/manage/${item.path}`),
  );
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem("infosec.workbench.theme", theme);
  }, [theme]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        !document.querySelector('[role="dialog"]')
      ) {
        event.preventDefault();
        setCommandOpen(true);
      }
    };
    addEventListener("keydown", handler);
    return () => removeEventListener("keydown", handler);
  }, []);
  return (
    <Tooltip.Provider delayDuration={350}>
      <div className="workbench">
        <div className="desktop-sidebar">
          <Sidebar
            activeConversationId={activeId}
            onSearch={() => setCommandOpen(true)}
          />
        </div>
        <main className="workspace" data-route={location.pathname}>
          <header className="topbar">
            <div className="topbar-path">
              <span className="mobile-only">
                <IconButton
                  label="打开导航"
                  onClick={() => setSidebarOpen(true)}
                >
                  <PanelLeft size={17} />
                </IconButton>
              </span>
              {managing ? (
                <>
                  <span>平台管理</span>
                  <ChevronRight size={12} />
                  <strong>{currentSection?.label}</strong>
                </>
              ) : (
                <>
                  <FolderOpen size={14} />
                  <strong>
                    {snapshot.conversations.find((c) => c.id === activeId)
                      ?.workspace ?? "工作区"}
                  </strong>
                  <span className="branch">
                    <GitBranch size={11} />
                    main
                  </span>
                </>
              )}
            </div>
            <div className="topbar-actions">
              <button
                className="search-shortcut"
                onClick={() => setCommandOpen(true)}
                aria-label="全局搜索"
              >
                <Search size={13} />
                <span>搜索</span>
                <kbd>⌘ K</kbd>
              </button>
              <button
                className="preview-indicator"
                onClick={() => setPreviewOpen(true)}
              >
                <span />
                前端预览
              </button>
              <IconButton
                label={theme === "light" ? "切换深色主题" : "切换浅色主题"}
                onClick={() => setTheme(theme === "light" ? "dark" : "light")}
              >
                {theme === "light" ? <Moon size={15} /> : <Sun size={15} />}
              </IconButton>
              {!managing && (
                <IconButton
                  label={panelOpen ? "收起会话侧栏" : "打开会话侧栏"}
                  onClick={() => setPanelOpen(!panelOpen)}
                >
                  <PanelRight size={16} />
                </IconButton>
              )}
              <button
                className="profile-button"
                onClick={() => navigate("/manage/settings")}
                aria-label="角色与设置"
              >
                <span className="profile-avatar">林</span>
                <span>{roleNames[snapshot.role]}</span>
              </button>
            </div>
          </header>
          <Routes>
            <Route
              path="/"
              element={
                <Navigate
                  to={`/agent/${snapshot.conversations[0]?.id}`}
                  replace
                />
              }
            />
            <Route
              path="/agent/:id"
              element={
                <AgentPage
                  onActive={setActiveId}
                  sideView={sideView}
                  setSideView={setSideView}
                  panelOpen={panelOpen}
                  setPanelOpen={setPanelOpen}
                />
              }
            />
            <Route
              path="/manage/:section"
              element={<ManagementRoute conversationId={activeId} />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <CommandMenu open={commandOpen} onOpenChange={setCommandOpen} />
        <Modal open={sidebarOpen} onOpenChange={setSidebarOpen} title="导航">
          <Sidebar
            activeConversationId={activeId}
            onSearch={() => {
              setSidebarOpen(false);
              setCommandOpen(true);
            }}
            onNavigate={() => setSidebarOpen(false)}
            onClose={() => setSidebarOpen(false)}
          />
        </Modal>
        <Modal
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          title="前端预览"
          description="用于确定桌面工作台的界面和交互。"
        >
          <div className="preview-summary">
            <Badge tone="blue">React / TypeScript</Badge>
            <p>
              会话、草稿、资料引用和操作请求保存在当前浏览器。初始资料与运行记录是样例，Agent、模型和真实设备尚未连接。
            </p>
            <p>
              页面通过数据接口与宿主接口工作。后续可以接入平台服务，并由
              Electron 承载同一套界面。
            </p>
            <Button
              onClick={() => {
                setPreviewOpen(false);
                navigate("/manage/settings");
              }}
            >
              <Settings size={14} />
              查看设置
              <ArrowUpRight size={12} />
            </Button>
          </div>
        </Modal>
        {toast && (
          <div className="toast" role="status">
            {toast}
          </div>
        )}
      </div>
    </Tooltip.Provider>
  );
}
