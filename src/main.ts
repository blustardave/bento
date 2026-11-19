import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-600.css";
import "./styles.css";
import { App } from "./app";

// Block the browser's own context menu and zoom shortcuts outside inputs.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLInputElement || (t instanceof HTMLTextAreaElement && t.id === "editor"))) e.preventDefault();
});

const app = new App();
// Handy for debugging in the dev tools console.
(window as unknown as { bento: App }).bento = app;
