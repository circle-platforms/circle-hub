import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserPlatform } from "./platform/browser";
import { builtinPlugins } from "./plugins/builtins";
import { PreviewGateway } from "./preview/gateway";
import { Workbench } from "./workbench";
const gateway = new PreviewGateway();
const platform = new BrowserPlatform();
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Workbench gateway={gateway} platform={platform} plugins={builtinPlugins} />
  </React.StrictMode>,
);
