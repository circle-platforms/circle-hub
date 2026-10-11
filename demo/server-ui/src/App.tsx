import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Activity,
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  BookOpen,
  Check,
  ChevronDown,
  ChevronRight,
  Clock3,
  Code2,
  Command,
  Ellipsis,
  FileCheck2,
  FileText,
  GitBranch,
  Inbox,
  Layers,
  LayoutDashboard,
  Link2,
  LockKeyhole,
  MessageSquare,
  Network,
  PanelLeftClose,
  Play,
  Plus,
  Search,
  Send,
  Server,
  Settings2,
  ShieldCheck,
  Terminal,
  Unplug,
  Users,
  Workflow,
  X,
  RefreshCw,
  History,
  CheckCircle2,
  AlertTriangle,
  FolderKanban,
  Globe,
} from "lucide-react";
import {
  initialState,
  enrichState,
  roles,
  phaseLabels,
  phaseTone,
  pageMeta,
  execute,
  permitted,
  visibleTasks,
  visibleDocs,
  type DemoState,
  type Page,
  type Role,
  type Environment,
  type Task,
} from "./domain.ts";
import {
  Badge,
  Button,
  Card,
  Checklist,
  Classification,
  Empty,
  Flow,
  JsonBlock,
  KeyValues,
  Metric,
  Modal,
  Notice,
  Progress,
  SectionLink,
  Sparkline,
  Tabs,
} from "./components.tsx";
import { DemoContext, useDemo } from "./ui-context.tsx";
import {
  KnowledgePage,
  MethodsPage,
  ExecutionPage,
  DiagnosisPage,
  SchedulesPage,
  AccessPage,
  DeliveryPage,
  MonitoringPage,
  AuditPage,
  SettingsPage,
  ArchitecturePage,
} from "./pages.tsx";
import { AgentsPage, InboxPage } from "./agent-pages.tsx";
import CircleView from "./CircleView.tsx";
import { ScenarioWork } from "./work-pages.tsx";
import type { ScenarioId } from "./workflows.ts";

