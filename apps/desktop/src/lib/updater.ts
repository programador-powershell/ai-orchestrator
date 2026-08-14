import { getCurrentWindow } from "@tauri-apps/api/window";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";

let prepared: Update | null = null;
let installing = false;

/**
 * Baixa em segundo plano e instala ao FECHAR o app.
 *
 * Este é o mecanismo que evita recompilar/reinstalar à mão a cada correção:
 * a pipeline publica uma versão assinada, o app a baixa sozinho enquanto a
 * pessoa trabalha e a aplica no fechamento, sem interromper nada.
 *
 * Ele existia escrito e **sem nenhum chamador** — a função inteira era código
 * morto, e na prática o app só atualizava se alguém abrisse Configurações e
 * clicasse. É por isso que cada correção parecia exigir reinstalação manual.
 *
 * ## O que precisa dar errado sem quebrar
 *
 * Sem rede, sem endpoint configurado ou com a chave ainda no placeholder, o
 * plugin LANÇA. Isso é o estado normal em desenvolvimento, e não pode
 * derrubar o boot — por isso a checagem é embrulhada e o resultado devolvido
 * em vez de propagado. Quem chama decide se mostra algo.
 */
export async function configureBackgroundUpdater(): Promise<UpdateCheck> {
  /*
   * O gancho de fechamento é registrado ANTES da checagem.
   *
   * Se a ordem fosse a inversa, uma checagem lenta (ou que lança) deixaria a
   * janela sem o gancho — e a atualização já baixada nunca seria aplicada,
   * porque o momento de aplicar é justamente o fechamento.
   */
  try {
    await getCurrentWindow().onCloseRequested(async (event) => {
      if (!prepared || installing) return;
      event.preventDefault();
      installing = true;
      try {
        await prepared.install();
        await relaunch();
      } catch {
        // Falhar ao instalar não pode PRENDER o app aberto: o
        // `preventDefault` já barrou este fechamento, então quem fecha agora é
        // esta linha. Sem isto, um erro de instalação viraria uma janela que
        // se recusa a fechar.
        await getCurrentWindow().destroy();
      } finally {
        installing = false;
      }
    });
  } catch (cause) {
    return { status: "erro", reason: cause instanceof Error ? cause.message : String(cause) };
  }

  try {
    const update = await check();
    if (!update) return { status: "atualizado" };
    await update.download();
    prepared = update;
    return {
      status: "disponivel",
      info: { version: update.version, notes: update.body, date: update.date }
    };
  } catch (cause) {
    // Sem endpoint/chave configurados o plugin lança — estado normal em
    // desenvolvimento, não defeito a esconder nem motivo para travar o boot.
    return { status: "erro", reason: cause instanceof Error ? cause.message : String(cause) };
  }
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
 * conector de deploy (integridade opcional). Melhor recusar e dizer por quê.
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
