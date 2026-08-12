/**
 * WOPI — as regras puras do protocolo, testáveis sem servidor nem container.
 *
 * O host (nós) monta a URL do editor a partir do discovery.xml e emite o
 * access_token. Duas dessas regras são armadilhas documentadas que quase toda
 * implementação erra, e são exatamente as que dá para travar em teste agora:
 *
 *  - a substituição de placeholders no `urlsrc` (`<nome=VALOR&>`), onde
 *    placeholder desconhecido tem de ser REMOVIDO inteiro, sinais inclusive;
 *  - `access_token_ttl`, que NÃO é duração: é o instante de expiração em ms
 *    desde a epoch. Mandar 36000000 achando que são 10h é o bug clássico, e
 *    mandar 0 desliga o aviso de sessão expirando — vira perda de trabalho.
 *
 * Ver docs/adr-office-motor-wopi.md para por que o motor é Collabora e por que
 * a edição ao vivo NÃO passa por aqui.
 */

export interface WopiAction {
  /** Extensão sem ponto: "docx", "xlsx", "pptx". */
  extension: string;
  /** "edit" | "view" | "getinfo" … */
  name: string;
  urlsrc: string;
}

const XML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&apos;": "'"
};

const unescapeXml = (value: string) => value.replace(/&(amp|lt|gt|quot|apos);/g, (entity) => XML_ENTITIES[entity] ?? entity);

