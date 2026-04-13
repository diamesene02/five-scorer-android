// Entry point bundled by esbuild into www/app.bundle.js
import { boot } from "./ui.js";

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot);
} else {
  boot();
}
