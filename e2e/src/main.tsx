import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { initWasm } from "@betterbase/sdk";
import App from "./App.tsx";

await initWasm();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
