import {
  ArrowUpRight,
  Check,
  Download,
  History,
  RotateCcw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useWorkbench } from "../../app/context";
import { Button, EmptyState, Modal } from "../../components/ui";
import type { Role } from "../../platform/types";
import { FactList, PageFrame, roleLabels } from "./shared";
export function AuditPage() {
  const { snapshot, platform } = useWorkbench();
  return (
    <PageFrame
      title="操作记录"
      description="当前前端预览中的操作"
      action={
        <Button
          onClick={() =>
            platform.download(
              "preview-audit.json",
              JSON.stringify(
                { scope: "frontend-preview", events: snapshot.audit },
                null,
                2,
              ),
            )
          }
        >
          <Download size={14} />
          导出记录
        </Button>
      }
    >
      <div className="audit-list">
        {snapshot.audit.length ? (
          snapshot.audit.map((entry) => (
            <div key={entry.id}>
              <History size={15} />
              <span>
                <strong>{entry.action}</strong>
                <small>
                  {roleLabels[entry.actor]} · {entry.target}
                </small>
              </span>
              <time>{entry.at}</time>
            </div>
          ))
        ) : (
          <EmptyState title="暂时没有操作记录">
            新建会话、加载能力或发送请求后会显示在这里。
          </EmptyState>
        )}
      </div>
    </PageFrame>
  );
}
export function SettingsPage() {
  const { snapshot, gateway } = useWorkbench();
  const navigate = useNavigate();
  const [resetOpen, setResetOpen] = useState(false);
  const [previewInfo, setPreviewInfo] = useState(false);
  return (
    <PageFrame title="设置" description="界面、预览角色与连接状态">
      <div className="settings-sections">
        <section>
          <div>
            <h2>
              <Settings2 size={17} />
              运行方式
            </h2>
            <p>这套前端可以由浏览器或桌面宿主承载。</p>
          </div>
          <FactList
            values={{
              当前宿主: "Web 预览",
              数据: "当前浏览器本地存储",
              "Agent 运行时": "尚未连接",
              "B/C/D/E 服务": "预览适配器",
            }}
          />
          <Button onClick={() => setPreviewInfo(true)}>
            查看接入边界
            <ArrowUpRight size={13} />
          </Button>
        </section>
        <section>
          <div>
            <h2>
              <ShieldCheck size={17} />
              预览角色
            </h2>
            <p>用于检查不同人员看到的内容和操作，不代表后端鉴权。</p>
          </div>
          <div className="role-cards">
            {(Object.entries(roleLabels) as [Role, string][]).map(
              ([role, label]) => (
                <button
                  className={snapshot.role === role ? "active" : ""}
                  key={role}
                  onClick={() => gateway.setRole(role)}
                >
                  <span>{label}</span>
                  {snapshot.role === role && <Check size={15} />}
                  <small>
                    {
                      {
                        engineer: "会话、查看与操作请求",
                        viewer: "仅查看业务记录",
                        expert: "工程师权限及方法评审",
                        maintainer: "执行资源与平台维护",
                      }[role]
                    }
                  </small>
                </button>
              ),
            )}
          </div>
        </section>
        <section>
          <div>
            <h2>
              <RotateCcw size={17} />
              重置预览
            </h2>
            <p>恢复样例数据，清除本地会话输入和预览记录。</p>
          </div>
          <Button className="danger-text" onClick={() => setResetOpen(true)}>
            恢复样例数据
          </Button>
        </section>
      </div>
      <Modal
        open={resetOpen}
        onOpenChange={setResetOpen}
        title="恢复样例数据"
        description="当前浏览器保存的输入和记录会被清除。"
      >
        <div className="dialog-actions">
          <Button onClick={() => setResetOpen(false)}>保留当前数据</Button>
          <Button
            className="danger"
            onClick={() => {
              gateway.resetPreview();
              setResetOpen(false);
              navigate("/agent/conversation-01");
            }}
          >
            确认重置
          </Button>
        </div>
      </Modal>
      <Modal
        open={previewInfo}
        onOpenChange={setPreviewInfo}
        title="前端与服务接入"
        description="当前是可运行的前端框架，数据来自本地预览适配器。"
      >
        <p className="dialog-paragraph">
          界面通过 WorkbenchGateway 读取会话和四个对象，通过 PlatformBridge
          使用文件选择等宿主能力。接入正式服务或 Electron
          时替换对应适配器，页面不直接访问数据库、设备或模型密钥。
        </p>
        <p className="dialog-paragraph">
          本轮没有连接真实
          Agent、设备或后台服务。预览中的权限反馈用于检查交互，不能代替服务端授权。
        </p>
      </Modal>
    </PageFrame>
  );
}
