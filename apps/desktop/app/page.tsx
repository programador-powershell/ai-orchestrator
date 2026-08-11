"use client";

import dynamic from "next/dynamic";
import { useEffect } from "react";
import { runBootOnce } from "../src/lib/boot";

/**
 * ssr:false — os módulos do app acessam window/localStorage no top-level;
 * nunca devem rodar em Node durante o `next build` (comportamento de SPA).
 */
const App = dynamic(() => import("../src/App"), { ssr: false });

export default function Page() {
  // Side-effects do boot antigo (import do main.tsx), agora pós-mount e com
  // guarda de execução única (StrictMode roda efeitos 2x em dev).
  useEffect(() => {
    runBootOnce(() => {
      void (async () => {
        const [{ migrateLegacyLocalSettings }, { configureBackgroundUpdater }] = await Promise.all([
          import("../src/lib/migrations"),
          import("../src/lib/updater")
        ]);
        migrateLegacyLocalSettings();
        await configureBackgroundUpdater().catch(() => undefined);
      })();
    });
  }, []);

  return <App />;
}
