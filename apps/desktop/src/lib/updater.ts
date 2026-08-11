import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

let prepared: Update | null = null;
let installing = false;

/** Baixa em segundo plano e instala de forma passiva quando o usuário fechar o app. */
export async function configureBackgroundUpdater() {
  await getCurrentWindow().onCloseRequested(async (event) => {
    if (!prepared || installing) return;
    event.preventDefault();
    installing = true;
    try {
      await prepared.install();
      await relaunch();
    } finally {
      installing = false;
    }
  });

  const update = await check();
  if (!update) return;
  await update.download();
  prepared = update;
}
