import {
  ArrowUpRight,
  ChevronDown,
  FolderOpen,
  MessageSquare,
  PanelLeftClose,
  Plus,
  Search,
} from "lucide-react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";
import { useWorkbench } from "../app/context";
import { useManagementNavigation } from "../app/navigation";
import { usePlugins } from "../plugins/context";
import { Button, IconButton } from "./ui";
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
}) {
  const { snapshot, gateway, perform } = useWorkbench();
  const managementNavigation = useManagementNavigation();
  const { preferences } = usePlugins();
  const navigate = useNavigate();
  const management = useLocation().pathname.startsWith("/manage");
  const groups = [...new Set(snapshot.conversations.map((c) => c.workspace))];
  return (
    <aside className="sidebar">
      <div className="brand-row">
        <Link to="/" className="brand" onClick={onNavigate}>
          <span className="brand-mark">i</span>
          <span>{preferences.preset === "circle" ? "circle" : "infosec"}</span>
        </Link>
        {onClose && (
          <IconButton label="收起导航" onClick={onClose}>
            <PanelLeftClose size={17} />
          </IconButton>
        )}
        <span className="brand-caption">WORKBENCH</span>
      </div>
      <div className="project-picker">
        <span className="project-avatar">IS</span>
        <div>
          <strong>
            {preferences.preset === "circle" ? "本地工作区" : "产品工程"}
          </strong>
          <small>
            {preferences.preset === "circle" ? "Circle 布局预览" : "研发项目"}
          </small>
        </div>
      </div>
      <div className="mode-tabs">
        <NavLink
          to={`/agent/${activeConversationId}`}
          onClick={onNavigate}
          className={!management ? "active" : ""}
        >
          Agent
        </NavLink>
        <NavLink
          to={`/manage/${managementNavigation[0]?.path ?? "plugins"}`}
          onClick={onNavigate}
          className={management ? "active" : ""}
        >
          平台管理
        </NavLink>
      </div>
      {!management ? (
        <>
          <div className="sidebar-actions">
            <Button
              className="new-conversation"
              disabled={!gateway.can("conversation")}
              onClick={() =>
                perform(() => {
                  navigate(`/agent/${gateway.createConversation()}`);
                  onNavigate?.();
                })
              }
            >
              <Plus size={15} />
              新会话
            </Button>
            <IconButton label="搜索会话或记录" onClick={onSearch}>
              <Search size={16} />
            </IconButton>
          </div>
          <div className="conversation-groups">
            {gateway.can("read-business") ? (
              groups.map((group) => (
                <section key={group}>
                  <div className="group-label">
                    <ChevronDown size={11} />
                    <FolderOpen size={13} />
                    {group}
                  </div>
                  {snapshot.conversations
                    .filter((c) => c.workspace === group)
                    .map((c) => (
                      <NavLink
                        key={c.id}
                        to={`/agent/${c.id}`}
                        onClick={onNavigate}
                        className={({ isActive }) =>
                          `conversation-link ${isActive ? "active" : ""}`
                        }
                      >
                        <MessageSquare size={13} />
                        <span>{c.title}</span>
                        {c.state === "waiting" ? (
                          <i className="dot amber" />
                        ) : c.state === "paused" ? (
                          <i className="pause-dot" />
                        ) : null}
                      </NavLink>
                    ))}
                </section>
              ))
            ) : (
              <p className="sidebar-muted">当前角色不读取业务会话。</p>
            )}
          </div>
        </>
      ) : (
        <nav className="management-nav" aria-label="平台管理">
          {managementNavigation.map((item) => (
            <NavLink
              key={item.path}
              to={`/manage/${item.path}`}
              onClick={onNavigate}
              className={({ isActive }) => (isActive ? "active" : "")}
            >
              <item.icon size={16} />
              <span>{item.label}</span>
              {item.owner && <small>{item.owner}</small>}
            </NavLink>
          ))}
        </nav>
      )}
      <div className="sidebar-footer">
        <span className="dot" />
        <span>前端预览</span>
        <Link to="/manage/settings" onClick={onNavigate}>
          设置
          <ArrowUpRight size={12} />
        </Link>
      </div>
    </aside>
  );
}