const attribute = (tag: string, name: string): string | undefined => {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`, "i"));
  return match ? unescapeXml(match[1]) : undefined;
};

/**
 * Lê o discovery.xml do WOPI client. Devolve as ações por extensão.
 *
 * Parser por regex de propósito: o discovery é um XML raso e conhecido, e
 * assim a função roda tanto no renderer quanto em teste node — DOMParser só
 * existe no browser e a suíte deste projeto é node-only.
 */
export function parseDiscovery(xml: string): WopiAction[] {
  return [...xml.matchAll(/<action\b[^>]*\/?>/gi)].flatMap((match) => {
    const tag = match[0];
    const extension = attribute(tag, "ext")?.toLowerCase() ?? "";
    const name = attribute(tag, "name") ?? "";
    const urlsrc = attribute(tag, "urlsrc") ?? "";
    if (!extension || !name || !urlsrc) return [];
    return [{ extension, name, urlsrc }];
  });
}

export function findAction(actions: WopiAction[], extension: string, name: string): WopiAction | undefined {
  const ext = extension.replace(/^\./, "").toLowerCase();
  return actions.find((action) => action.extension === ext && action.name === name);
}

/**
 * Substitui os placeholders do `urlsrc`.
 *
 * Formato: `<nome=TOKEN&>` — em `<ui=UI_LLCC&>`, `ui` é o NOME do parâmetro
 * da query e `UI_LLCC` é o TOKEN que identifica o placeholder. Conhecendo o
 * token, o resultado é `ui=pt-BR&`; o nome do parâmetro é preservado.
 *
 * Regra de ouro da documentação: token que não conhecemos é REMOVIDO inteiro,
 * incluindo `<`, `>` e o `&`. Placeholders novos podem aparecer a qualquer
 * momento, e um `<...>` deixado na URL a quebra.
 */
export function fillUrlsrc(urlsrc: string, values: Record<string, string>): string {
  return urlsrc.replace(/<([A-Za-z0-9_]+)=([A-Za-z0-9_]*)(&?)>/g, (_match, param: string, token: string, amp: string) => {
    const value = values[token];
    if (value === undefined || value === "") return "";
    return `${param}=${encodeURIComponent(value)}${amp}`;
  });
}

export interface EditorUrlInput {
  urlsrc: string;
  /** WOPISrc: a URL do NOSSO endpoint /wopi/files/{id}, SEM token. */
  wopiSrc: string;
  /** Idioma da interface do editor. */
  language?: string;
  /** Correlaciona nosso log com o do editor. */
  sessionId?: string;
}

/**
 * Monta a URL final do iframe.
 *
 * O `WOPISrc` é acrescentado por NÓS — não é um placeholder do urlsrc. O
 * access_token nunca entra na URL: vai no POST form da host page, para não
 * ficar no histórico nem no log do editor.
 */
export function buildEditorUrl(input: EditorUrlInput): string {
  const filled = fillUrlsrc(input.urlsrc, {
    UI_LLCC: input.language ?? "pt-BR",
    DC_LLCC: input.language ?? "pt-BR",
    HOST_SESSION_ID: input.sessionId ?? ""
  });
  const separator = filled.endsWith("?") || filled.endsWith("&") ? "" : filled.includes("?") ? "&" : "?";
  return `${filled}${separator}WOPISrc=${encodeURIComponent(input.wopiSrc)}`;
}

/** Recomendação da Microsoft: ~10 horas de validade. */
export const TOKEN_LIFETIME_MS = 10 * 60 * 60 * 1000;

/**
 * `access_token_ttl` é o INSTANTE de expiração em ms desde a epoch — não a
 * duração. E nunca pode ser 0: isso diz ao editor que a expiração é
 * desconhecida, ele desliga o aviso de "salve, a sessão vai expirar" e o
 * usuário perde trabalho.
 */
export function tokenExpiry(now: number, lifetimeMs: number = TOKEN_LIFETIME_MS): number {
  return now + Math.max(lifetimeMs, 1);
}

export function isTokenExpired(expiryMs: number, now: number): boolean {
  return expiryMs <= now;
}

/* --------------------------------- locks -------------------------------- */

/** O lock é string opaca; acima de 256 chars exige SupportsExtendedLockLength. */
export const MAX_LOCK_LENGTH = 1024;
export const LEGACY_LOCK_LENGTH = 256;
/** O host é obrigado a expirar o lock sozinho: o editor pode morrer sem soltar. */
export const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export interface LockState {
  id: string;
  acquiredAt: number;
  refreshedAt: number;
}

export function isLockValid(lock: LockState | undefined, now: number): boolean {
  if (!lock) return false;
  return now - lock.refreshedAt < LOCK_TIMEOUT_MS;
}

export function requiresExtendedLockLength(lockId: string): boolean {
  return lockId.length > LEGACY_LOCK_LENGTH;
}

export function isValidLockId(lockId: string): boolean {
  // ASCII apenas, dentro do teto, e não vazio.
  return lockId.length > 0 && lockId.length <= MAX_LOCK_LENGTH && /^[\x20-\x7E]+$/.test(lockId);
}

export type LockOutcome =
  | { ok: true; lock: LockState }
  /** 409 SEMPRE acompanhado do lock atual no header X-WOPI-Lock — omitir trava o editor. */
  | { ok: false; status: 409; currentLock: string };

/**
 * O lock NÃO pertence ao usuário: quem tiver permissão e apresentar o lock
 * certo pode destravar, mesmo tendo sido outro a travar.
 */
export function acquireLock(current: LockState | undefined, lockId: string, now: number): LockOutcome {
  if (!isLockValid(current, now)) return { ok: true, lock: { id: lockId, acquiredAt: now, refreshedAt: now } };
  if (current!.id === lockId) return { ok: true, lock: { ...current!, refreshedAt: now } };
  return { ok: false, status: 409, currentLock: current!.id };
}

export function releaseLock(current: LockState | undefined, lockId: string, now: number): LockOutcome {
  if (!isLockValid(current, now)) return { ok: false, status: 409, currentLock: "" };
  if (current!.id !== lockId) return { ok: false, status: 409, currentLock: current!.id };
  return { ok: true, lock: { id: "", acquiredAt: 0, refreshedAt: now } };
}

/**
 * PutFile num arquivo SEM lock só é válido se o arquivo tiver 0 bytes —
 * qualquer outro tamanho é 409. É o caso do "salvar como" recém-criado.
 */
export function canPutFile(
  current: LockState | undefined,
  lockId: string,
  fileSize: number,
  now: number
): { ok: true } | { ok: false; status: 409; currentLock: string } {
  if (!isLockValid(current, now)) {
    return fileSize === 0 ? { ok: true } : { ok: false, status: 409, currentLock: "" };
  }
  if (current!.id !== lockId) return { ok: false, status: 409, currentLock: current!.id };
  return { ok: true };
}

/* ------------------------------ endpoints ------------------------------- */

/**
 * A documentação impõe: a URL DEVE começar com /wopi e NÃO pode conter /ids.
 * Validar aqui evita descobrir isso só quando o editor recusar em silêncio.
 */
export function isValidWopiPath(path: string): boolean {
  return path.startsWith("/wopi") && !path.includes("/ids");
}

export function wopiSrc(origin: string, fileId: string): string {
  return `${origin.replace(/\/$/, "")}/wopi/files/${encodeURIComponent(fileId)}`;
}