const storageKey = "circle-server-design-demo-v3";
function load(): DemoState {
  try {
    const raw = localStorage.getItem(storageKey);
    if (raw) {
      const v = JSON.parse(raw);
      if (
        v.schema === 3 &&
        Array.isArray(v.tasks) &&
        Array.isArray(v.agents) &&
        Array.isArray(v.runs) &&
        Array.isArray(v.audit)
      )
        return enrichState(v);
    }
  } catch {}
  return initialState();
}
const navGroups: {
  label: string;
  items: { page: Page; icon: typeof Activity; badge?: string }[];
}[] = [
  {
    label: "工作",
    items: [
      { page: "agents", icon: Workflow },
      { page: "tasks", icon: Inbox },
      { page: "inbox", icon: MessageSquare },
      { page: "schedules", icon: Clock3 },
    ],
  },
  {
    label: "共享资源",
    items: [
      { page: "knowledge", icon: BookOpen },
      { page: "methods", icon: Code2 },
      { page: "execution", icon: Server },
    ],
  },
  {
    label: "治理与运维",
    items: [
      { page: "monitoring", icon: Activity },
      { page: "access", icon: ShieldCheck },
      { page: "audit", icon: History },
      { page: "settings", icon: Settings2 },
    ],
  },
  { label: "研发", items: [{ page: "delivery", icon: FolderKanban }] },
];
export default function App() {
  const [state, setState] = useState<DemoState>(load);
  const [role, setRole] = useState<Role>("expert");
  const [environment, setEnvironment] = useState<Environment>("lab");
  const [project, setProject] = useState("lb");
  const [page, setPage] = useState<Page>(
    new URLSearchParams(window.location.search).get("view") === "server"
      ? "agents"
      : "circle",
  );
  const [scenarioSelection, setScenarioSelection] = useState<{
    id: ScenarioId;
    nonce: number;
  } | null>(null);
  const [selectedTask, setSelectedTask] = useState<string | null>(null);
  const [focusTaskId, setFocusTaskId] = useState("TSK-2084");
  const [sceneRequested, setSceneRequested] = useState(false);
  const [agentSelection, setAgentSelection] = useState<{
    id: string;
    tab: string;
    input?: string;
  } | null>(null);
  const [evidence, setEvidence] = useState<string | null>(null);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState("");
  const [sidebar, setSidebar] = useState(false);
  const [tour, setTour] = useState<number | null>(null);
  const [dark, setDark] = useState(false);
  const context = { role, environment, project };
  const currentState = useRef(state);
  const currentContext = useRef(context);
  currentState.current = state;
  currentContext.current = context;
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify(state));
    } catch {}
  }, [state]);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
  }, [dark]);
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setSearch((s) => !s);
      }
      if (e.key === "Escape") {
        setSearch(false);
        setEvidence(null);
        setDocumentId(null);
        setSidebar(false);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);
  const notify = (message: string, error = false) =>
    setToast({ message, error });
  const go = (value: Page) => {
    setPage(value);
    setSelectedTask(null);
    setAgentSelection(null);
    setSceneRequested(false);
    setSidebar(false);
  };
  const openTask = (id: string) => {
    setSelectedTask(id);
    setFocusTaskId(id);
    setPage("tasks");
    setSidebar(false);
  };
  const openScene = (id: string) => {
    setFocusTaskId(id);
    setSceneRequested(true);
    setSelectedTask(null);
    setPage("execution");
    setSidebar(false);
  };
  const openAgent = (id: string, tab = "overview", input?: string) => {
    setAgentSelection({ id, tab, input });
    setPage("agents");
    setSidebar(false);
  };
  const act = (action: Parameters<typeof execute>[2]) => {
    const result = execute(
      currentState.current,
      currentContext.current,
      action,
    );
    currentState.current = result.state;
    setState(result.state);
    notify(result.message, !result.ok);
    return result;
  };
  const startScenario = (id: ScenarioId) => {
    setScenarioSelection((previous) => ({
      id,
      nonce: (previous?.nonce ?? 0) + 1,
    }));
    go("circle");
  };
  const startTour = (index: number) => {
    setTour(index);
    setEnvironment("lab");
    setProject("lb");
    const pages: Page[] = [
      "agents",
      "circle",
      "tasks",
      "knowledge",
      "execution",
      "inbox",
      "monitoring",
      "delivery",
    ];
    const tourRoles: Role[] = [
      "expert",
      "tester",
      "tester",
      "expert",
      "tester",
      "approver",
      "ops",
      "tester",
    ];
    setRole(tourRoles[index]);
    go(pages[index]);
    if (index === 2) {
      setSelectedTask("TSK-2084");
      setFocusTaskId("TSK-2084");
    }
    if (index === 4) {
      setFocusTaskId("TSK-2084");
      setSceneRequested(true);
    }
  };
  const task = selectedTask
    ? visibleTasks(state, context).find((t) => t.id === selectedTask)
    : undefined;
  const artifact =
    evidence && permitted(context, "business.read")
      ? state.artifacts.find(
          (a) =>
            a.id === evidence &&
            visibleTasks(state, context).some((t) => t.id === a.task),
        )
      : undefined;
  const doc = documentId
    ? visibleDocs(state, context).find((d) => d.id === documentId)
    : undefined;
  const userTasks = visibleTasks(state, context);
  const userDocs = visibleDocs(state, context);
  let content: ReactNode;
  switch (page) {
    case "agents":
      content = <AgentsPage />;
      break;
    case "inbox":
      content = <InboxPage />;
      break;
    case "overview":
      content = <OverviewPage startTour={() => startTour(0)} />;
      break;
    case "circle":
      content = <CircleView />;
      break;
    case "tasks":
      content = selectedTask ? (
        task ? (
          <TaskDetail task={task} onBack={() => setSelectedTask(null)} />
        ) : (
          <Empty
            locked
            title="此范围不可读取"
            description="当前角色、项目或环境不允许读取这项任务。切换演示身份可以查看不同范围。"
          />
        )
      ) : (
        <TasksPage />
      );
      break;
    case "knowledge":
      content = <KnowledgePage />;
      break;
    case "methods":
      content = <MethodsPage />;
      break;
    case "execution":
      content = <ExecutionPage />;
      break;
    case "diagnosis":
      content = <DiagnosisPage />;
      break;
    case "schedules":
      content = <SchedulesPage />;
      break;
    case "access":
      content = <AccessPage />;
      break;
    case "delivery":
      content = <DeliveryPage />;
      break;
    case "monitoring":
      content = <MonitoringPage />;
      break;
    case "audit":
      content = <AuditPage />;
      break;
    case "settings":
      content = <SettingsPage />;
      break;
    case "architecture":
      content = <ArchitecturePage />;
      break;
  }
  const tourTexts = [
    [
      "团队先配置和发布 Agent",
      "进入一个 Agent，设置职责、知识与工具，查看测试步骤，再由指定人员评审并发布。",
    ],
    [
      "用户在 Circle 中委派工作",
      "选择已发布的 Agent，描述目标，查看消息和原始输出。断开连接后工作记录仍保留。",
    ],
    [
      "跟进同一项持续工作",
      "交互、运行、证据和未知项分别可查。补充输入形成新修订，原运行和旧决定仍保留。",
    ],
    [
      "公司资料从已有系统接入",
      "来源继承权限，保存固定修订再发布快照。新资料不会静默改变正在进行的工作。",
    ],
    [
      "查看同一执行现场",
      "SSH 与 Web 现场关联同一任务和操作。接管后 Agent 等待，停止先进入执行核对。",
    ],
    [
      "需要人时给出具体请求",
      "现在切换为业务审批身份。请求包含目标、影响、依据和继续方式，回应绑定当前修订。",
    ],
    [
      "从异常追到具体运行",
      "运维看服务和节点；业务正文另需权限。异常能追到任务、执行步骤和原始输入输出。",
    ],
    [
      "改进 Agent 并安排产品交付",
      "工程故事、Sprint、代码、组合验收和发行分别记录。运行反馈回到版本改进流程。",
    ],
  ];
  return (
    <DemoContext.Provider
      value={{
        state,
        context,
        page,
        act,
        go,
        openTask,
        openScene,
        sceneRequested,
        openEvidence: setEvidence,
        openDocument: setDocumentId,
        openAgent,
        agentSelection,
        focusTaskId,
        setRole,
        notify,
        startScenario,
        scenarioSelection,
      }}
    >
      <div className={`app-shell ${page === "circle" ? "circle-mode" : ""}`}>
        {sidebar && (
          <div className="sidebar-scrim" onClick={() => setSidebar(false)} />
        )}
        <aside className={`sidebar ${sidebar ? "expanded" : ""}`}>
          <div className="brand">
            <span className="circle-logo" />
            <div>
              <strong>circle</strong>
              <small>团队管理</small>
            </div>
          </div>
          <div className="mode-switch">
            <button
              className={page !== "circle" ? "active" : ""}
              onClick={() => go("agents")}
            >
              <Server size={14} />
              团队管理
            </button>
            <button
              className={page === "circle" ? "active" : ""}
              onClick={() => go("circle")}
            >
              <MessageSquare size={14} />
              返回会话
            </button>
          </div>
          <button className="sidebar-search" onClick={() => setSearch(true)}>
            <Search size={14} />
            <span>搜索任务、资料和功能</span>
            <kbd>⌘ K</kbd>
          </button>
          <nav>
            {navGroups.map((g) => (
              <div className="nav-group" key={g.label}>
                <p>{g.label}</p>
                {g.items.map(({ page: value, icon: Icon, badge }) => (
                  <button
                    key={value}
                    className={`nav-item ${page === value ? "active" : ""}`}
                    onClick={() => go(value)}
                  >
                    <Icon size={16} strokeWidth={1.65} />
                    <span>{pageMeta[value].label}</span>
                    {badge && <small className="object-letter">{badge}</small>}
                    {value === "tasks" && (
                      <em>
                        {
                          userTasks.filter(
                            (t) => !["done", "stopped"].includes(t.phase),
                          ).length
                        }
                      </em>
                    )}
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="sidebar-footer">
            <div className="server-status">
              <span className="status-dot" />
              <span>设计预览</span>
              <Badge>合成数据</Badge>
            </div>
            <button
              onClick={() => {
                setState(initialState());
                notify("已重置当前浏览器的演示数据。");
              }}
            >
              <RefreshCw size={13} />
              重置演示数据
            </button>
          </div>
        </aside>
        <div className="main-shell">
          <header className="topbar">
            <div className="breadcrumbs">
              <button
                className="icon-button mobile-menu"
                aria-label="打开导航"
                onClick={() => setSidebar(true)}
              >
                <PanelLeftClose size={18} />
              </button>
              <span>产品研发</span>
              <ChevronRight size={13} />
              <select
                aria-label="项目"
                value={project}
                onChange={(e) => {
                  setProject(e.target.value);
                  setSelectedTask(null);
                }}
              >
                <option value="lb">负载均衡研发</option>
                <option value="fw">防火墙研发</option>
              </select>
              <Badge tone={environment === "lab" ? "blue" : "amber"}>
                {environment === "lab" ? "测试域" : "生产域"}
              </Badge>
            </div>
            <div className="topbar-actions">
              <select
                aria-label="环境"
                value={environment}
                onChange={(e) => {
                  setEnvironment(e.target.value as Environment);
                  setSelectedTask(null);
                }}
              >
                <option value="lab">测试域</option>
                <option value="production">生产域</option>
              </select>
              <button
                className="icon-button theme-button"
                aria-label="切换主题"
                title="切换主题"
                onClick={() => setDark((v) => !v)}
              >
                <span>{dark ? "☀" : "◐"}</span>
              </button>
              <span className="topbar-separator" />
              <label className="role-picker">
                <span>演示角色</span>
                <select
                  aria-label="演示角色"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  {Object.entries(roles).map(([key, r]) => (
                    <option key={key} value={key}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <span className="avatar">{roles[role].initials}</span>
            </div>
          </header>
          <main
            className={`main-content ${page === "circle" ? "circle-content" : ""}`}
          >
            {page !== "circle" && (
              <div className="page-heading">
                <div>
                  <div className="eyebrow">
                    CIRCLE SERVER
                    {pageMeta[page].object && (
                      <span>{pageMeta[page].object} 的运行职责</span>
                    )}
                  </div>
                  <h1>{pageMeta[page].label}</h1>
                  <p>{pageMeta[page].description}</p>
                </div>
                <div className="page-heading-actions">
                  <Badge tone="violet">交互 Demo</Badge>
                  <Button small onClick={() => startTour(0)}>
                    <Play size={13} />
                    演示导览
                  </Button>
                </div>
              </div>
            )}
            {content}
          </main>
          <footer className="page-footer">
            <span>合成资料 · 运行、接入与权限均为浏览器内交互模拟</span>
            <button onClick={() => go("architecture")}>
              了解系统设计 <ArrowUpRight size={12} />
            </button>
          </footer>
        </div>
        {toast && (
          <div className={`toast ${toast.error ? "error" : ""}`} role="status">
            {toast.error ? (
              <AlertTriangle size={17} />
            ) : (
              <CheckCircle2 size={17} />
            )}
            <span>{toast.message}</span>
            <button aria-label="关闭通知" onClick={() => setToast(null)}>
              <X size={14} />
            </button>
          </div>
        )}
        {search && (
          <Modal
            title="搜索"
            subtitle="只展示当前身份和范围可读取的记录"
            onClose={() => setSearch(false)}
          >
            <input
              className="search-input"
              autoFocus
              placeholder="任务、资料、资源或功能…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
            <div className="search-results">
              <small>功能入口</small>
              {Object.entries(pageMeta)
                .filter(([, v]) => v.label.includes(query))
                .map(([k, v]) => (
                  <button
                    key={k}
                    onClick={() => {
                      go(k as Page);
                      setSearch(false);
                    }}
                  >
                    <Layers size={15} />
                    <span>{v.label}</span>
                    <ChevronRight size={14} />
                  </button>
                ))}
              {userTasks
                .filter((t) => t.title.includes(query))
                .map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      openTask(t.id);
                      setSearch(false);
                    }}
                  >
                    <Inbox size={15} />
                    <span>{t.title}</span>
                    <code>{t.id}</code>
                  </button>
                ))}
              {userDocs
                .filter((d) => d.title.includes(query))
                .map((d) => (
                  <button
                    key={d.id}
                    onClick={() => {
                      setDocumentId(d.id);
                      setSearch(false);
                    }}
                  >
                    <BookOpen size={15} />
                    <span>{d.title}</span>
                    <code>{d.id}</code>
                  </button>
                ))}
            </div>
          </Modal>
        )}
        {evidence && (
          <Modal
            title={artifact?.title ?? "证据访问受限"}
            subtitle={
              artifact
                ? `${artifact.id} · ${artifact.scope}`
                : "当前身份或范围不允许读取该原件"
            }
            wide
            onClose={() => setEvidence(null)}
          >
            {artifact ? (
              <>
                <div className="row gap">
                  <Classification kind={artifact.classification} />
                  <Badge>合成记录</Badge>
                </div>
                <p className="paragraph">{artifact.excerpt}</p>
                <KeyValues
                  items={[
                    { label: "来源", value: artifact.source },
                    { label: "方法版本", value: artifact.method },
                    { label: "位置", value: artifact.locator },
                    {
                      label: "关联任务",
                      value: (
                        <button
                          className="text-link"
                          onClick={() => {
                            openTask(artifact.task);
                            setEvidence(null);
                          }}
                        >
                          {artifact.task}
                        </button>
                      ),
                    },
                  ]}
                />
                <div className="two-col">
                  <JsonBlock label="输入" value={artifact.input} />
                  <JsonBlock label="输出" value={artifact.output} />
                </div>
                <Notice>
                  工具返回、判断、产物与业务效果分别记录。这里展示的是合成输入输出，没有设备操作。
                </Notice>
              </>
            ) : (
              <Empty
                locked
                title="原件不可读取"
                description="引用存在不会绕过资料和证据的访问范围。"
              />
            )}
          </Modal>
        )}
        {documentId && (
          <Modal
            title={doc?.title ?? "资料访问受限"}
            subtitle={
              doc
                ? `${doc.id} · ${doc.revision} · ${doc.product}`
                : "当前身份或范围没有这份资料的读取权限"
            }
            wide
            onClose={() => setDocumentId(null)}
          >
            {doc ? (
              <>
                <div className="row gap">
                  <Badge tone="blue">{doc.kind}</Badge>
                  <Badge>{doc.nature}</Badge>
                  <Badge>{doc.scope}</Badge>
                </div>
                <div className="document-excerpt">
                  <small>原文位置 · {doc.locator}</small>
                  <blockquote>{doc.excerpt}</blockquote>
                  <p>本页为合成产品资料，不对应实际产品规格。</p>
                </div>
                <KeyValues
                  items={[
                    {
                      label: "来源系统",
                      value: state.sources.find((s) => s.id === doc.source)
                        ?.title,
                    },
                    { label: "固定修订", value: doc.revision },
                    { label: "当前发布快照", value: state.stableSnapshot },
                    { label: "访问范围", value: doc.scope },
                  ]}
                />
                <h3 className="section-title">相关资料</h3>
                {doc.related.map((id) => {
                  const related = userDocs.find((d) => d.id === id);
                  return (
                    related && (
                      <button
                        className="list-link"
                        key={id}
                        onClick={() => setDocumentId(id)}
                      >
                        <FileText size={16} />
                        {related.title}
                        <ChevronRight size={14} />
                      </button>
                    )
                  );
                })}
                <Notice>
                  文档声明与运行观察分别保留。正文被引用不等于所有产品结论已获得验证。
                </Notice>
              </>
            ) : (
              <Empty
                locked
                title="正文不可读取"
                description="检索、原件、引用和导出需要相同范围的授权。"
              />
            )}
          </Modal>
        )}
        {tour !== null && (
          <div className="tour-card">
            <button
              className="tour-close"
              aria-label="关闭导览"
              onClick={() => setTour(null)}
            >
              <X size={15} />
            </button>
            <div className="tour-count">
              设计导览{" "}
              <span>
                {tour + 1} / {tourTexts.length}
              </span>
            </div>
            <h3>{tourTexts[tour][0]}</h3>
            <p>{tourTexts[tour][1]}</p>
            <div className="tour-controls">
              <div>
                {tourTexts.map((_, i) => (
                  <button
                    aria-label={`导览第 ${i + 1} 步`}
                    key={i}
                    className={i === tour ? "active" : ""}
                    onClick={() => startTour(i)}
                  />
                ))}
              </div>
              <Button
                small
                primary
                onClick={() =>
                  tour < tourTexts.length - 1
                    ? startTour(tour + 1)
                    : setTour(null)
                }
              >
                {tour < tourTexts.length - 1 ? "下一步" : "完成导览"}
                <ArrowRight size={13} />
              </Button>
            </div>
          </div>
        )}
      </div>
    </DemoContext.Provider>
  );
}

function OverviewPage({ startTour }: { startTour: () => void }) {
  const { state, context, openTask, go } = useDemo();
  const tasks = visibleTasks(state, context);
  const active = tasks.filter((t) => !["done", "stopped"].includes(t.phase));
  const attention = tasks.filter((t) =>
    ["review", "waiting", "unknown"].includes(t.phase),
  );
  const workers = state.workers.filter((w) =>
    context.environment === "production"
      ? w.id.startsWith("PROD")
      : !w.id.startsWith("PROD"),
  );
  return (
    <>
      <div className="overview-intro">
        <div>
          <span className="mini-label">今天 · 10 月 11 日</span>
          <h2>
            {attention.length
              ? `有 ${attention.length} 项工作需要处理`
              : "查看当前身份可管理的范围"}
          </h2>
          <p>需要回应的任务、结果待核对的操作和团队正在推进的工作。</p>
        </div>
        <Button primary onClick={startTour}>
          <Play size={15} />
          跟着一项任务看设计
        </Button>
      </div>
      <div className="metrics-grid">
        <Metric
          label="在途任务"
          value={active.length}
          detail="在授权项目与环境内"
          values={[3, 4, 3, 5, 4, 6, 5]}
        />
        <Metric
          label="需要人员回应"
          value={attention.filter((t) => t.phase !== "unknown").length}
          detail="补充输入或具体动作批准"
          values={[1, 2, 1, 3, 2, 2, 2]}
        />
        <Metric
          label="结果待核对"
          value={tasks.filter((t) => t.phase === "unknown").length}
          detail="不自动重发已有操作"
          values={[0, 0, 1, 0, 0, 1, 1]}
        />
        <Metric
          label="可用执行节点"
          value={workers.filter((w) => w.status === "online").length}
          unit={`/ ${workers.length}`}
          detail="当前网络区域的合成状态"
          values={[2, 3, 3, 2, 3, 2, 2]}
        />
      </div>
      <div className="overview-columns">
        <div>
          <Card
            title="现在需要处理"
            extra={
              <SectionLink onClick={() => go("tasks")}>任务中心</SectionLink>
            }
          >
            {attention.length ? (
              attention.map((t) => (
                <button
                  className="attention-row"
                  key={t.id}
                  onClick={() => openTask(t.id)}
                >
                  <span className={`attention-icon ${phaseTone[t.phase]}`}>
                    {t.phase === "unknown" ? (
                      <Unplug size={18} />
                    ) : t.phase === "review" ? (
                      <ShieldCheck size={18} />
                    ) : (
                      <MessageSquare size={18} />
                    )}
                  </span>
                  <div>
                    <b>{t.title}</b>
                    <p>
                      {t.phase === "review"
                        ? "等待指定人员批准当前输入与具体动作"
                        : t.phase === "unknown"
                          ? "网络断开后保留原操作，等待核对"
                          : t.unknowns[0]}
                    </p>
                  </div>
                  <Badge tone={phaseTone[t.phase]}>
                    {phaseLabels[t.phase]}
                  </Badge>
                  <ChevronRight size={16} />
                </button>
              ))
            ) : (
              <Empty
                locked
                title="当前身份没有业务工作项"
                description="安全与运维角色不默认读取业务正文。你仍可以查看获准的管理页面。"
              />
            )}
          </Card>
          <Card
            title="在途工作"
            extra={<Badge>持续保留任务状态</Badge>}
            className="mt-20"
          >
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>任务</th>
                    <th>状态</th>
                    <th>运行时长</th>
                    <th>进度</th>
                  </tr>
                </thead>
                <tbody>
                  {active.slice(0, 4).map((t) => (
                    <tr
                      key={t.id}
                      onClick={() => openTask(t.id)}
                      className="clickable"
                    >
                      <td>
                        <b>{t.title}</b>
                        <small>
                          {t.id} · {t.owner}
                        </small>
                      </td>
                      <td>
                        <Badge tone={phaseTone[t.phase]}>
                          {phaseLabels[t.phase]}
                        </Badge>
                      </td>
                      <td>{t.duration}</td>
                      <td>
                        <Progress value={t.progress} />
                        <small>{t.progress}% · 演示进度</small>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!active.length && (
              <Empty
                title="没有可见的在途工作"
                description="当前角色或范围没有业务读取权限。"
              />
            )}
          </Card>
        </div>
        <div>
          <Card
            title="一次工作，四个职责"
            extra={
              <Button small onClick={() => go("architecture")}>
                查看设计
                <ArrowUpRight size={12} />
              </Button>
            }
          >
            <div className="responsibility-list">
              {[
                {
                  letter: "B",
                  title: "知识与证据",
                  text: "从公司资料找到固定版本的依据",
                  page: "knowledge",
                },
                {
                  letter: "C",
                  title: "任务与协作",
                  text: "持续推进、保存输入和人员决定",
                  page: "tasks",
                },
                {
                  letter: "D",
                  title: "执行与资源",
                  text: "连接目标、保存现场与实际输出",
                  page: "execution",
                },
                {
                  letter: "E",
                  title: "专业方法",
                  text: "按产品与版本选择检查和分析",
                  page: "methods",
                },
              ].map((r) => (
                <button key={r.letter} onClick={() => go(r.page as Page)}>
                  <span className={`object-symbol symbol-${r.letter}`}>
                    {r.letter}
                  </span>
                  <div>
                    <b>{r.title}</b>
                    <p>{r.text}</p>
                  </div>
                  <ChevronRight size={14} />
                </button>
              ))}
            </div>
          </Card>
          <Card
            title="服务与网络区域"
            extra={
              <SectionLink onClick={() => go("monitoring")}>
                运行监控
              </SectionLink>
            }
            className="mt-20"
          >
            <div className="service-summary">
              <div>
                <span className="status-dot" />
                中心后台 <Badge tone="green">演示正常</Badge>
              </div>
              <div>
                <span className="status-dot" />
                持久任务与证据 <Badge tone="green">合成记录</Badge>
              </div>
              <div>
                <span className="status-dot amber" />
                华西测试网 <Badge tone="amber">连接待恢复</Badge>
              </div>
            </div>
            <p className="card-note">中心、执行节点与客户端的状态分别显示。</p>
          </Card>
          <div className="quiet-card">
            <GitBranch size={19} />
            <div>
              <b>产品交付 · Sprint 04</b>
              <p>代码合并、组合验收和发行各有状态。</p>
              <button className="text-link" onClick={() => go("delivery")}>
                查看故事与版本组合 <ArrowRight size={13} />
              </button>
            </div>
          </div>
        </div>
      </div>
      <Card title="从用户目标到可核对的交付" className="mt-20">
        <Flow compact />
      </Card>
    </>
  );
}

function TasksPage() {
  const { state, context, act, openTask } = useDemo();
  const [view, setView] = useState("list");
  const [collection, setCollection] = useState("work");
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [newTask, setNewTask] = useState(false);
  const [prompt, setPrompt] = useState("");
  const [agentId, setAgentId] = useState("AGT-001");
  const tasks = visibleTasks(state, context).filter(
    (t) => (filter === "all" || t.phase === filter) && t.title.includes(query),
  );
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="当前身份没有业务任务读取权"
        description="任务正文、证据与现场按业务范围保护。运维和安全管理员从自己的管理入口工作。"
      />
    );
  return (
    <>
      <Tabs
        tabs={[
          {
            id: "work",
            label: "用户工作",
            count: visibleTasks(state, context).length,
          },
          {
            id: "runs",
            label: "运行记录",
            count: state.runs.filter((r) =>
              visibleTasks(state, context).some((t) => t.id === r.taskId),
            ).length,
          },
          { id: "sessions", label: "会话" },
        ]}
        value={collection}
        onChange={setCollection}
      />
      <div className="toolbar">
        <div className="row gap">
          {collection === "work" && (
            <div className="segmented">
              <button
                className={view === "list" ? "active" : ""}
                onClick={() => setView("list")}
              >
                列表
              </button>
              <button
                className={view === "board" ? "active" : ""}
                onClick={() => setView("board")}
              >
                看板
              </button>
            </div>
          )}
          <select
            aria-label="任务状态筛选"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部状态</option>
            {Object.entries(phaseLabels).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
          <div className="inline-search">
            <Search size={14} />
            <input
              aria-label="搜索任务"
              placeholder="搜索工作…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          </div>
        </div>
        <Button primary onClick={() => setNewTask(true)}>
          <Plus size={15} />
          委派工作
        </Button>
      </div>
      {collection === "work" &&
        (view === "list" ? (
          <Card>
            <div className="table-wrap">
              <table className="tasks-table">
                <thead>
                  <tr>
                    <th>工作与目标</th>
                    <th>Agent</th>
                    <th>状态</th>
                    <th>发起人</th>
                    <th>持续时间</th>
                    <th>当前进展</th>
                  </tr>
                </thead>
                <tbody>
                  {tasks.map((t) => (
                    <tr
                      key={t.id}
                      className="clickable"
                      onClick={() => openTask(t.id)}
                    >
                      <td>
                        <div className="task-title">
                          <span className={`task-dot ${phaseTone[t.phase]}`} />
                          <div>
                            <b>{t.title}</b>
                            <small>
                              {t.id} · {t.product}
                            </small>
                          </div>
                        </div>
                      </td>
                      <td>
                        {state.agents.find((a) => a.id === t.agentId)?.name}
                        <small>版本 {t.agentVersion}</small>
                      </td>
                      <td>
                        <Badge tone={phaseTone[t.phase]}>
                          {phaseLabels[t.phase]}
                        </Badge>
                      </td>
                      <td>
                        <span className="avatar mini">
                          {t.owner.slice(0, 1)}
                        </span>
                        {t.owner}
                      </td>
                      <td>{t.duration}</td>
                      <td>
                        {t.kind === "long" ? (
                          <>
                            <Progress value={t.progress} />
                            <small>{t.duration} / 72 小时窗口</small>
                          </>
                        ) : (
                          <>
                            <span>{t.step} 个步骤已记录</span>
                            <small>
                              {t.phase === "review"
                                ? "需要指定人员批准"
                                : t.phase === "unknown"
                                  ? "先核对原操作"
                                  : t.phase === "waiting"
                                    ? "等待必要输入"
                                    : "按当前计划继续"}
                            </small>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!tasks.length && (
              <Empty
                title="此筛选下没有工作"
                description="更换状态或委派一项新工作。"
              />
            )}
          </Card>
        ) : (
          <div className="kanban task-kanban">
            {(["queued", "running", "review", "unknown", "done"] as const).map(
              (phase) => (
                <section key={phase}>
                  <div className="kanban-heading">
                    <span className={`task-dot ${phaseTone[phase]}`} />
                    {phaseLabels[phase]}
                    <small>
                      {
                        tasks.filter(
                          (t) =>
                            t.phase === phase ||
                            (phase === "review" && t.phase === "waiting"),
                        ).length
                      }
                    </small>
                  </div>
                  {tasks
                    .filter(
                      (t) =>
                        t.phase === phase ||
                        (phase === "review" && t.phase === "waiting"),
                    )
                    .map((t) => (
                      <button
                        className="kanban-card"
                        key={t.id}
                        onClick={() => openTask(t.id)}
                      >
                        <small>{t.id}</small>
                        <h4>{t.title}</h4>
                        <p>
                          {state.agents.find((a) => a.id === t.agentId)?.name} ·{" "}
                          {t.agentVersion}
                        </p>
                        {t.kind === "long" && <Progress value={t.progress} />}
                        <div>
                          <span className="avatar mini">{t.owner[0]}</span>
                          <span>{t.duration}</span>
                        </div>
                      </button>
                    ))}
                </section>
              ),
            )}
          </div>
        ))}
      {collection === "runs" && (
        <Card>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>运行与工作</th>
                  <th>Agent 版本</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>执行节点</th>
                  <th>输入</th>
                </tr>
              </thead>
              <tbody>
                {state.runs
                  .filter((r) => tasks.some((t) => t.id === r.taskId))
                  .map((r) => (
                    <tr
                      key={r.id}
                      className="clickable"
                      onClick={() => openTask(r.taskId)}
                    >
                      <td>
                        <b>{tasks.find((t) => t.id === r.taskId)?.title}</b>
                        <small>
                          {r.id} · {r.threadId}
                        </small>
                      </td>
                      <td>
                        {state.agents.find((a) => a.id === r.agentId)?.name}
                        <small>{r.agentVersion}</small>
                      </td>
                      <td>{r.trigger}</td>
                      <td>
                        <Badge>
                          {phaseLabels[r.status as keyof typeof phaseLabels] ??
                            (r.status === "superseded"
                              ? "已被新输入替代"
                              : "此前执行中断")}
                        </Badge>
                      </td>
                      <td>{r.worker}</td>
                      <td>input-r{r.inputRevision}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      {collection === "sessions" && (
        <Card title="会话与持续工作">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>会话</th>
                  <th>Agent</th>
                  <th>关联工作</th>
                  <th>运行记录</th>
                  <th>当前状态</th>
                </tr>
              </thead>
              <tbody>
                {tasks.map((t) => (
                  <tr
                    key={t.id}
                    className="clickable"
                    onClick={() => openTask(t.id)}
                  >
                    <td>
                      <b>{t.threadId}</b>
                      <small>Circle / server 会话</small>
                    </td>
                    <td>
                      {state.agents.find((a) => a.id === t.agentId)?.name}
                    </td>
                    <td>
                      {t.title}
                      <small>{t.id}</small>
                    </td>
                    <td>
                      {state.runs.filter((r) => r.taskId === t.id).length}{" "}
                      次尝试
                    </td>
                    <td>
                      <Badge tone={phaseTone[t.phase]}>
                        {phaseLabels[t.phase]}
                      </Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Notice>
        运行任务的看板保存阶段、等待和结果。工程故事与 Sprint
        在“产品交付”中单独管理。
      </Notice>
      {newTask && (
        <Modal
          title="委派工作"
          subtitle="选用已发布的 Agent，描述你想取得的结果"
          onClose={() => setNewTask(false)}
        >
          <label className="field">
            Agent
            <select
              aria-label="委派工作 Agent"
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
            >
              {state.agents
                .filter((a) => a.status === "published")
                .map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name} · {a.version}
                  </option>
                ))}
            </select>
          </label>
          <label className="field">
            你的目标
            <textarea
              autoFocus
              rows={5}
              placeholder="描述你想完成的工作，或补充遇到的问题…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </label>
          <div className="form-row">
            <label className="field">
              项目
              <input
                readOnly
                value={context.project === "lb" ? "负载均衡研发" : "防火墙研发"}
              />
            </label>
            <label className="field">
              环境
              <input
                readOnly
                value={context.environment === "lab" ? "测试域" : "生产域"}
              />
            </label>
          </div>
          <Notice>
            Demo 将保存输入并创建本地工作记录，后续步骤使用合成资料和输出。
          </Notice>
          <div className="dialog-actions">
            <Button onClick={() => setNewTask(false)}>取消</Button>
            <Button
              primary
              onClick={() => {
                const r = act({ type: "createTask", prompt, agentId });
                if (r.ok && r.taskId) {
                  setNewTask(false);
                  openTask(r.taskId);
                }
              }}
            >
              <Send size={14} />
              提交工作
            </Button>
          </div>
        </Modal>
      )}
    </>
  );
}

export function TaskDetail({
  task,
  onBack,
}: {
  task: Task;
  onBack: () => void;
}) {
  const {
    state,
    context,
    act,
    go,
    openScene,
    openEvidence,
    openDocument,
    openAgent,
  } = useDemo();
  const [tab, setTab] = useState("activity");
  const [input, setInput] = useState("");
  const [showInput, setShowInput] = useState(false);
  const completed = task.phase === "done";
  const agent = state.agents.find((a) => a.id === task.agentId);
  if (task.scenarioId && task.workflowState)
    return <ScenarioWork task={task} onBack={onBack} />;
  return (
    <div className="task-detail">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={14} />
        返回任务列表
      </button>
      <div className="detail-title">
        <div>
          <div className="row gap">
            <code>{task.id}</code>
            <Badge tone={phaseTone[task.phase]}>
              {phaseLabels[task.phase]}
            </Badge>
            {task.revoked && <Badge tone="red">委托已撤回</Badge>}
          </div>
          <h2>{task.title}</h2>
          <p>
            {task.product} · {task.owner} · {task.duration}
          </p>
        </div>
        <div className="row gap">
          <Button small onClick={() => setShowInput(true)}>
            <MessageSquare size={14} />
            补充输入
          </Button>
          <Button
            small
            onClick={() => act({ type: "cancel", id: task.id })}
            disabled={["done", "stopped", "stopping"].includes(task.phase)}
          >
            请求停止
          </Button>
          {["unknown", "stopping"].includes(task.phase) ? (
            <Button
              primary
              small
              onClick={() => act({ type: "reconcile", id: task.id })}
            >
              模拟现场核对
            </Button>
          ) : (
            <Button
              small
              primary
              onClick={() => act({ type: "advance", id: task.id })}
              disabled={["done", "stopped"].includes(task.phase)}
            >
              <Play size={13} />
              推进演示
            </Button>
          )}
        </div>
      </div>
      <div className="task-detail-grid">
        <div>
          <div className="task-progress">
            <div>
              <b>{phaseLabels[task.phase]}</b>
              <span>
                {task.kind === "long"
                  ? `${task.duration} / 72 小时窗口`
                  : `${task.step} 个步骤已记录 · ${task.notes.at(-1) ?? "等待执行"}`}
              </span>
            </div>
            {task.kind === "long" && <Progress value={task.progress} />}
          </div>
          <Tabs
            tabs={[
              { id: "activity", label: "交互记录" },
              { id: "timeline", label: "步骤与决定" },
              { id: "runs", label: "运行记录" },
              { id: "evidence", label: "证据", count: task.evidence.length },
              { id: "delivery", label: "交付与未知" },
              { id: "history", label: "事件" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {tab === "activity" && (
            <>
              <Card>
                <div className="work-activity">
                  <div className="work-activity-message">
                    <span className="avatar">{task.owner[0]}</span>
                    <div>
                      <div className="message-author">
                        {task.owner}
                        <small>发起工作</small>
                      </div>
                      <p>{task.prompt}</p>
                    </div>
                  </div>
                  <div className="work-activity-message">
                    <span className="agent-avatar">
                      <span className="circle-logo" />
                    </span>
                    <div>
                      <div className="message-author">
                        {agent?.name ?? "Agent"}
                        <Badge>版本 {task.agentVersion}</Badge>
                      </div>
                      <p>
                        {task.phase === "queued"
                          ? "工作已记录。我会先核对目标、版本和允许的范围，再使用对应资料和工具。"
                          : task.phase === "unknown"
                            ? "连接中断后，远端结果还没有确认。我保留了原操作身份，没有重复发送命令；先核对现场再继续。"
                            : task.phase === "waiting"
                              ? `需要补充信息才能继续：${task.unknowns[0] ?? "目标与预期依据尚不完整"}。`
                              : task.kind === "long"
                                ? "这项工作按观察窗口持续运行，最近样本与异常记录单独保留。采样由脚本完成，异常再进入分析。"
                                : task.phase === "stopping"
                                  ? "停止请求已记录，正在核对执行端与远端状态。此时不能说实际操作已经停止。"
                                  : task.phase === "done"
                                    ? "报告和依据已保留。未覆盖或未验证的范围仍在结果中，可以逐项查看。"
                                    : "已经保存当前资料和采集样例。确定字段、运行观察和原因候选分别记录；需要变更时会提交具体动作。"}
                      </p>
                      {task.evidence.length > 0 && (
                        <div className="inline-evidence-list">
                          {task.evidence.slice(0, 3).map((id) => (
                            <button key={id} onClick={() => openEvidence(id)}>
                              <FileText size={14} />
                              <span>
                                {
                                  state.artifacts.find((a) => a.id === id)
                                    ?.title
                                }
                              </span>
                              <code>{id}</code>
                              <ChevronRight size={12} />
                            </button>
                          ))}
                        </div>
                      )}
                      <div className="row gap">
                        <button
                          className="text-link"
                          onClick={() => openScene(task.id)}
                        >
                          查看关联现场
                          <ArrowUpRight size={12} />
                        </button>
                        <button
                          className="text-link"
                          onClick={() => setTab("timeline")}
                        >
                          查看步骤与决定
                          <ChevronRight size={12} />
                        </button>
                      </div>
                    </div>
                  </div>
                  <div className="work-updates">
                    {task.notes.slice(-3).map((n, i) => (
                      <div key={i}>
                        <History size={13} />
                        <span>{n}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </Card>
              {task.phase === "review" && (
                <div className="approval-card">
                  <div className="row gap">
                    <ShieldCheck size={19} />
                    <div>
                      <h3>需要批准这次具体变更</h3>
                      <p>LBX-LAB-01 · 测试域 · 调整健康检查间隔</p>
                    </div>
                  </div>
                  <KeyValues
                    items={[
                      {
                        label: "为什么需要人",
                        value: "具体变更按策略由陈昕决定，原授权不自动扩大",
                      },
                      {
                        label: "本次依据",
                        value: `input-r${task.inputRevision} / ${task.snapshot}`,
                      },
                      {
                        label: "影响与继续方式",
                        value: "限于测试设备；批准后继续核对回读和业务现象",
                      },
                    ]}
                  />
                  <div className="row gap">
                    <Button small onClick={() => setTab("evidence")}>
                      先查看依据
                    </Button>
                    <Button
                      small
                      onClick={() => act({ type: "reject", id: task.id })}
                    >
                      不批准
                    </Button>
                    <Button
                      small
                      primary
                      onClick={() => act({ type: "approve", id: task.id })}
                    >
                      批准本次动作
                    </Button>
                  </div>
                  <p className="role-notice">
                    示例审批人可从顶部切换；输入变化后需要重新决定。
                  </p>
                </div>
              )}
              {task.phase === "waiting" && (
                <div className="approval-card">
                  <h3>请补充必要信息</h3>
                  <p className="paragraph">{task.unknowns[0]}</p>
                  <Button small primary onClick={() => setShowInput(true)}>
                    补充信息
                  </Button>
                </div>
              )}
            </>
          )}
          {tab === "runs" && (
            <Card title="同一项工作的执行尝试">
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>运行</th>
                      <th>Agent 版本</th>
                      <th>输入</th>
                      <th>状态</th>
                      <th>来源</th>
                      <th>调试</th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.runs
                      .filter((r) => r.taskId === task.id)
                      .map((r) => {
                        const original =
                          task.inputs?.find(
                            (i) => i.revision === r.inputRevision,
                          )?.text ??
                          (r.inputRevision === task.inputRevision
                            ? task.prompt
                            : undefined);
                        return (
                          <tr key={r.id}>
                            <td>
                              <b>{r.id}</b>
                              <small>
                                {r.threadId} · {r.worker}
                              </small>
                            </td>
                            <td>{r.agentVersion}</td>
                            <td>input-r{r.inputRevision}</td>
                            <td>
                              <Badge>
                                {phaseLabels[
                                  r.status as keyof typeof phaseLabels
                                ] ??
                                  (r.status === "superseded"
                                    ? "被新输入替代"
                                    : "此前中断")}
                              </Badge>
                            </td>
                            <td>{r.trigger}</td>
                            <td>
                              <Button
                                small
                                disabled={!original}
                                onClick={() =>
                                  openAgent(r.agentId, "test", original)
                                }
                              >
                                在隔离测试窗查看
                              </Button>
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
              <p className="card-note">
                测试窗只使用合成样本，不重发设备命令。旧运行的输入修订不覆盖为新修订。
              </p>
            </Card>
          )}
          {tab === "timeline" && (
            <>
              <Card className="no-heading">
                <div className="timeline">
                  {[
                    {
                      letter: "C",
                      title: "明确目标并受理",
                      text: `保存人员、项目、目标和 input-r${task.inputRevision}。`,
                    },
                    {
                      letter: "B",
                      title: "固定资料与证据范围",
                      text: `任务使用 ${task.snapshot}，不会随资料同步静默变化。`,
                    },
                    {
                      letter: "E",
                      title: "选定产品方法",
                      text: `${task.method} ${task.methodVersion}；确定规则与模型判断分别记录。`,
                    },
                    {
                      letter: "D",
                      title: "执行与现场观察",
                      text: `操作 ${task.operation}，执行节点 ${task.worker}。`,
                    },
                    {
                      letter: "C",
                      title: "人员决定与交付检查",
                      text: "核对最新输入、执行效果、依据和未知项。",
                    },
                  ].map((s, i) => (
                    <div
                      className={`timeline-item ${i < task.step ? "finished" : i === task.step ? "current" : ""}`}
                      key={i}
                    >
                      <span className="timeline-marker">
                        {i < task.step ? <Check size={13} /> : s.letter}
                      </span>
                      <div>
                        <h4>
                          {s.title}
                          {i === task.step && (
                            <Badge tone="blue">当前步骤</Badge>
                          )}
                        </h4>
                        <p>{s.text}</p>
                        {i === 2 && task.evidence.length > 0 && (
                          <button
                            className="evidence-link"
                            onClick={() => openEvidence(task.evidence[0])}
                          >
                            <FileText size={13} />
                            查看已登记的原始记录
                            <ChevronRight size={12} />
                          </button>
                        )}
                        {i === 3 && (
                          <button
                            className="evidence-link"
                            onClick={() => openScene(task.id)}
                          >
                            <Terminal size={13} />
                            进入同一执行现场
                            <ChevronRight size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              </Card>
              {task.phase === "review" && (
                <div className="approval-card">
                  <div className="row gap">
                    <ShieldCheck size={20} />
                    <div>
                      <h3>等待具体动作批准</h3>
                      <p>测试域 · LBX-LAB-01 · 将健康检查间隔调整为参考值</p>
                    </div>
                  </div>
                  <KeyValues
                    items={[
                      {
                        label: "输入绑定",
                        value: `${task.id} / input-r${task.inputRevision}`,
                      },
                      {
                        label: "影响范围",
                        value: "单台测试设备，不涉及生产域",
                      },
                      { label: "批准人员", value: "陈昕 · 业务审批" },
                      {
                        label: "失效条件",
                        value: "输入、目标或具体动作发生变化",
                      },
                    ]}
                  />
                  <Button
                    primary
                    small
                    onClick={() => act({ type: "approve", id: task.id })}
                  >
                    <ShieldCheck size={13} />
                    批准本次动作
                  </Button>
                  <span className="muted ml-12">
                    可切换顶部“业务审批”角色体验
                  </span>
                </div>
              )}
              <Notice>
                交互、任务、操作与证据分别有身份。关闭 Circle
                或请求停止都不会抹去原记录。
              </Notice>
            </>
          )}
          {tab === "evidence" && (
            <>
              <Card
                title="已登记证据"
                extra={<Badge>访问范围随原件保留</Badge>}
              >
                {task.evidence.map((id) => {
                  const a = state.artifacts.find((x) => x.id === id);
                  return (
                    a && (
                      <button
                        className="artifact-row"
                        key={id}
                        onClick={() => openEvidence(id)}
                      >
                        <FileText size={18} />
                        <div>
                          <b>{a.title}</b>
                          <p>{a.excerpt}</p>
                          <small>
                            {id} · {a.source}
                          </small>
                        </div>
                        <Classification kind={a.classification} />
                        <ChevronRight size={15} />
                      </button>
                    )
                  );
                })}
                {!task.evidence.length && (
                  <Empty
                    title="尚未取得证据"
                    description="推进演示后，合成输出会作为独立记录登记。"
                  />
                )}
              </Card>
              <Card title="用户原始输入" className="mt-20">
                <pre className="original-input">{task.prompt}</pre>
              </Card>
              <div className="judgment-note">
                <Classification kind="judgment" />
                <div>
                  <b>因果分析候选 · 示例</b>
                  <p>
                    间隔与后端超时设置可能有关，但还需要恢复后的业务观察和回程证据。这个判断不因引用存在而被视为已证实。
                  </p>
                  <small>
                    方法身份 scripted-demo · 真实模型调用 0 ·
                    未进行语义准确率验收
                  </small>
                </div>
              </div>
            </>
          )}
          {tab === "delivery" && (
            <>
              <Card title="交付要求">
                <Checklist
                  items={[
                    { text: "用户目标与当前输入修订明确", done: true },
                    { text: "产品、环境与方法版本已固定", done: true },
                    {
                      text: "原始输出可以打开并核对来源",
                      done: task.evidence.length > 0,
                    },
                    {
                      text: "待批准动作与最新输入绑定",
                      done:
                        task.approvedRevision === task.inputRevision ||
                        completed,
                    },
                    {
                      text: "业务恢复由独立观察证实",
                      done: false,
                      description: "本 demo 没有连接真实设备，不能作此结论",
                    },
                    {
                      text: "未知与未覆盖范围列入报告",
                      done: task.unknowns.length > 0 || completed,
                    },
                  ]}
                />
              </Card>
              <Card title="尚未确认" className="mt-20">
                <div className="unknown-list">
                  {task.unknowns.map((v, i) => (
                    <div key={i}>
                      <AlertTriangle size={15} />
                      {v}
                    </div>
                  ))}
                </div>
              </Card>
              <Notice tone="amber">
                完成演示流程交付的是合成报告，不是现实设备验收。未知项不会被隐藏为绿色状态。
              </Notice>
            </>
          )}
          {tab === "history" && (
            <Card title="这项任务的事件">
              <div className="event-list">
                {state.audit
                  .filter((a) => a.task === task.id)
                  .map((a) => (
                    <div key={a.id}>
                      <code>{a.time}</code>
                      <div>
                        <b>{a.action}</b>
                        <p>{a.detail}</p>
                        <small>
                          {a.actor} · {a.policy} · input-r{a.inputRevision}
                        </small>
                      </div>
                      <Badge tone={a.result === "denied" ? "red" : "neutral"}>
                        {a.result === "denied" ? "拒绝" : "已记录"}
                      </Badge>
                    </div>
                  ))}
              </div>
            </Card>
          )}
        </div>
        <aside className="context-panel">
          <h3>任务上下文</h3>
          <KeyValues
            items={[
              { label: "产品与版本", value: task.product },
              {
                label: "环境",
                value: task.environment === "lab" ? "测试域" : "生产域",
              },
              { label: "输入修订", value: `input-r${task.inputRevision}` },
              { label: "知识快照", value: task.snapshot },
              { label: "方法版本", value: `${task.methodVersion}` },
              { label: "流程版本", value: task.workflow },
              { label: "操作身份", value: task.operation },
              { label: "执行会话", value: task.session || "尚未创建" },
              { label: "执行节点", value: task.worker },
            ]}
          />
          {task.snapshot !== state.stableSnapshot && (
            <Notice tone="amber">
              当前有新快照，任务仍用原版本。
              <button
                className="text-link"
                onClick={() => act({ type: "bindSnapshot", id: task.id })}
              >
                改用新快照并重新检查
              </button>
            </Notice>
          )}
          <div className="context-divider" />
          <h3>引用与观察</h3>
          <button
            className="context-reference"
            onClick={() => openDocument("DOC-101")}
          >
            <BookOpen size={16} />
            <div>
              <b>产品版本说明</b>
              <small>DOC-101 · r18</small>
            </div>
            <ChevronRight size={13} />
          </button>
          <button
            className="context-reference"
            onClick={() => openScene(task.id)}
          >
            <Terminal size={16} />
            <div>
              <b>同一执行现场</b>
              <small>{task.session || task.operation}</small>
            </div>
            <ChevronRight size={13} />
          </button>
          <div className="context-divider" />
          <h3>最近记录</h3>
          {task.notes.slice(-3).map((n, i) => (
            <p className="context-note" key={i}>
              {n}
            </p>
          ))}
        </aside>
      </div>
      {showInput && (
        <Modal
          title="补充任务输入"
          subtitle="保存新修订，旧审批会失效"
          onClose={() => setShowInput(false)}
        >
          <label className="field">
            补充内容
            <textarea
              rows={5}
              autoFocus
              placeholder="添加目标、现象、范围或预期…"
              value={input}
              onChange={(e) => setInput(e.target.value)}
            />
          </label>
          <div className="dialog-actions">
            <Button onClick={() => setShowInput(false)}>取消</Button>
            <Button
              primary
              onClick={() => {
                const r = act({ type: "revise", id: task.id, text: input });
                if (r.ok) {
                  setShowInput(false);
                  setInput("");
                }
              }}
            >
              保存新修订
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
