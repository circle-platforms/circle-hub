import type { ReactNode } from "react";
import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
} from "react";
import type {
  PlatformBridge,
  WorkbenchGateway,
  WorkbenchSnapshot,
} from "../platform/types";
interface RuntimeContext {
  gateway: WorkbenchGateway;
  platform: PlatformBridge;
  snapshot: WorkbenchSnapshot;
  notify: (message: string) => void;
  perform: (work: () => void, message?: string) => void;
  toast: string;
}
const Context = createContext<RuntimeContext | null>(null);
export function WorkbenchProvider({
  gateway,
  platform,
  children,
}: {
  gateway: WorkbenchGateway;
  platform: PlatformBridge;
  children: ReactNode;
}) {
  const snapshot = useSyncExternalStore(gateway.subscribe, gateway.getSnapshot);
  const [toast, setToast] = useState("");
  const value = useMemo(() => {
    const notify = (message: string) => {
      setToast(message);
      window.setTimeout(
        () => setToast((current) => (current === message ? "" : current)),
        3800,
      );
    };
    return {
      gateway,
      platform,
      snapshot,
      notify,
      toast,
      perform: (work: () => void, message?: string) => {
        try {
          work();
          if (message) notify(message);
        } catch (error) {
          notify(error instanceof Error ? error.message : "操作未完成。");
        }
      },
    };
  }, [gateway, platform, snapshot, toast]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}
export function useWorkbench() {
  const value = useContext(Context);
  if (!value) throw Error("WorkbenchProvider is required");
  return value;
}
