import "@fontsource/source-serif-4/latin-400.css";
import "@fontsource/source-serif-4/latin-600.css";
import "./styles.css";
import { App } from "./app";

// Block the browser's own context menu and zoom shortcuts outside inputs.
window.addEventListener("contextmenu", (e) => {
  const t = e.target as HTMLElement;
  if (!(t instanceof HTMLInputElement || (t instanceof HTMLTextAreaElement && t.id === "editor"))) e.preventDefault();
});

import { windowControls } from "./native";

const app = new App();
// Show the window only after the first frame is painted, at its restored size.
requestAnimationFrame(() => requestAnimationFrame(() => { windowControls.show(); }));
// Handy for debugging in the dev tools console.
(window as unknown as { bento: App }).bento = app;
