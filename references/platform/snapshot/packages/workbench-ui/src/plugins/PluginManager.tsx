import {
  ArrowUpRight,
  Check,
  Layers,
  MessageSquare,
  Puzzle,
} from "lucide-react";
import { useNavigate } from "react-router-dom";
import { Badge, Button } from "../components/ui";
import { PageFrame } from "../features/management/shared";
import { usePlugins } from "./context";
export function PluginManager() {
  const { registry, preferences, setEnabled, setPreset } = usePlugins();
  const navigate = useNavigate();
  return (
    <PageFrame title="插件" description="选择工作台需要的页面和会话组件。">
      <div className="preset-grid">
        <button
          className={
            preferences.preset === "circle"
              ? "preset-card active"
              : "preset-card"
          }
          onClick={() => setPreset("circle")}
          aria-label="使用 Circle 工作台组合"
        >
          <MessageSquare size={20} />
          <strong>Circle 工作台</strong>
          <p>从会话和文件开始，按需添加平台组件。</p>
          {preferences.preset === "circle" && <Check size={16} />}
        </button>
        <button
          className={
            preferences.preset === "infosec"
              ? "preset-card active"
              : "preset-card"
          }
          onClick={() => setPreset("infosec")}
          aria-label="使用 InfoSec 工作台组合"
        >
          <Layers size={20} />
          <strong>InfoSec 工作台</strong>
          <p>启用知识、长期工作、执行资源和专业方法。</p>
          {preferences.preset === "infosec" && <Check size={16} />}
        </button>
      </div>
      <div className="plugin-section-label">
        <h2>内置插件</h2>
        <span>
          {preferences.enabledIds.length} / {registry.plugins.length} 已启用
        </span>
      </div>
      <div className="plugin-grid">
        {registry.plugins.map((plugin) => {
          const enabled = preferences.enabledIds.includes(plugin.id);
          return (
            <article className="plugin-card" key={plugin.id}>
              <div className="plugin-card-title">
                <span className="plugin-icon">
                  <plugin.icon size={20} />
                </span>
                <div>
                  <h2>{plugin.name}</h2>
                  <span>
                    {plugin.owner} · {plugin.version}
                  </span>
                </div>
                <label className="switch">
                  <input
                    type="checkbox"
                    aria-label={`启用 ${plugin.name} 插件`}
                    checked={enabled}
                    onChange={(e) => setEnabled(plugin.id, e.target.checked)}
                  />
                  <span />
                </label>
              </div>
              <p>{plugin.description}</p>
              <div className="plugin-points">
                {plugin.pages?.map((item) => (
                  <Badge key={item.path}>{item.label}</Badge>
                ))}
                {plugin.panels?.map((item) => (
                  <Badge key={item.id}>{item.label}侧栏</Badge>
                ))}
                {plugin.contextWidgets?.map((item) => (
                  <Badge key={item.id}>{item.label}</Badge>
                ))}
                {plugin.contextActions?.map((item) => (
                  <Badge key={item.id}>{item.label}</Badge>
                ))}
              </div>
              <div className="plugin-card-footer">
                <span>
                  <Puzzle size={12} />
                  随应用提供
                </span>
                {enabled && plugin.pages?.[0] && (
                  <Button
                    onClick={() => navigate(`/manage/${plugin.pages![0].path}`)}
                  >
                    打开
                    <ArrowUpRight size={12} />
                  </Button>
                )}
              </div>
            </article>
          );
        })}
      </div>
      <p className="detail-note">
        停用只收起插件界面，保留会话、引用和工作记录。这里不授予业务权限，也不终止后台执行。
      </p>
      <div className="plugin-connection">
        <span className="dot amber" />
        <div>
          <strong>Circle 尚未连接</strong>
          <p>
            当前切换的是前端组合。连接真实 Circle
            后，再使用它的会话、模型和工具。
          </p>
        </div>
      </div>
    </PageFrame>
  );
}
