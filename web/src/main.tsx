import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router-dom";
import { router } from "./router";
import { KonamiCode } from "./components/KonamiCode";
import "./index.css";

// Register API log listener
import { registerApiLogListener } from "./api/client";
import { useAppStore } from "./store/app";

registerApiLogListener((log) => {
  useAppStore.getState().addApiLog(log);
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <KonamiCode />
    <RouterProvider router={router} />
  </StrictMode>,
);
