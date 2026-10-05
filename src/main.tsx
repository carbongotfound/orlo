import React from "react";
import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import "./index.css";

// The window starts hidden; a crash before App shows it would leave nothing on screen, so show the error instead.
ReactDOM.createRoot(document.getElementById("root") as HTMLElement, {
  onUncaughtError: (e) => {
    const pre = document.createElement("pre");
    pre.style.cssText = "padding:24px;color:#f87171;white-space:pre-wrap;user-select:text;font:12px monospace";
    pre.textContent = e instanceof Error ? `${e.message}\n\n${e.stack}` : String(e);
    document.body.replaceChildren(pre);
    getCurrentWindow().show();
  },
}).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
