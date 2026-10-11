import { ArrowUpRight, FileText, MessageSquare, Search } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../app/context";
import { useManagementNavigation } from "../app/navigation";
import { usePlugins } from "../plugins/context";
import { Modal } from "./ui";
export function CommandMenu({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const managementNavigation = useManagementNavigation();
  const { registry, preferences } = usePlugins();
  const { snapshot, gateway } = useWorkbench();
  const navigate = useNavigate();
  const search = query.toLowerCase();
  const items = [
    ...managementNavigation.map((item) => ({
      id: item.path,
      title: item.label,
      sub: "页面",
      path: `/manage/${item.path}`,
      icon: item.icon,
    })),
    ...(gateway.can("read-business")
      ? snapshot.conversations.map((c) => ({
          id: c.id,
          title: c.title,
          sub: c.workspace,
          path: `/agent/${c.id}`,
          icon: MessageSquare,
        }))
      : []),
    ...(gateway.can("read-business") &&
    registry
      .resolve(preferences.enabledIds)
      .some((plugin) => plugin.owner === "B")
      ? snapshot.sources.map((source) => ({
          id: source.id,
          title: source.title,
          sub: `资料 · rev.${source.revision}`,
          path: `/manage/knowledge?record=${source.id}`,
          icon: FileText,
        }))
      : []),
  ].filter((item) => (item.title + item.sub).toLowerCase().includes(search));
  return (
    <Modal
      open={open}
      onOpenChange={(value) => {
        onOpenChange(value);
        if (!value) setQuery("");
      }}
      title="搜索"
    >
      <div className="command-input">
        <Search size={18} />
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="会话、资料或页面"
          aria-label="搜索内容"
        />
      </div>
      <div className="command-results">
        {items.map((item) => (
          <button
            key={item.id}
            onClick={() => {
              navigate(item.path);
              onOpenChange(false);
              setQuery("");
            }}
          >
            <item.icon size={16} />
            <span>
              <strong>{item.title}</strong>
              <small>{item.sub}</small>
            </span>
            <ArrowUpRight size={13} />
          </button>
        ))}
        {!items.length && <p className="small-empty">没有找到匹配内容。</p>}
      </div>
    </Modal>
  );
}
