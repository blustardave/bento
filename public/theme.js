// Apply the theme before anything paints, so there's no flash.
// (A separate file rather than an inline script, so the page's
// Content Security Policy can forbid inline scripts entirely.)
try {
  var t = localStorage.getItem("bento.theme") || "system";
  if (t === "system") t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  if (t === "dusk") t = "dark";
  document.documentElement.dataset.theme = t;
} catch (e) {}
