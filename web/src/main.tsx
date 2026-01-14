import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { loadConfig } from "./config.ts";
import "./index.css";

loadConfig().then(() => {
    createRoot(document.getElementById("root")!).render(
        <StrictMode>
            <ErrorBoundary>
                <App />
            </ErrorBoundary>
        </StrictMode>
    );
});
