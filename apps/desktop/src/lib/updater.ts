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

export interface UpdateInfo {
  version: string;
  notes?: string;
  date?: string;
}

export type UpdateCheck =
  | { status: "disponivel"; info: UpdateInfo }
  | { status: "atualizado" }
  | { status: "indisponivel"; reason: string }
  | { status: "erro"; reason: string };

/**
 * A chave pública do updater é substituída na pipeline de release. Se ela
 * ainda for o placeholder, a assinatura NÃO é verificável — e instalar um
 * binário sem verificar assinatura é o cenário que rejeitamos no estudo do
 * Openship (integridade opcional). Melhor recusar e dizer por quê.
 */
export function updaterConfigured(pubkey: string | undefined): boolean {
  return Boolean(pubkey) && !pubkey!.startsWith("__") && pubkey!.length > 40;
}

/** Busca manual, acionada pelo usuário. Nunca instala sozinha. */
export async function checkForUpdate(): Promise<UpdateCheck> {
  try {
    const update = await check();
    if (!update) return { status: "atualizado" };
    prepared = update;
    return { status: "disponivel", info: { version: update.version, notes: update.body, date: update.date } };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    // Sem endpoint/chave configurados o plugin lança — é o estado normal em
    // desenvolvimento, não um defeito a esconder.
    return { status: "erro", reason };
  }
}

/** Baixa e instala a atualização já encontrada, e reinicia. */
export async function applyUpdate(): Promise<void> {
  if (!prepared) throw new Error("nenhuma atualização preparada");
  installing = true;
  try {
    await prepared.download();
    await prepared.install();
    await relaunch();
  } finally {
    installing = false;
  }
}
