import {
  ArrowUp,
  ArrowUpRight,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Paperclip,
  Pencil,
  Play,
  Plus,
  Square,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../app/context";
import { Badge, Button, DataBlock, IconButton, Modal } from "../components/ui";
import type { Conversation, Message } from "../platform/types";
import { usePlugins } from "../plugins/context";
import { PluginBoundary } from "../plugins/PluginBoundary";
function ToolMessage({ message }: { message: Message }) {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const tool = message.tool!;
  const { registry, preferences } = usePlugins();
  const recordPath = registry.recordPath(
    preferences.enabledIds,
    tool.owner,
    tool.recordId,
  );
  return (
    <div className={`tool-message ${open ? "expanded" : ""}`}>
      <button
        className="tool-summary"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <span className="tool-check">
          <Check size={13} />
        </span>
        <code>{tool.name}</code>
        <span>{message.text}</span>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
      </button>
      {open && (
        <div className="tool-detail">
          <div className="tool-meta">
            <span>样例调用 · {message.at}</span>
            <button onClick={() => navigate(recordPath ?? "/manage/plugins")}>
              {recordPath ? "打开关联记录" : "查看相关插件"}
              <ArrowUpRight size={12} />
            </button>
          </div>
          <DataBlock title="输入" value={tool.input} />
          <DataBlock title="输出" value={tool.output} />
        </div>
      )}
    </div>
  );
}
export function ConversationView({
  conversation,
  onContext,
}: {
  conversation: Conversation;
  onContext: () => void;
}) {
  const { gateway, platform, perform, notify } = useWorkbench();
  const { registry, preferences } = usePlugins();
  const contextActions = registry.session(
    "contextActions",
    preferences.enabledIds,
    gateway.can,
  );
  const end = useRef<HTMLDivElement>(null);
  const textarea = useRef<HTMLTextAreaElement>(null);
  const [inputOpen, setInputOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [title, setTitle] = useState("");
  const navigate = useNavigate();
  const canSend = gateway.can("conversation");
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [conversation.id, conversation.messages.length]);
  useEffect(() => {
    if (textarea.current) {
      textarea.current.style.height = "auto";
      textarea.current.style.height =
        Math.min(textarea.current.scrollHeight, 170) + "px";
    }
  }, [conversation.draft]);
  const send = () => perform(() => gateway.sendMessage(conversation.id));
  const attach = async () => {
    try {
      for (const file of await platform.pickFiles())
        gateway.attachContext(conversation.id, file);
    } catch (error) {
      notify(error instanceof Error ? error.message : "没有添加文件。");
    }
  };
  return (
    <section className="conversation-view">
      <div className="conversation-header">
        <div>
          <h1>{conversation.title}</h1>
          <span>
            {conversation.workspace}
            <i />
            仅当前项目
          </span>
        </div>
        <div className="conversation-header-actions">
          {conversation.state === "paused" && <Badge>已暂停</Badge>}
          <IconButton
            label="重命名会话"
            onClick={() => {
              setTitle(conversation.title);
              setRenameOpen(true);
            }}
            disabled={!canSend}
          >
            <Pencil size={15} />
          </IconButton>
          <IconButton label="查看当前上下文" onClick={() => setInputOpen(true)}>
            <Braces size={16} />
          </IconButton>
        </div>
      </div>
      <div className="message-scroll">
        <div className="message-column">
          {conversation.messages.length === 0 ? (
            <div className="conversation-empty">
              <span className="empty-agent-mark">i</span>
              <h2>开始一个会话</h2>
              <p>直接说你想做什么，也可以先加入文件或资料。</p>
            </div>
          ) : (
            <>
              <div className="date-divider">
                <span>会话记录</span>
              </div>
              {conversation.messages.map((message) =>
                message.role === "tool" ? (
                  <ToolMessage key={message.id} message={message} />
                ) : (
                  <article
                    key={message.id}
                    className={`message message-${message.role}`}
                  >
                    <div className="message-author">
                      {message.role === "user" ? (
                        <span className="user-avatar">你</span>
                      ) : (
                        <span className="agent-avatar">i</span>
                      )}
                      <strong>
                        {message.role === "user" ? "你" : "Agent"}
                      </strong>
                      <time>{message.at}</time>
                    </div>
                    <div className="message-text">{message.text}</div>
                  </article>
                ),
              )}
            </>
          )}
          {conversation.state === "waiting" && (
            <div className="pending-state">
              <span className="pending-dot" />
              消息已保存在本地，等待 Agent 连接。
              <button onClick={() => navigate("/manage/settings")}>
                查看连接
              </button>
            </div>
          )}
          {conversation.state === "paused" && (
            <div className="pending-state">
              当前会话已暂停，关联执行需另行核对。
            </div>
          )}
          <div
            ref={(node) => {
              end.current = node;
            }}
          />
        </div>
      </div>
      <div className="composer-wrap">
        <div className="composer">
          <textarea
            ref={textarea}
            value={conversation.draft}
            onChange={(e) => gateway.saveDraft(conversation.id, e.target.value)}
            placeholder={canSend ? "发送消息…" : "当前角色只有查看权限"}
            aria-label="消息输入"
            disabled={!canSend}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                send();
              }
            }}
          />
          {conversation.context.filter((c) => c.kind === "file").length > 0 && (
            <div className="attachment-strip">
              {conversation.context
                .filter((c) => c.kind === "file")
                .map((ref) => (
                  <span key={ref.id}>
                    <Paperclip size={11} />
                    {ref.name}
                  </span>
                ))}
            </div>
          )}
          <div className="composer-toolbar">
            <div>
              <IconButton
                label="添加本地文件"
                onClick={attach}
                disabled={!canSend}
              >
                <Plus size={17} />
              </IconButton>
              {contextActions.map(({ plugin, contribution }) => (
                <PluginBoundary key={contribution.id} name={plugin.name}>
                  <contribution.component conversation={conversation} />
                </PluginBoundary>
              ))}
              <button
                className="text-control model-control"
                onClick={() => navigate("/manage/settings")}
              >
                {conversation.model}
                <ChevronDown size={12} />
              </button>
            </div>
            <div>
              <button
                className="text-control capability-control"
                onClick={onContext}
              >
                上下文
              </button>
              {conversation.state === "paused" ? (
                <IconButton
                  label="继续会话"
                  onClick={() =>
                    perform(() =>
                      gateway.setConversationState(conversation.id, "waiting"),
                    )
                  }
                  disabled={!canSend}
                >
                  <Play size={14} />
                </IconButton>
              ) : conversation.state === "waiting" ? (
                <IconButton
                  label="停止会话"
                  onClick={() =>
                    perform(() =>
                      gateway.setConversationState(conversation.id, "paused"),
                    )
                  }
                  disabled={!canSend}
                >
                  <Square size={14} />
                </IconButton>
              ) : null}
              <button
                className="send-button"
                aria-label="发送消息"
                disabled={!canSend || !conversation.draft.trim()}
                onClick={send}
              >
                <ArrowUp size={17} />
              </button>
            </div>
          </div>
        </div>
        <div className="composer-hint">
          <span>Enter 发送 · Shift + Enter 换行</span>
          <span>前端预览 · 模型未连接</span>
        </div>
      </div>

      <Modal
        open={inputOpen}
        onOpenChange={setInputOpen}
        title="当前上下文"
        description="模型尚未连接。以下是前端为当前会话保存的输入内容。"
        wide
      >
        <DataBlock
          title="会话与输入"
          value={{
            conversationId: conversation.id,
            workspace: conversation.workspace,
            model: conversation.model,
            context: conversation.context,
            capabilities: conversation.capabilityIds,
            messages: conversation.messages.map((m) => ({
              role: m.role,
              text: m.text,
              tool: m.tool,
            })),
            pendingDraft: conversation.draft,
          }}
        />
      </Modal>
      <Modal open={renameOpen} onOpenChange={setRenameOpen} title="重命名会话">
        <label className="field-label" htmlFor="conversation-title">
          会话名称
        </label>
        <input
          className="input"
          id="conversation-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter")
              perform(() => {
                gateway.renameConversation(conversation.id, title);
                setRenameOpen(false);
              });
          }}
        />
        <div className="dialog-actions">
          <Button onClick={() => setRenameOpen(false)}>取消</Button>
          <Button
            className="primary"
            onClick={() =>
              perform(() => {
                gateway.renameConversation(conversation.id, title);
                setRenameOpen(false);
              })
            }
          >
            保存
          </Button>
        </div>
      </Modal>
    </section>
  );
}
