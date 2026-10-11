import { useState } from "react";
import {
  ArrowRight,
  ArrowUpRight,
  Bot,
  BookOpen,
  ChevronRight,
  FileText,
  Globe,
  Link2,
  MessageSquare,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
  Unplug,
  AlertTriangle,
} from "lucide-react";
import { useDemo } from "./ui-context.tsx";
import {
  permitted,
  visibleTasks,
  roles,
  phaseLabels,
  phaseTone,
} from "./domain.ts";
import {
  Badge,
  Button,
  Empty,
  JsonBlock,
  KeyValues,
  Modal,
  Notice,
  Progress,
  Tabs,
} from "./components.tsx";

export default function CircleView() {
  const {
    state,
    context,
    act,
    openTask,
    openScene,
    openAgent,
    openEvidence,
    openDocument,
  } = useDemo();
  const [prompt, setPrompt] = useState("");
  const [active, setActive] = useState<string | null>("TSK-2084");
  const [agentId, setAgentId] = useState("AGT-001");
  const [side, setSide] = useState("context");
  const [connection, setConnection] = useState(false);
  const [address, setAddress] = useState("https://server.example.test");
  const tasks = visibleTasks(state, context);
  const task = active ? tasks.find((t) => t.id === active) : undefined;
  const agent = state.agents.find((a) => a.id === (task?.agentId ?? agentId));
  const canRespond = permitted(context, task ? "task.respond" : "task.create");
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="这个身份不能查看业务会话"
        description="Circle 使用当前人员和项目范围连接 server。安全和运维人员不会自动获得业务正文。"
      />
    );
  const assistant =
    task?.phase === "unknown"
      ? "连接暂时中断，原操作的结果还没有确认。我没有重复发送命令，会先核对执行端和已有输出。"
      : task?.phase === "waiting"
        ? `还需要补充一个信息：${task.unknowns[0] ?? "请说明目标与预期出处"}。我会把回应保存在这项工作里，再继续。`
        : task?.phase === "review"
          ? "已经保留配置和三个观察点的样例记录。管理页面可达、后端直连可达，但业务入口有差异。调整测试域配置前，需要指定人员批准具体动作。"
          : task?.kind === "long"
            ? "观察窗口正在持续推进，采样由固定脚本完成。异常会保留现场，再进入分析；你断开连接后仍可以回到这项工作。"
            : task?.phase === "done"
              ? "报告和原始记录已保留。结论、判断和未确认内容分别列出，你可以打开对应出处。"
              : "我会先明确目标、产品版本和允许的范围，再使用对应资料和工具。必要信息不足时会提出具体问题。";
  return (
    <div className="circle-workspace">
      <aside className="conversation-sidebar">
        <div className="conversation-brand">
          <span className="circle-logo" />
          <strong>circle</strong>
        </div>
        <Button
          small
          onClick={() => {
            setActive(null);
            setPrompt("");
          }}
        >
          <Plus size={14} />
          新会话
        </Button>
        <label className="circle-agent-picker">
          使用 Agent
          <select
            aria-label="Circle Agent"
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setActive(null);
            }}
          >
            {state.agents
              .filter((a) => a.status === "published")
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
          </select>
        </label>
        <div className="session-label">当前项目的工作</div>
        {tasks.map((t) => (
          <button
            className={`conversation-item ${t.id === task?.id ? "active" : ""}`}
            key={t.id}
            onClick={() => {
              setActive(t.id);
              setAgentId(t.agentId ?? "AGT-001");
            }}
          >
            <MessageSquare size={14} />
            <div>
              <b>{t.title}</b>
              <small>
                {state.agents.find((a) => a.id === t.agentId)?.name}
              </small>
            </div>
          </button>
        ))}
        <div className="conversation-connection">
          <Badge tone={state.connected ? "green" : "amber"}>
            {state.connected ? "已连接演示 server" : "连接已断开"}
          </Badge>
          <button
            className="text-link"
            onClick={() =>
              act({ type: state.connected ? "disconnect" : "reconnect" })
            }
          >
            {state.connected ? "模拟断开连接" : "重连同一组工作"}
          </button>
          <button className="text-link" onClick={() => setConnection(true)}>
            <Settings2 size={11} />
            连接设置
          </button>
        </div>
      </aside>
      <section className="conversation-main">
        <div className="conversation-header">
          <div>
            <b>{task?.title ?? agent?.name ?? "新会话"}</b>
            <p>
              {agent?.name} · {task?.agentVersion ?? agent?.version} ·{" "}
              {context.environment === "lab" ? "测试域" : "生产域"}
            </p>
          </div>
          {task ? (
            <Button small onClick={() => openTask(task.id)}>
              工作详情
              <ArrowUpRight size={13} />
            </Button>
          ) : (
            <Button small onClick={() => agent && openAgent(agent.id)}>
              Agent 配置
              <ArrowUpRight size={13} />
            </Button>
          )}
        </div>
        {!state.connected && (
          <Notice tone="amber">
            Circle
            连接已断开，工作记录没有被取消。重连后可取回原工作、运行和证据。
          </Notice>
        )}
        <div className="messages">
          {task ? (
            <>
              <div className="message user-message">
                <span className="avatar">{task.owner[0]}</span>
                <div>
                  <div className="message-author">
                    {task.owner}
                    <small>{task.createdAt}</small>
                  </div>
                  <p>{task.inputs?.[0]?.text ?? task.prompt}</p>
                </div>
              </div>
              <div className="message assistant-message">
                <span className="agent-avatar">
                  <span className="circle-logo" />
                </span>
                <div>
                  <div className="message-author">
                    {agent?.name}
                    <Badge>示例记录</Badge>
                  </div>
                  <p>{assistant}</p>
                  <div className="inline-task">
                    <div className="row gap">
                      <InboxGlyph />
                      <b>{task.title}</b>
                      <Badge tone={phaseTone[task.phase]}>
                        {phaseLabels[task.phase]}
                      </Badge>
                    </div>
                    <p>
                      {task.id} · Agent {task.agentVersion} ·{" "}
                      {task.kind === "long"
                        ? task.duration
                        : `${task.step} 个步骤已记录`}
                    </p>
                    {task.kind === "long" && <Progress value={task.progress} />}
                    <button
                      className="text-link"
                      onClick={() => openTask(task.id)}
                    >
                      跟进这项工作
                      <ChevronRight size={13} />
                    </button>
                  </div>
                  {task.evidence.length > 0 && (
                    <div className="tool-result">
                      <div>
                        <Terminal size={14} />
                        <b>
                          {
                            state.artifacts.find(
                              (a) => a.id === task.evidence[0],
                            )?.title
                          }
                        </b>
                        <Badge>输入输出样例</Badge>
                      </div>
                      <pre>
                        {
                          state.artifacts.find((a) => a.id === task.evidence[0])
                            ?.output
                        }
                      </pre>
                      <button
                        className="text-link"
                        onClick={() => openEvidence(task.evidence[0])}
                      >
                        打开完整记录与来源
                        <ArrowUpRight size={12} />
                      </button>
                    </div>
                  )}
                  {task.unknowns.length > 0 && (
                    <div className="conversation-unknown">
                      <small>还没有确认</small>
                      {task.unknowns.map((u, i) => (
                        <p key={i}>
                          <AlertTriangle size={12} />
                          {u}
                        </p>
                      ))}
                    </div>
                  )}
                  <div className="conversation-follow-actions">
                    <button
                      className="text-link"
                      onClick={() => openScene(task.id)}
                    >
                      <Terminal size={13} />
                      查看同一执行现场
                    </button>
                    <button
                      className="text-link"
                      onClick={() => openDocument("DOC-101")}
                    >
                      <BookOpen size={13} />
                      相关产品资料
                    </button>
                  </div>
                </div>
              </div>
              {task.inputs?.slice(1).map((input, i) => (
                <div className="message user-message" key={input.revision}>
                  <span className="avatar">{input.actor[0]}</span>
                  <div>
                    <div className="message-author">
                      {input.actor}
                      <small>
                        {input.createdAt} · input-r{input.revision}
                      </small>
                    </div>
                    <p>
                      {input.text
                        .slice(task.inputs?.[i]?.text.length ?? 0)
                        .replace(/^\s*补充：/, "")}
                    </p>
                  </div>
                </div>
              ))}
              {task.phase === "review" && (
                <div className="conversation-approval">
                  <ShieldCheck size={18} />
                  <div>
                    <b>请批准这次具体变更</b>
                    <p>由陈昕决定 · 绑定当前输入、目标与测试域动作</p>
                  </div>
                  <Button small onClick={() => openTask(task.id)}>
                    查看请求
                  </Button>
                </div>
              )}
            </>
          ) : (
            <div className="conversation-welcome">
              <span className="circle-logo" />
              <h2>把一项工作交给 Agent</h2>
              <p>{agent?.description}</p>
              <label className="conversation-agent-select">
                Agent
                <select
                  aria-label="新会话 Agent"
                  value={agentId}
                  onChange={(e) => setAgentId(e.target.value)}
                >
                  {state.agents
                    .filter((a) => a.status === "published")
                    .map((a) => (
                      <option value={a.id} key={a.id}>
                        {a.name} · {a.version}
                      </option>
                    ))}
                </select>
              </label>
              <p className="muted">当前项目与环境由连接身份限定</p>
            </div>
          )}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (task) {
              const r = act({ type: "revise", id: task.id, text: prompt });
              if (r.ok) setPrompt("");
            } else {
              const r = act({ type: "createTask", prompt, agentId });
              if (r.ok && r.taskId) {
                setActive(r.taskId);
                setPrompt("");
              }
            }
          }}
        >
          <textarea
            aria-label="Circle 消息输入"
            placeholder={
              canRespond
                ? "描述你的目标，或补充这项工作的上下文…"
                : "当前身份只能观察这项工作"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!state.connected || !canRespond}
          />
          <div className="composer-bottom">
            <span>
              <Link2 size={13} />
              {agent?.name ?? "选择 Agent"}
            </span>
            <span>{task ? "在同一工作中继续" : "使用当前发布版本"}</span>
            <button
              type="submit"
              aria-label="发送消息"
              disabled={!prompt.trim() || !state.connected || !canRespond}
            >
              <ArrowUpRight size={17} />
            </button>
          </div>
        </form>
      </section>
      <aside className="circle-context">
        <Tabs
          tabs={[
            { id: "context", label: "上下文" },
            { id: "scene", label: "执行现场" },
          ]}
          value={side}
          onChange={setSide}
        />
        {side === "context" ? (
          <>
            <div className="circle-panel-section">
              <small>当前工作</small>
              <h3>{task?.title ?? "尚未委派"}</h3>
              <KeyValues
                items={[
                  { label: "执行 Agent", value: agent?.name },
                  {
                    label: "发布版本",
                    value: task?.agentVersion ?? agent?.version,
                  },
                  { label: "产品范围", value: task?.product ?? agent?.product },
                  {
                    label: "资料版本",
                    value: task?.snapshot ?? state.stableSnapshot,
                  },
                ]}
              />
            </div>
            <div className="circle-panel-section">
              <small>资料与证据</small>
              {task?.evidence.map((id) => (
                <button
                  className="context-reference"
                  key={id}
                  onClick={() => openEvidence(id)}
                >
                  <FileText size={15} />
                  <div>
                    <b>{state.artifacts.find((a) => a.id === id)?.title}</b>
                    <small>{id}</small>
                  </div>
                </button>
              ))}
              {!task?.evidence.length && (
                <p className="context-note">
                  运行后取得的原始记录会在这里关联。
                </p>
              )}
            </div>
            <div className="circle-panel-section">
              <small>人员参与</small>
              <p className="context-note">
                需要具体动作批准、补充资料或接管时，在同一项工作中发出请求并保存回应。
              </p>
            </div>
          </>
        ) : task ? (
          <>
            <div className="mini-terminal">
              <div>
                <Terminal size={13} />
                {task.session || "尚未建立"}
                <Badge>同一会话</Badge>
              </div>
              <pre>
                {state.artifacts.find((a) => a.id === task.evidence[0])
                  ?.output ?? "[尚无输出样例]"}
              </pre>
            </div>
            <div className="browser-preview">
              <div>
                <Globe size={13} />
                关联操作 {task.operation}
              </div>
              <section>
                <span>产品页面与终端由执行服务持有</span>
                <h4>{task.worker}</h4>
                <div>
                  <i className="status-dot" />
                  查看与控制分别授权
                </div>
              </section>
            </div>
            <Button small onClick={() => openScene(task.id)}>
              展开终端与 Web 现场
              <ArrowUpRight size={13} />
            </Button>
          </>
        ) : (
          <Empty
            title="尚无执行现场"
            description="委派工作后再关联目标和实际操作。"
          />
        )}
      </aside>
      {connection && (
        <Modal
          title="连接 Circle Server"
          subtitle="默认连接插件的配置演示"
          onClose={() => setConnection(false)}
        >
          <label className="field">
            服务端地址
            <input
              aria-label="演示 Server 地址"
              value={address}
              onChange={(e) => setAddress(e.target.value)}
            />
            <small>这里只展示配置，不访问填写的地址或接收口令。</small>
          </label>
          <KeyValues
            items={[
              { label: "登录身份", value: "公司身份来源，由 server 校验" },
              { label: "项目与环境", value: "选择当前身份有权访问的范围" },
              { label: "能力协商", value: "客户端 / 插件 / API 版本与能力" },
              { label: "凭据", value: "受控存储引用，不写入提示词和 Git" },
            ]}
          />
          <div className="dialog-actions">
            <Button onClick={() => setConnection(false)}>关闭</Button>
            <Button
              primary
              onClick={() => {
                act({ type: "reconnect" });
                setConnection(false);
              }}
            >
              演示重新连接
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
function InboxGlyph() {
  return <WorkflowIcon />;
}
function WorkflowIcon() {
  return <Bot size={16} />;
}
