import { useMemo } from "react";
import { HashRouter } from "react-router-dom";
import { App } from "./app/App";
import { WorkbenchProvider } from "./app/context";
import type { PlatformBridge, WorkbenchGateway } from "./platform/types";
import { PluginProvider } from "./plugins/context";
import { PluginRegistry } from "./plugins/registry";
import type { WorkbenchPlugin } from "./plugins/types";
import "./styles/tokens.css";
import "./styles/workbench.css";
/** Composition root. Hosts supply their data adapter and explicitly bundled UI plugins. */
export function Workbench({
  gateway,
  platform,
  plugins,
}: {
  gateway: WorkbenchGateway;
  platform: PlatformBridge;
  plugins: WorkbenchPlugin[];
}) {
  const registry = useMemo(() => new PluginRegistry(plugins), [plugins]);
  return (
    <WorkbenchProvider gateway={gateway} platform={platform}>
      <PluginProvider registry={registry}>
        <HashRouter>
          <App />
        </HashRouter>
      </PluginProvider>
    </WorkbenchProvider>
  );
}
export type { PlatformBridge, WorkbenchGateway } from "./platform/types";
export type { WorkbenchPlugin } from "./plugins/types";
