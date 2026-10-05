import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// Tauri expects a fixed port; never open a browser.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: { alias: { "@": path.resolve(__dirname, "./src") }, dedupe: ["react", "react-dom"] },
  // Pre-bundle every base-ui entry so a new import can't re-optimize mid-session and load a second React.
  optimizeDeps: { include: ["react", "react-dom", "cmdk", "@codemirror/commands", "@codemirror/lang-markdown", "@codemirror/language", "@codemirror/state", "@codemirror/view", "react-day-picker", "sonner", "lucide-react", "class-variance-authority", "@shadcn/react/message-scroller", "@base-ui/react/avatar", "@base-ui/react/button", "@base-ui/react/checkbox", "@base-ui/react/context-menu", "@base-ui/react/dialog", "@base-ui/react/input", "@base-ui/react/menu", "@base-ui/react/merge-props", "@base-ui/react/popover", "@base-ui/react/progress", "@base-ui/react/scroll-area", "@base-ui/react/select", "@base-ui/react/separator", "@base-ui/react/tabs", "@base-ui/react/toggle", "@base-ui/react/toggle-group", "@base-ui/react/tooltip", "@base-ui/react/use-render"] },
  clearScreen: false,
  server: { port: 1420, strictPort: true, open: false, watch: { ignored: ["**/src-tauri/**", "**/target/**"] } },
});
