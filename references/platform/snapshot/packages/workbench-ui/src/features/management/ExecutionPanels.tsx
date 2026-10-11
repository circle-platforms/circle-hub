import { ArrowUpRight, LockKeyhole } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../../app/context";
import { Badge, Button } from "../../components/ui";
import type { SessionContributionProps } from "../../plugins/types";
export function TerminalPanel({ conversation }: SessionContributionProps) {
  const { gateway } = useWorkbench();
  const [command, setCommand] = useState("");
  const [terminalLines, setTerminalLines] = useState<string[]>([
    "$ " + conversation.workspace,
    "此终端尚未连接执行服务。",
  ]);
  return (
    <div className="terminal-panel">
      <div className="terminal-session">
        <span className="dot" />
        {conversation.workspace}
        <span>未连接</span>
      </div>
      <pre>{terminalLines.join("\n")}</pre>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          if (command.trim()) {
            setTerminalLines((lines) => [
              ...lines,
              `$ ${command}`,
              "未执行：尚未连接 D 的终端服务。",
            ]);
            setCommand("");
          }
        }}
      >
        <span>$</span>
        <input
          aria-label="终端输入"
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="输入命令…"
          disabled={!gateway.can("request-operation")}
        />
      </form>
    </div>
  );
}
export function BrowserPanel({ conversation }: SessionContributionProps) {
  const { snapshot, gateway, perform } = useWorkbench();
  const navigate = useNavigate();
  const browserResource = snapshot.resources.find(
    (resource) =>
      conversation.resourceIds?.includes(resource.id) &&
      resource.kind === "浏览器",
  );
  return browserResource ? (
    <div className="browser-panel">
      <div className="browser-address">
        <LockKeyhole size={11} />
        <span>设备管理页面</span>
        <Badge>示意</Badge>
      </div>
      <div className="browser-preview">
        <span className="device-brand">LAB / DEVICE</span>
        <h3>连接状态</h3>
        <div>
          <span>设备</span>
          <strong>LAB-DEVICE-01</strong>
        </div>
        <div>
          <span>管理会话</span>
          <strong>{browserResource.sessionId}</strong>
        </div>
        <div>
          <span>控制</span>
          <strong>只读观察</strong>
        </div>
        <p>这里将展示执行服务持有的同一浏览器。</p>
      </div>
      <div className="browser-footer">
        <Button
          onClick={() =>
            navigate(`/manage/execution?record=${browserResource.id}`)
          }
        >
          查看会话
          <ArrowUpRight size={12} />
        </Button>
        <Button
          disabled={!gateway.can("request-operation")}
          onClick={() =>
            perform(
              () => gateway.requestResourceControl(browserResource.id),
              "控制请求已记入预览记录，尚未连接执行端。",
            )
          }
        >
          请求控制
        </Button>
      </div>
    </div>
  ) : (
    <div className="panel-content">
      <h2>尚未关联浏览器</h2>
      <p className="panel-muted">当前会话没有关联的浏览器资源。</p>
      <Button onClick={() => navigate("/manage/execution")}>
        查看执行资源
        <ArrowUpRight size={12} />
      </Button>
    </div>
  );
}
