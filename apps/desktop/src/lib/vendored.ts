/**
 * Ferramentas EMBUTIDAS (third_party vendorizado nos recursos do app).
 *
 * O soup-cli (Apache-2.0) viaja com o app como fonte + launcher; rodar a
 * cópia não instala nada — mas exige um runtime Python com as dependências
 * do soup no ambiente do usuário. A sonda (`--version`) é um teste REAL:
 * só reportamos "embutido pronto" quando a cópia executa de verdade.
 */
import { resolveResource } from "@tauri-apps/api/path";

const isTauriHost = "__TAURI_INTERNALS__" in window;

let soupLauncherCache: string | null | undefined;

/** Caminho do launcher da cópia embutida do soup (null fora do desktop). */
export async function vendoredSoupLauncher(): Promise<string | null> {
  if (!isTauriHost) return null;
  if (soupLauncherCache !== undefined) return soupLauncherCache;
  try {
    soupLauncherCache = await resolveResource("third_party/soup/run_soup.py");
  } catch {
    soupLauncherCache = null;
  }
  return soupLauncherCache;
}

/** Comando para rodar o soup EMBUTIDO via Python do usuário. */
export function vendoredSoupCommand(launcher: string, args: string): string {
  return `python "${launcher}" ${args}`;
}
