import { useEffect, useRef, useState } from "react";
import {
  ArrowUpRight,
  FileText,
  MessageSquare,
  Paperclip,
  Plus,
  Send,
  Settings2,
  ShieldCheck,
  Terminal,
  X,
} from "lucide-react";
import { useDemo } from "./ui-context.tsx";
import { permitted, visibleTasks } from "./domain.ts";
import { Badge, Button, Empty, Modal, Notice } from "./components.tsx";
import {
  chooseDemoScenario,
  scenarioById,
  workflowFor,
  type Material,
} from "./workflows.ts";
import ConversationArtifact from "./ConversationArtifact.tsx";

export default function CircleView() {
  const {
    state,
    context,
    act,
    go,
    openTask,
    openScene,
    notify,
    scenarioSelection,
  } = useDemo();
  const [active, setActive] = useState<string | null>(null);
  const [prompt, setPrompt] = useState("");
  const [materials, setMaterials] = useState<Material[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [connection, setConnection] = useState(false);
  const [address, setAddress] = useState("https://server.example.test");
  const [dialogue, setDialogue] = useState<{ user: string; reply: string }[]>(
    [],
  );
  const input = useRef<HTMLTextAreaElement>(null);
  const tasks = visibleTasks(state, context);
  const task = tasks.find((t) => t.id === active);
  const scenario = task ? workflowFor(task) : undefined;
  const canRespond = permitted(context, task ? "task.respond" : "task.create");
  const continueWork = (id: string) => {
    for (let i = 0; i < 6; i++) {
      const r = act({ type: "advance", id });
      if (!r.ok) break;
      const current = r.state.tasks.find((t) => t.id === id)!;
      if (
        ["done", "waiting", "review", "unknown", "stopping"].includes(
          current.phase,
        ) ||
        (current.scenarioId === "outline" && current.step === 3)
      )
        break;
    }
  };
  const example = (id: "review" | "outline") => {
    const s = scenarioById(id)!;
    setActive(null);
    setExpanded(false);
    setPrompt(s.prompt);
    setMaterials(structuredClone(s.materials));
    input.current?.focus();
  };
  useEffect(() => {
    if (!scenarioSelection) return;
    const s = scenarioById(scenarioSelection.id)!;
    setActive(null);
    setPrompt(s.prompt);
    setMaterials(structuredClone(s.materials));
    setExpanded(false);
  }, [scenarioSelection]);
  if (!permitted(context, "business.read"))
    return (
      <Empty
        locked
        title="这个身份不能查看业务会话"
        description="平台维护和安全管理有自己的授权范围."
      >
        <Button onClick={() => go("agents")}>打开服务端管理</Button>
      </Empty>
    );
  const needsMaterial =
    task &&
    [
      "review",
      "outline",
      "compile",
      "requirements",
      "design",
      "development",
      "repair",
    ].includes(task.scenarioId ?? "") &&
    !task.workflowState?.materials.length;
  const assistant = needsMaterial
    ? "请把要处理的材料附上。我会保留原件，再给你可以逐项检查的结果。"
    : task?.phase === "waiting" && scenario?.id === "review"
      ? "我整理了两条需要讨论的意见。原文、依据和建议一起放在旁边，你可以逐条采用或继续讨论。"
      : task?.phase === "waiting"
        ? (task.unknowns[0] ?? "还有一个条件需要你补充。")
        : task?.phase === "review"
          ? "下一步涉及具体操作，需要指定人员决定：" +
            (scenario?.approval?.title ?? "这次变更") +
            "。"
          : scenario?.id === "review"
            ? task?.workflowState?.appliedRevision
              ? "这轮修改已经保留。原用例、你的意见和新修订可以一起查看，缺少的产品判据仍待确认。"
              : "我整理了两条需要讨论的意见，分别标到原用例的位置。你可以逐条采用，也可以继续和我讨论。"
            : scenario?.id === "outline"
              ? task?.workflowState?.artifactReceipt
                ? "Excel 已生成并读回检查，可以下载了。原脑图和未映射元素随结果保留。"
                : "我把原节点和 Excel 行对应起来了。先看看预览，确认后就可以生成工作簿。"
              : task?.phase === "done"
                ? "结果和依据已经保留。你可以展开查看，或继续补充修改要求。"
                : "我会按当前产品、资料和允许的范围继续；需要你决定的地方会在这段会话里提出。";
  const attach = async (file: File) => {
    if (file.size > 200000) {
      notify("演示最多处理 200 KB 文本材料。", true);
      return;
    }
    if (!/\.(json|txt|md|csv)$/i.test(file.name)) {
      notify("这个演示尚未接入该文件格式；请使用文本或主题树 JSON。", true);
      return;
    }
    const material: Material = {
      name: file.name,
      text: await file.text(),
      origin: "local",
    };
    if (task) {
      const r = act({ type: "attachMaterial", id: task.id, material });
      if (r.ok) {
        continueWork(task.id);
        setExpanded(true);
      }
    } else setMaterials((previous) => [material, ...previous.slice(1)]);
  };
  return (
    <div
      className={
        "circle-workspace conversation-first " +
        (expanded && task?.workflowState ? "with-artifact" : "")
      }
    >
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
            setMaterials([]);
            setExpanded(false);
            setDialogue([]);
          }}
        >
          <Plus size={14} />
          新会话
        </Button>
        <div className="session-label">最近的会话</div>
        {tasks.map((t) => (
          <button
            className={"conversation-item " + (t.id === active ? "active" : "")}
            key={t.id}
            onClick={() => {
              setActive(t.id);
              setExpanded(false);
              setPrompt("");
              setMaterials([]);
            }}
          >
            <MessageSquare size={14} />
            <div>
              <b>{t.title}</b>
              <small>
                {t.phase === "done"
                  ? "结果已保留"
                  : t.phase === "waiting"
                    ? "等你补充"
                    : t.phase === "review"
                      ? "等待决定"
                      : "继续这项工作"}
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
            <Settings2 size={12} />
            连接设置
          </button>
          <button className="text-link" onClick={() => go("agents")}>
            团队管理 <ArrowUpRight size={12} />
          </button>
        </div>
      </aside>
      <section className="conversation-main">
        <div className="conversation-header">
          <div>
            <b>{task?.title ?? "新会话"}</b>
            <p>
              {context.project === "lb" ? "负载均衡研发" : "防火墙研发"} ·{" "}
              {context.environment === "lab" ? "测试域" : "生产域"}
            </p>
          </div>
          <div className="row gap">
            {task && (
              <button className="text-link" onClick={() => openTask(task.id)}>
                查看记录 <ArrowUpRight size={12} />
              </button>
            )}
            <button
              className="text-link"
              aria-label="会话设置"
              onClick={() => setConnection(true)}
            >
              <Settings2 size={15} />
            </button>
          </div>
        </div>
        {!state.connected && (
          <Notice tone="amber">
            连接暂时断开，工作和原件仍保留。重连后可以继续。
          </Notice>
        )}
        <div className="messages">
          {dialogue.map((m, i) => (
            <div className="plain-dialogue" key={i}>
              <div className="message user-message">
                <span className="avatar">我</span>
                <div>
                  <p>{m.user}</p>
                </div>
              </div>
              <div className="message assistant-message">
                <span className="agent-avatar">
                  <span className="circle-logo" />
                </span>
                <div>
                  <p>{m.reply}</p>
                </div>
              </div>
            </div>
          ))}
          {!task ? (
            <div className="conversation-welcome">
              <span className="circle-logo" />
              <h2>说说你想完成什么</h2>
              <p>附上材料，把目标交给我。需要哪些条件，我会在对话里问。</p>
              <div className="conversation-examples">
                <span>试用一段会话</span>
                <button onClick={() => example("review")}>
                  评审这份测试用例
                </button>
                <button onClick={() => example("outline")}>
                  把这份脑图整理成 Excel
                </button>
              </div>
            </div>
          ) : (
            <>
              <div className="message user-message">
                <span className="avatar">{task.owner[0]}</span>
                <div>
                  <div className="message-author">{task.owner}</div>
                  <p>{task.inputs?.[0]?.text ?? task.prompt}</p>
                  {task.workflowState?.materials.map((m, i) => (
                    <button
                      className="message-file"
                      key={i}
                      onClick={() => setExpanded(true)}
                    >
                      <FileText size={14} />
                      {m.name}
                    </button>
                  ))}
                </div>
              </div>
              {task.inputs?.slice(1).map((m, i) => (
                <div className="message user-message" key={m.revision}>
                  <span className="avatar">{m.actor[0]}</span>
                  <div>
                    <div className="message-author">{m.actor}</div>
                    <p>
                      {m.text
                        .slice(task.inputs?.[i]?.text.length ?? 0)
                        .replace(/^\s*补充：/, "")}
                    </p>
                  </div>
                </div>
              ))}
              <div className="message assistant-message">
                <span className="agent-avatar">
                  <span className="circle-logo" />
                </span>
                <div>
                  <div className="message-author">
                    Circle<small>合成对话演示</small>
                  </div>
                  <p>{assistant}</p>
                  {!needsMaterial && task.workflowState && (
                    <button
                      className="conversation-result"
                      onClick={() => setExpanded(true)}
                    >
                      <span>
                        <FileText size={19} />
                      </span>
                      <div>
                        <b>
                          {scenario?.id === "review"
                            ? "用例评审意见"
                            : scenario?.id === "outline"
                              ? "脑图与 Excel 预览"
                              : (scenario?.title ?? "这项工作") +
                                " · 结果与依据"}
                        </b>
                        <small>
                          {scenario?.id === "review"
                            ? "原文位置、意见和修改一起查看"
                            : scenario?.id === "outline"
                              ? "原节点对应关系 · 结构工作簿"
                              : "在这段会话中继续处理"}
                        </small>
                      </div>
                      <ArrowUpRight size={14} />
                    </button>
                  )}
                  {task.phase === "review" && scenario?.approval && (
                    <div className="chat-approval">
                      <ShieldCheck size={16} />
                      <div>
                        <b>{scenario.approval.title}</b>
                        <p>{scenario.approval.scope}</p>
                        <div className="row gap">
                          <Button
                            small
                            disabled={!permitted(context, "task.approve")}
                            onClick={() => {
                              const r = act({ type: "approve", id: task.id });
                              if (
                                r.ok &&
                                r.state.tasks.find((t) => t.id === task.id)
                                  ?.phase !== "done"
                              )
                                continueWork(task.id);
                            }}
                          >
                            批准并继续
                          </Button>
                          <Button
                            small
                            disabled={!permitted(context, "task.approve")}
                            onClick={() => act({ type: "reject", id: task.id })}
                          >
                            不批准
                          </Button>
                        </div>
                        <small>
                          由业务审批人员决定；目标或输入变化后需要重新决定。
                        </small>
                      </div>
                    </div>
                  )}
                  {task.session && (
                    <button
                      className="text-link"
                      onClick={() => openScene(task.id)}
                    >
                      <Terminal size={13} />
                      查看同一执行现场
                    </button>
                  )}
                </div>
              </div>
            </>
          )}
        </div>
        <form
          className="composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (task) {
              const r = act({ type: "revise", id: task.id, text: prompt });
              if (r.ok) {
                setPrompt("");
                continueWork(task.id);
              }
            } else {
              const chosen = chooseDemoScenario(prompt);
              if (!chosen) {
                setDialogue((previous) => [
                  ...previous,
                  {
                    user: prompt,
                    reply:
                      "可以先说说当前遇到的问题，或把要处理的材料附上。我会在这段会话里继续。",
                  },
                ]);
                setPrompt("");
                return;
              }
              const needs = [
                "review",
                "outline",
                "compile",
                "requirements",
                "design",
                "development",
                "repair",
              ].includes(chosen.id);
              const r = act({
                type: "createTask",
                prompt,
                agentId: chosen.agentId,
                scenarioId: chosen.id,
                materials: materials.length
                  ? materials
                  : needs
                    ? []
                    : undefined,
              });
              if (r.ok && r.taskId) {
                setActive(r.taskId);
                setPrompt("");
                setMaterials([]);
                if (!needs || materials.length) continueWork(r.taskId);
              }
            }
          }}
        >
          {!!materials.length && (
            <div className="composer-materials">
              {materials.map((m, i) => (
                <span key={i}>
                  <FileText size={12} />
                  {m.name}
                  <button
                    type="button"
                    aria-label={"移除 " + m.name}
                    onClick={() =>
                      setMaterials(materials.filter((_, j) => j !== i))
                    }
                  >
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <textarea
            ref={input}
            aria-label="Circle 消息输入"
            placeholder={
              task
                ? "继续讨论，补充条件或提出修改…"
                : "你想完成什么？可以先附上材料…"
            }
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!canRespond || !state.connected}
          />
          <div className="composer-bottom">
            <label className="composer-attach">
              <Paperclip size={15} />
              <span>附材料</span>
              <input
                type="file"
                aria-label="Circle 附加材料"
                accept=".json,.txt,.md,.csv"
                disabled={!canRespond}
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (file) await attach(file);
                  e.target.value = "";
                }}
              />
            </label>
            <span className="composer-hint">
              {task ? "在同一段会话里继续" : "使用当前项目获准的资料与工具"}
            </span>
            <button
              type="submit"
              aria-label="发送消息"
              disabled={!prompt.trim() || !canRespond || !state.connected}
            >
              <Send size={15} />
            </button>
          </div>
        </form>
        <p className="conversation-demo-note">
          输入留在当前浏览器。模型、设备和代码操作用合成样例演示。
        </p>
      </section>
      {expanded && task?.workflowState && (
        <ConversationArtifact
          task={task}
          continueWork={continueWork}
          onClose={() => setExpanded(false)}
        />
      )}
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
          <Notice>
            正式连接使用公司身份和获准项目，使用平台不以 OpenAI 账号为前提。
          </Notice>
          <div className="dialog-actions">
            <Button onClick={() => setConnection(false)}>关闭</Button>
            <Button
              primary
              onClick={() => {
                act({ type: "reconnect" });
                setConnection(false);
              }}
            >
              保存演示配置
            </Button>
          </div>
        </Modal>
      )}
    </div>
  );
}
