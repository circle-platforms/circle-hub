import {
  Blocks,
  ChevronRight,
  Download,
  FileText,
  Folder,
  LockKeyhole,
  X,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../app/context";
import { Button, DataBlock, IconButton, Modal } from "../components/ui";
import type { Conversation, SideView } from "../platform/types";
import { usePlugins } from "../plugins/context";
import { PluginBoundary } from "../plugins/PluginBoundary";
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
}) {
  const { gateway, platform, perform, notify } = useWorkbench();
  const { registry, preferences } = usePlugins();
  const navigate = useNavigate();
  const [preview, setPreview] = useState<{
    name: string;
    content: string;
  } | null>(null);
  const panels = registry.session(
    "panels",
    preferences.enabledIds,
    gateway.can,
  );
  const widgets = registry.session(
    "contextWidgets",
    preferences.enabledIds,
    gateway.can,
  );
  const selected = panels.find((item) => item.contribution.id === view);
  const activeView = view === "files" || selected ? view : "context";
  const tabs = [
    { id: "context", label: "上下文", icon: Blocks },
    { id: "files", label: "文件", icon: Folder },
    ...panels.map((item) => item.contribution),
  ];
  return (
    <aside className="context-panel">
      <div className="panel-tabs">
        <div>
          {tabs.map((item) => (
            <button
              key={item.id}
              className={activeView === item.id ? "active" : ""}
              onClick={() => onView(item.id)}
              aria-label={item.label}
              title={item.label}
            >
              <item.icon size={15} />
            </button>
          ))}
        </div>
        <IconButton label="关闭侧栏" onClick={onClose}>
          <X size={14} />
        </IconButton>
      </div>
      {activeView === "context" ? (
        <div className="panel-content">
          <section>
            <div className="panel-section-title">
              <h2>会话上下文</h2>
              <span>{conversation.context.length}</span>
            </div>
            {conversation.context.map((ref) => (
              <div className="context-item" key={ref.id}>
                <button
                  onClick={() => {
                    if (ref.kind === "source") {
                      const path = registry.recordPath(
                        preferences.enabledIds,
                        "B",
                        ref.id.split("@")[0],
                        ref.revision,
                      );
                      if (path) navigate(path);
                      else notify("知识插件已停用，这份引用仍保留在会话。");
                    } else
                      setPreview({
                        name: ref.name,
                        content:
                          ref.preview ??
                          "当前关联的工作区。文件访问将通过执行服务接入。",
                      });
                  }}
                >
                  {ref.kind === "workspace" ? (
                    <Folder size={15} />
                  ) : (
                    <FileText size={15} />
                  )}
                  <span>
                    {ref.name}
                    {ref.revision && <small>rev.{ref.revision}</small>}
                  </span>
                </button>
                {ref.kind !== "workspace" && (
                  <IconButton
                    label={`移除 ${ref.name}`}
                    onClick={() =>
                      perform(() =>
                        gateway.removeContext(conversation.id, ref.id),
                      )
                    }
                    disabled={!gateway.can("conversation")}
                  >
                    <X size={11} />
                  </IconButton>
                )}
              </div>
            ))}
          </section>
          {widgets.map(({ plugin, contribution }) => (
            <PluginBoundary key={contribution.id} name={plugin.name}>
              <contribution.component conversation={conversation} />
            </PluginBoundary>
          ))}
          <section className="permission-note">
            <LockKeyhole size={15} />
            <div>
              <strong>当前项目 · 只读上下文</strong>
              <p>查看与控制分别授权。</p>
            </div>
          </section>
        </div>
      ) : activeView === "files" ? (
        <div className="panel-content file-tree">
          <h2>{conversation.workspace}</h2>
          <div className="tree-directory">
            <ChevronRight size={12} />
            src
          </div>
          <button
            onClick={() =>
              setPreview({
                name: "src/connection.ts",
                content:
                  "// 代码样例\nexport function inspectConnection(session) {\n  const event = session.lastEvent;\n  return { event, verified: false };\n}",
              })
            }
          >
            <FileText size={13} />
            connection.ts
          </button>
          <div className="tree-directory">
            <ChevronRight size={12} />
            logs
          </div>
          {conversation.context
            .filter((c) => c.kind === "file")
            .map((ref) => (
              <button
                key={ref.id}
                onClick={() =>
                  setPreview({
                    name: ref.name,
                    content: ref.preview ?? "尚未读取文件内容。",
                  })
                }
              >
                <FileText size={13} />
                {ref.name.split("/").at(-1)}
              </button>
            ))}
          <p className="panel-muted">
            工作区文件为样例。添加的本地文件只在当前浏览器保存。
          </p>
        </div>
      ) : selected ? (
        <PluginBoundary
          key={selected.contribution.id}
          name={selected.plugin.name}
        >
          <selected.contribution.component conversation={conversation} />
        </PluginBoundary>
      ) : null}
      <Modal
        open={!!preview}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
        title={preview?.name ?? "文件"}
        wide
      >
        <DataBlock title="内容" value={preview?.content ?? ""} />
        <div className="dialog-actions">
          <Button
            onClick={() => {
              if (preview) {
                platform.download(
                  preview.name.split("/").at(-1) ?? "preview.txt",
                  preview.content,
                );
                notify("已下载本地预览内容。");
              }
            }}
          >
            <Download size={14} />
            下载
          </Button>
        </div>
      </Modal>
    </aside>
  );
}
