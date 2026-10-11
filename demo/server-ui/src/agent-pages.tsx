import { useEffect, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Bot,
  BookOpen,
  CheckCircle2,
  ChevronRight,
  Code2,
  FlaskConical,
  GitBranch,
  Inbox,
  Layers,
  LockKeyhole,
  MessageSquare,
  MoreHorizontal,
  Play,
  Plus,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
  Users,
  Workflow,
  AlertTriangle,
} from "lucide-react";
import { useDemo } from "./ui-context.tsx";
import {
  permitted,
  roles,
  visibleTasks,
  phaseLabels,
  phaseTone,
  type AgentDefinition,
} from "./domain.ts";
import {
  Badge,
  Button,
  Card,
  Checklist,
  Empty,
  JsonBlock,
  KeyValues,
  Modal,
  Notice,
  SectionLink,
  Tabs,
} from "./components.tsx";

export function AgentsPage() {
  const {
    state,
    context,
    act,
    go,
    openTask,
    openDocument,
    openAgent,
    agentSelection,
    notify,
  } = useDemo();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("all");
  const [add, setAdd] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [tab, setTab] = useState("overview");
  const [draft, setDraft] = useState("");
  const [testInput, setTestInput] = useState(
    "昨晚发布后，测试环境里的支付网关出现间歇性 TLS 失败。先做只读调查，给我原因和证据。",
  );
  const [node, setNode] = useState(0);
  const [tested, setTested] = useState(false);
  const agent = state.agents.find((a) => a.id === agentSelection?.id);
  const tasks = visibleTasks(state, context);
  useEffect(() => {
    if (agentSelection) {
      setTab(agentSelection.tab || "overview");
      setTested(false);
      if (agentSelection.input) setTestInput(agentSelection.input);
    }
  }, [agentSelection?.id, agentSelection?.tab, agentSelection?.input]);
  useEffect(() => {
    if (agent) setDraft(agent.draftInstructions);
  }, [agent?.id, agent?.draftRevision]);
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="这个账号不能查看 Agent 配置"
        description="Agent 的业务配置和运行内容按项目授权。你可以切换示例身份，或进入获准的管理页面。"
      >
        <Button small onClick={() => go("access")}>
          查看当前权限
        </Button>
      </Empty>
    );
  const canEdit = permitted(context, "method.edit");
  const testNodes = [
    {
      name: "确定目标与范围",
      kind: "检查",
      duration: "12 ms",
      description: "使用当前项目与测试域，不接受输入中自报的管理员身份。",
      input: {
        request: testInput,
        project: "lb",
        environment: "lab",
        role: roles[context.role].label,
      },
      output: {
        target: "LBX-LAB-01",
        version: "8.4.2",
        allowedEffects: ["observe", "read-config"],
        source: "demo",
      },
    },
    {
      name: "查找对应版本资料",
      kind: "资料",
      duration: "38 ms",
      description: "使用任务固定的知识快照，并过滤不在授权内的原件。",
      input: {
        snapshot: state.stableSnapshot,
        topic: "TLS / SNI",
        sourcePermissions: "inherited",
      },
      output: {
        documents: ["DOC-104", "DOC-101"],
        revision: "r17",
        source: "demo",
      },
    },
    {
      name: "形成调查计划",
      kind: "分析示例",
      duration: "—",
      description: "客户端、设备、后端的 TLS 分别观察，分析仍保留未知项。",
      input: { product: "LBX 8.4.2", method: "负载均衡业务诊断 2.3.0" },
      output: {
        steps: [
          "检查域名、SNI 与证书",
          "查看设备虚拟服务与路由",
          "核对后端 TLS",
          "比较独立观察",
        ],
        modelCalls: 0,
        source: "scripted-demo",
      },
    },
    {
      name: "调用只读采集工具",
      kind: "工具",
      duration: "124 ms",
      description: "所有输出来自预置样本，未连接实际设备。",
      input: {
        tool: "tls.probe",
        target: "payments.lab.example.test",
        identity: "task-delegation-demo",
      },
      output: {
        clientHandshake: "sample-failure",
        management: "sample-reachable",
        backend: "not-yet-observed",
        deviceOperations: 0,
      },
    },
    {
      name: "整理结果与未决项",
      kind: "结果",
      duration: "—",
      description: "只提交有出处的观察，原因候选和待确认内容分别说明。",
      input: {
        evidence: ["DOC-104", "EV-302"],
        rule: "separate-observation-and-judgment",
      },
      output: {
        finding: "SNI 路由可能与失败有关（预置示例）",
        confirmedCause: false,
        next: "采集两段握手和回程证据",
        unknowns: ["后端握手未采集", "未验证恢复效果"],
      },
    },
  ];
  if (!agent)
    return (
      <>
        <div className="agent-summary-bar">
          <div>
            <span className="summary-number">
              {state.agents.filter((a) => a.status === "published").length}
            </span>
            <span>已发布</span>
          </div>
          <div>
            <span className="summary-number">
              {state.agents.filter((a) => a.status === "draft").length}
            </span>
            <span>草稿</span>
          </div>
          <div>
            <span className="summary-number">
              {
                tasks.filter((t) => !["done", "stopped"].includes(t.phase))
                  .length
              }
            </span>
            <span>在途工作</span>
          </div>
          <span className="summary-explain">
            已发布版本供 Circle 与自动化规则使用
          </span>
        </div>
        <div className="toolbar">
          <div className="row gap">
            <div className="inline-search">
              <Search size={14} />
              <input
                aria-label="搜索 Agent"
                placeholder="搜索 Agent…"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <select
              aria-label="Agent 状态"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            >
              <option value="all">全部状态</option>
              <option value="published">已发布</option>
              <option value="draft">草稿</option>
              <option value="paused">已停用</option>
            </select>
          </div>
          <Button primary onClick={() => setAdd(true)}>
            <Plus size={15} />
            创建 Agent
          </Button>
        </div>
        <Card>
          <div className="table-wrap">
            <table className="agent-table">
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>业务范围</th>
                  <th>发布版本</th>
                  <th>状态</th>
                  <th>负责人</th>
                  <th>当前工作</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {state.agents
                  .filter(
                    (a) =>
                      a.name.includes(query) &&
                      (filter === "all" || a.status === filter),
                  )
                  .map((a) => (
                    <tr
                      key={a.id}
                      className="clickable"
                      onClick={() => openAgent(a.id)}
                    >
                      <td>
                        <div className="agent-identity">
                          <span className="agent-list-icon">
                            <Bot size={21} strokeWidth={1.5} />
                          </span>
                          <div>
                            <b>{a.name}</b>
                            <p>{a.description}</p>
                          </div>
                        </div>
                      </td>
                      <td>{a.product}</td>
                      <td>
                        <code>{a.version}</code>
                      </td>
                      <td>
                        <Badge
                          tone={
                            a.status === "published"
                              ? "green"
                              : a.status === "paused"
                                ? "amber"
                                : "neutral"
                          }
                        >
                          {a.status === "published"
                            ? "已发布"
                            : a.status === "paused"
                              ? "已停用"
                              : "草稿"}
                        </Badge>
                      </td>
                      <td>
                        <span className="avatar mini">{a.owner[0]}</span>
                        {a.owner}
                      </td>
                      <td>
                        {
                          tasks.filter(
                            (t) =>
                              t.agentId === a.id &&
                              !["done", "stopped"].includes(t.phase),
                          ).length
                        }
                        <small>在当前项目内</small>
                      </td>
                      <td>
                        <ChevronRight size={15} />
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
        <div className="agent-entry-strip">
          <MessageSquare size={20} />
          <div>
            <b>用户从 Circle 委派工作</b>
            <p>选择已发布的 Agent，描述目标，再跟进消息、执行现场与结果。</p>
          </div>
          <Button onClick={() => go("circle")}>
            进入 Circle <ArrowUpRight size={13} />
          </Button>
        </div>
        <div className="two-col mt-20">
          <Card
            title="最近运行"
            extra={
              <SectionLink onClick={() => go("tasks")}>全部工作</SectionLink>
            }
          >
            <div className="compact-work-list">
              {tasks.slice(0, 4).map((t) => (
                <button key={t.id} onClick={() => openTask(t.id)}>
                  <div>
                    <b>{t.title}</b>
                    <small>
                      {state.agents.find((a) => a.id === t.agentId)?.name} ·{" "}
                      {t.agentVersion}
                    </small>
                  </div>
                  <Badge tone={phaseTone[t.phase]}>
                    {phaseLabels[t.phase]}
                  </Badge>
                  <ChevronRight size={13} />
                </button>
              ))}
            </div>
          </Card>
          <Card title="发布前的检查">
            <div className="lifecycle-steps">
              <div>
                <span>1</span>
                <b>设置职责、资料和工具</b>
              </div>
              <div>
                <span>2</span>
                <b>试运行并查看调用步骤</b>
              </div>
              <div>
                <span>3</span>
                <b>由指定人员评审当前草稿</b>
              </div>
              <div>
                <span>4</span>
                <b>发布新版本，保留在途工作</b>
              </div>
            </div>
          </Card>
        </div>
        {add && (
          <Modal
            title="创建 Agent"
            subtitle="先说明它为谁解决什么工作，再配置资料、工具和运行范围"
            onClose={() => setAdd(false)}
          >
            <label className="field">
              名称
              <input
                value={name}
                autoFocus
                placeholder="例如网络排障 Agent"
                onChange={(e) => setName(e.target.value)}
              />
            </label>
            <label className="field">
              职责
              <textarea
                rows={5}
                value={description}
                placeholder="它服务哪些人，完成什么工作，遇到不确定内容怎样处理…"
                onChange={(e) => setDescription(e.target.value)}
              />
            </label>
            <div className="dialog-actions">
              <Button onClick={() => setAdd(false)}>取消</Button>
              <Button
                primary
                onClick={() => {
                  const r = act({ type: "createAgent", name, description });
                  if (r.ok) {
                    setAdd(false);
                    openAgent(r.state.agents[0].id, "configuration");
                  }
                }}
              >
                创建草稿
              </Button>
            </div>
          </Modal>
        )}
      </>
    );
  return (
    <>
      <button className="back-link" onClick={() => go("agents")}>
        <ArrowLeft size={14} />
        所有 Agents
      </button>
      <div className="agent-detail-heading">
        <span className="agent-large-icon">
          <Bot size={28} strokeWidth={1.5} />
        </span>
        <div>
          <h2>
            {agent.name}
            <Badge tone={agent.status === "published" ? "green" : "neutral"}>
              {agent.status === "published"
                ? "已发布"
                : agent.status === "paused"
                  ? "已停用"
                  : "草稿"}
            </Badge>
          </h2>
          <p>{agent.description}</p>
          <small>
            {agent.owner} · 当前版本 {agent.version} · 新草稿 {agent.candidate}
          </small>
        </div>
        <div className="row gap">
          <Button
            small
            onClick={() => {
              setTab("test");
              setTested(false);
            }}
          >
            <FlaskConical size={14} />
            试运行
          </Button>
          <Button primary small onClick={() => setTab("versions")}>
            发布新版本
          </Button>
        </div>
      </div>
      <Tabs
        tabs={[
          { id: "overview", label: "概览" },
          { id: "configuration", label: "设置" },
          { id: "resources", label: "知识与工具" },
          { id: "test", label: "测试" },
          { id: "versions", label: "版本与发布" },
          { id: "runs", label: "运行记录" },
        ]}
        value={tab}
        onChange={setTab}
      />
      {tab === "overview" && (
        <div className="agent-overview-grid">
          <div>
            <Card title="职责与工作要求">
              <div className="padded">
                <p className="instructions-readonly">
                  {agent.instructions || agent.draftInstructions}
                </p>
              </div>
            </Card>
            <Card title="这个 Agent 最近的工作" className="mt-20">
              <div className="compact-work-list">
                {tasks
                  .filter((t) => t.agentId === agent.id)
                  .map((t) => (
                    <button key={t.id} onClick={() => openTask(t.id)}>
                      <div>
                        <b>{t.title}</b>
                        <small>
                          {t.threadId} · {t.runId} · Agent {t.agentVersion}
                        </small>
                      </div>
                      <Badge tone={phaseTone[t.phase]}>
                        {phaseLabels[t.phase]}
                      </Badge>
                      <ChevronRight size={13} />
                    </button>
                  ))}
              </div>
            </Card>
          </div>
          <Card title="运行配置">
            <div className="padded">
              <KeyValues
                items={[
                  { label: "业务范围", value: agent.product },
                  { label: "模型配置", value: agent.modelRoute },
                  { label: "工作时限", value: agent.maxDuration },
                  { label: "预算规则", value: agent.budget },
                  {
                    label: "具体变更",
                    value: agent.requiresApproval
                      ? "指定人员批准后执行"
                      : "仅授权只读工作",
                  },
                  {
                    label: "执行范围",
                    value: agent.readonly
                      ? "只读工具"
                      : "按项目、目标、动作与委托检查",
                  },
                  { label: "访问入口", value: "Circle 默认插件 / server 契约" },
                ]}
              />
              <Button small onClick={() => go("circle")}>
                在 Circle 中使用
                <ArrowUpRight size={13} />
              </Button>
            </div>
          </Card>
        </div>
      )}
      {tab === "configuration" && (
        <div className="agent-overview-grid">
          <Card title={`设置草稿 · ${agent.candidate}`}>
            <div className="padded">
              <label className="field">
                职责与工作要求
                <textarea
                  rows={10}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  readOnly={!canEdit}
                />
                <small>修改草稿不会覆盖发布版本或已经受理的工作。</small>
              </label>
              <div className="form-row">
                <label className="field">
                  模型配置
                  <select value={agent.modelRoute} disabled>
                    <option>{agent.modelRoute}</option>
                  </select>
                  <small>模型选择属于演示配置，当前真实调用为 0。</small>
                </label>
                <label className="field">
                  运行范围
                  <input value={agent.product} readOnly />
                </label>
              </div>
              <div className="dialog-actions">
                <Button
                  primary
                  onClick={() =>
                    act({
                      type: "saveAgent",
                      id: agent.id,
                      instructions: draft,
                    })
                  }
                  disabled={!canEdit}
                >
                  保存草稿
                </Button>
              </div>
            </div>
          </Card>
          <Card title="版本会保留什么">
            <div className="padded">
              <ul className="plain-list">
                <li>职责、模型、工具与资料选择</li>
                <li>产品方法和执行环境要求</li>
                <li>具体测试输入与结果</li>
                <li>当前草稿的人员决定</li>
                <li>发布人、版本和所用记录</li>
              </ul>
              <Notice>
                Agent
                配置引用资料、方法和工具。实际访问与操作仍受人员、项目和执行端权限限制。
              </Notice>
            </div>
          </Card>
        </div>
      )}
      {tab === "resources" && (
        <>
          <div className="two-col">
            <Card
              title="公司知识"
              extra={
                <SectionLink onClick={() => go("knowledge")}>
                  管理知识库
                </SectionLink>
              }
            >
              <div className="resource-selection">
                {agent.knowledge.map((id) => {
                  const s = state.sources.find((s) => s.id === id);
                  return (
                    s && (
                      <div key={id}>
                        <BookOpen size={17} />
                        <div>
                          <b>{s.title}</b>
                          <p>
                            {s.type} · {s.acl}
                          </p>
                        </div>
                        <Badge tone="green">{s.revision}</Badge>
                      </div>
                    )
                  );
                })}
              </div>
              <p className="card-note">
                新任务固定知识快照；更新来源不修改旧任务的依据。
              </p>
            </Card>
            <Card title="允许使用的工具">
              <div className="resource-selection">
                {agent.tools.map((t) => (
                  <div key={t}>
                    <Terminal size={16} />
                    <div>
                      <b>{t}</b>
                      <p>
                        {t.includes("变更")
                          ? "按具体动作单独批准"
                          : "按任务委托检查范围"}
                      </p>
                    </div>
                    <Badge tone={t.includes("变更") ? "amber" : "neutral"}>
                      {t.includes("变更") ? "需批准" : "受控"}
                    </Badge>
                  </div>
                ))}
              </div>
              <p className="card-note">
                工具列入配置不等于获得所有目标的操作权限。
              </p>
            </Card>
          </div>
          <Card title="产品方法" className="mt-20">
            <div className="resource-selection">
              {agent.methods.map((id) => {
                const m = state.methods.find((m) => m.id === id);
                return (
                  m && (
                    <div key={id}>
                      <Workflow size={17} />
                      <div>
                        <b>{m.title}</b>
                        <p>{m.product} · 程序规则与分析要求分别记录</p>
                      </div>
                      <Badge>{m.version}</Badge>
                      <Button small onClick={() => go("methods")}>
                        查看
                      </Button>
                    </div>
                  )
                );
              })}
            </div>
          </Card>
        </>
      )}
      {tab === "test" && (
        <>
          <div className="test-environment-bar">
            <FlaskConical size={16} />
            <span>草稿 {agent.candidate} · 当前项目 / 测试域</span>
            <Badge>只使用预置样本</Badge>
            <span className="muted">真实模型与设备调用 0</span>
          </div>
          <div className="test-studio">
            <Card title="对话测试">
              <div className="test-chat">
                <p className="test-context">
                  这里试运行当前草稿，并查看它怎样选择资料和工具。
                </p>
                <label className="field">
                  <textarea
                    aria-label="Agent 测试输入"
                    rows={5}
                    value={testInput}
                    onChange={(e) => setTestInput(e.target.value)}
                  />
                </label>
                <Button
                  primary
                  onClick={() => {
                    const r = act({ type: "evaluateAgent", id: agent.id });
                    if (r.ok) {
                      setTested(true);
                      setNode(0);
                    }
                  }}
                >
                  <Play size={14} />
                  运行测试示例
                </Button>
                {tested && (
                  <div className="test-reply">
                    <div className="message-author">
                      <Bot size={16} />
                      {agent.name}
                      <Badge>预置回复</Badge>
                    </div>
                    <p>
                      先检查客户端到设备的
                      TLS，再核对设备到后端的握手。当前示例提示 SNI
                      路由可能有关，后端和恢复证据还没有取得。
                    </p>
                    <p>
                      我会保留现有配置。若需要变更，会把目标、影响和对应输入交给指定人员决定。
                    </p>
                    <button
                      className="evidence-link"
                      onClick={() => {
                        setNode(1);
                        openDocument("DOC-104");
                      }}
                    >
                      <BookOpen size={13} />
                      查看这条回复使用的资料
                    </button>
                  </div>
                )}
              </div>
            </Card>
            <Card
              title="执行步骤"
              extra={<Badge>{tested ? "5 个预置步骤" : "等待测试"}</Badge>}
            >
              <div className="test-trace">
                {testNodes.map((n, i) => (
                  <button
                    key={n.name}
                    className={`${node === i && tested ? "active" : ""} ${!tested ? "inactive" : ""}`}
                    onClick={() => {
                      if (tested) setNode(i);
                    }}
                  >
                    <span>{tested ? <CheckCircle2 size={15} /> : <i />}</span>
                    <div>
                      <b>{n.name}</b>
                      <small>{n.kind}</small>
                    </div>
                    <code>{tested ? n.duration : "—"}</code>
                    <ChevronRight size={13} />
                  </button>
                ))}
              </div>
              {tested ? (
                <div className="trace-inspector">
                  <h4>{testNodes[node].name}</h4>
                  <p>{testNodes[node].description}</p>
                  <JsonBlock label="输入" value={testNodes[node].input} />
                  <JsonBlock label="输出" value={testNodes[node].output} />
                </div>
              ) : (
                <Empty
                  title="运行后查看每一步"
                  description="点击回答或步骤，能定位资料、参数与工具返回。"
                />
              )}
            </Card>
          </div>
          <Notice>
            测试预览与正式任务验收分开。这里的步骤和回答来自前端样本，不能证明真实模型质量或设备效果。
          </Notice>
        </>
      )}
      {tab === "versions" && (
        <>
          <div className="two-col">
            <Card title={`待发布草稿 ${agent.candidate}`}>
              <Checklist
                items={[
                  {
                    text: "职责、资料与工具配置已保存",
                    done: !!agent.draftInstructions,
                  },
                  {
                    text: "当前草稿有测试记录",
                    done: agent.evaluated,
                    description: "此处展示前端演示记录，生产评测另行执行",
                  },
                  {
                    text: "指定人员已批准当前修订",
                    done:
                      agent.reviewed &&
                      agent.reviewedRevision === agent.draftRevision,
                    description: "草稿修改会使旧决定失效",
                  },
                  { text: "在途工作继续使用原版本", done: true },
                ]}
              />
              <div className="card-actions">
                <Button
                  small
                  onClick={() => {
                    setTab("test");
                  }}
                >
                  查看测试
                </Button>
                <Button
                  small
                  onClick={() => act({ type: "reviewAgent", id: agent.id })}
                >
                  批准当前草稿
                </Button>
                <Button
                  primary
                  small
                  onClick={() => act({ type: "publishAgent", id: agent.id })}
                >
                  发布 {agent.candidate}
                </Button>
              </div>
            </Card>
            <Card title="用户何时使用新版本">
              <div className="padded">
                <p className="paragraph">
                  发布后，新工作使用新版本。已经进行的排障、稳定性测试或待批准动作仍绑定原
                  Agent、方法与资料版本。
                </p>
                <p className="paragraph">
                  停用入口只限制新的工作请求。停止某个在途任务需要进入该任务，核对实际执行状态。
                </p>
                <Button
                  small
                  onClick={() => act({ type: "pauseAgent", id: agent.id })}
                >
                  {agent.status === "paused"
                    ? "启用新工作入口"
                    : "停用新工作入口"}
                </Button>
              </div>
            </Card>
          </div>
          <Card title="版本历史" className="mt-20">
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>版本</th>
                    <th>状态</th>
                    <th>时间</th>
                    <th>变更</th>
                    <th>引用</th>
                  </tr>
                </thead>
                <tbody>
                  {agent.versions.map((v) => (
                    <tr key={v.version}>
                      <td>
                        <b>{v.version}</b>
                      </td>
                      <td>
                        <Badge
                          tone={
                            v.version === agent.version ? "green" : "neutral"
                          }
                        >
                          {v.version === agent.version
                            ? "当前发布"
                            : "历史保留"}
                        </Badge>
                      </td>
                      <td>{v.date}</td>
                      <td>{v.change}</td>
                      <td>配置 · 测试 · 决定</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
      {tab === "runs" && (
        <Card title="该 Agent 的运行">
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>工作与运行</th>
                  <th>Agent 版本</th>
                  <th>来源</th>
                  <th>状态</th>
                  <th>开始</th>
                  <th>输入</th>
                </tr>
              </thead>
              <tbody>
                {state.runs
                  .filter(
                    (r) =>
                      r.agentId === agent.id &&
                      tasks.some((t) => t.id === r.taskId),
                  )
                  .map((r) => (
                    <tr
                      key={r.id}
                      onClick={() => openTask(r.taskId)}
                      className="clickable"
                    >
                      <td>
                        <b>{tasks.find((t) => t.id === r.taskId)?.title}</b>
                        <small>
                          {r.id} · {r.threadId}
                        </small>
                      </td>
                      <td>{r.agentVersion}</td>
                      <td>{r.trigger}</td>
                      <td>
                        <Badge>
                          {phaseLabels[r.status as keyof typeof phaseLabels] ??
                            (r.status === "superseded"
                              ? "已被新输入替代"
                              : "此前执行中断")}
                        </Badge>
                      </td>
                      <td>{r.startedAt}</td>
                      <td>r{r.inputRevision}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

export function InboxPage() {
  const { state, context, act, openTask, openAgent } = useDemo();
  const [tab, setTab] = useState("mine");
  const tasks = visibleTasks(state, context);
  const pending = tasks.filter(
    (t) =>
      t.phase === "review" || t.phase === "waiting" || t.phase === "unknown",
  );
  const mine = pending.filter((t) =>
    context.role === "approver"
      ? t.phase === "review"
      : t.owner === roles[context.role].person && t.phase !== "review",
  );
  const items = tab === "mine" ? mine : pending;
  const agents =
    context.role === "approver"
      ? state.agents.filter((a) => a.evaluated && !a.reviewed)
      : [];
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="这个身份没有业务待办"
        description="人员回应与资料、目标及具体工作绑定。组织维护和平台运维从相应页面发起。"
      />
    );
  return (
    <>
      <Tabs
        tabs={[
          { id: "mine", label: "待我处理", count: mine.length + agents.length },
          { id: "all", label: "项目待办", count: pending.length },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div className="inbox-list">
        {items.map((t) => (
          <Card key={t.id}>
            <div className="inbox-item">
              <div className="row gap">
                <span className={`attention-icon ${phaseTone[t.phase]}`}>
                  {t.phase === "review" ? (
                    <ShieldCheck size={19} />
                  ) : t.phase === "unknown" ? (
                    <AlertTriangle size={19} />
                  ) : (
                    <MessageSquare size={19} />
                  )}
                </span>
                <div>
                  <h3>
                    {t.phase === "review"
                      ? "请批准这次测试域配置变更"
                      : t.phase === "waiting"
                        ? "请补充这项工作的预期依据"
                        : "需要核对远端执行结果"}
                  </h3>
                  <p>
                    {t.title} · {t.id}
                  </p>
                </div>
                <Badge tone={phaseTone[t.phase]}>{phaseLabels[t.phase]}</Badge>
              </div>
              <KeyValues
                items={[
                  {
                    label: "为什么需要你",
                    value:
                      t.phase === "review"
                        ? "这项具体动作按策略需要指定人员批准"
                        : t.unknowns[0],
                  },
                  {
                    label: "当前输入",
                    value: `input-r${t.inputRevision} · ${t.snapshot}`,
                  },
                  {
                    label: "目标与影响",
                    value:
                      t.phase === "review"
                        ? "LBX-LAB-01 · 只调整测试域健康检查间隔"
                        : "当前项目与获准目标，不扩大作用范围",
                  },
                  {
                    label: "回应后",
                    value:
                      t.phase === "review"
                        ? "Agent 按批准的动作继续；输入变化需重新决定"
                        : "在原任务内保存新修订，再继续调查",
                  },
                ]}
              />
              <div className="inbox-actions">
                <Button small onClick={() => openTask(t.id)}>
                  查看上下文与证据
                  <ArrowUpRight size={13} />
                </Button>
                {t.phase === "review" && context.role === "approver" ? (
                  <>
                    <Button
                      small
                      onClick={() => act({ type: "reject", id: t.id })}
                    >
                      不批准，补充方案
                    </Button>
                    <Button
                      small
                      primary
                      onClick={() => act({ type: "approve", id: t.id })}
                    >
                      批准本次动作
                    </Button>
                  </>
                ) : (
                  <Button small primary onClick={() => openTask(t.id)}>
                    {t.phase === "waiting" ? "补充信息" : "进入任务核对"}
                  </Button>
                )}
              </div>
            </div>
          </Card>
        ))}
        {agents.map((a) => (
          <Card key={a.id}>
            <div className="inbox-item">
              <div className="row gap">
                <span className="attention-icon violet">
                  <GitBranch size={19} />
                </span>
                <div>
                  <h3>请评审 Agent 发布草稿</h3>
                  <p>
                    {a.name} · {a.candidate} · 草稿 r{a.draftRevision}
                  </p>
                </div>
                <Badge tone="violet">待评审</Badge>
              </div>
              <p className="paragraph">
                职责、资料与工具配置已形成演示测试记录。批准只绑定当前修订，配置变更后需要重新检查。
              </p>
              <div className="inbox-actions">
                <Button small onClick={() => openAgent(a.id, "test")}>
                  查看配置与测试
                </Button>
                <Button
                  small
                  primary
                  onClick={() => act({ type: "reviewAgent", id: a.id })}
                >
                  批准当前草稿
                </Button>
              </div>
            </div>
          </Card>
        ))}
        {!items.length && !agents.length && (
          <Empty
            title="当前没有需要你回应的事项"
            description="项目中的待处理工作仍可在“项目待办”里查看。不同身份承担不同决定。"
          />
        )}
      </div>
      <Notice>
        人工请求是一份工作记录，保存具体问题、输入版本、目标、人员和决定。回应不会扩大原有设备或资料权限。
      </Notice>
    </>
  );
}
