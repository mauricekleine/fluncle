import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "../styles.css";
import { App } from "./app";

const root = document.getElementById("root");

if (!root) {
  throw new Error("the glass has no #root to mount on");
}

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
