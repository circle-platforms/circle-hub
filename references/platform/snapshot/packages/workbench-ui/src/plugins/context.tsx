import type { ReactNode } from "react";
import { createContext, useContext, useMemo, useState } from "react";
import { useWorkbench } from "../app/context";
import { PluginRegistry } from "./registry";
import type { PluginPreferences, WorkbenchPreset } from "./types";
const storageKey = "infosec.workbench.plugins.v1";
interface PluginRuntime {
  registry: PluginRegistry;
  preferences: PluginPreferences;
  setEnabled: (id: string, enabled: boolean) => void;
  setPreset: (preset: Exclude<WorkbenchPreset, "custom">) => void;
}
const Context = createContext<PluginRuntime | null>(null);
export function PluginProvider({
  registry,
  children,
}: {
  registry: PluginRegistry;
  children: ReactNode;
}) {
  const { notify } = useWorkbench();
  const [preferences, setPreferences] = useState<PluginPreferences>(() => {
    try {
      return registry.normalize(
        JSON.parse(localStorage.getItem(storageKey) ?? "null"),
      );
    } catch {
      return registry.normalize(null);
    }
  });
  const value = useMemo(() => {
    const save = (next: PluginPreferences) => {
      setPreferences(next);
      try {
        localStorage.setItem(storageKey, JSON.stringify(next));
      } catch {
        notify("插件选择仅保留在当前页面，本地保存未完成。");
      }
    };
    return {
      registry,
      preferences,
      setEnabled: (id: string, enabled: boolean) => {
        try {
          save({
            preset: "custom",
            enabledIds: registry.change(preferences.enabledIds, id, enabled),
          });
        } catch (error) {
          notify(error instanceof Error ? error.message : "插件状态未修改。");
        }
      },
      setPreset: (preset: "circle" | "infosec") =>
        save({
          preset,
          enabledIds:
            preset === "circle"
              ? []
              : registry.plugins.map((plugin) => plugin.id),
        }),
    };
  }, [registry, preferences, notify]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function usePlugins() {
  const value = useContext(Context);
  if (!value) throw Error("PluginProvider is required");
  return value;
}
