import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "./styles.css";
import { migrateLegacyLocalSettings } from "./lib/migrations";
import { configureBackgroundUpdater } from "./lib/updater";

migrateLegacyLocalSettings();
void configureBackgroundUpdater().catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
