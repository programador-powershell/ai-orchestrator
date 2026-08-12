/**
 * Fonte do projeto — de onde o Code/Agent carrega o que vai buildar.
 *
 * Três origens: repositório GitHub, pasta local ou artefato pré-compilado.
 * Tudo aqui é validação pura; o IO (clonar, ler pasta, extrair zip) fica no
 * chamador. O ponto crítico é `resolveSource`: uma URL/caminho vindo do chat
 * não pode virar `git clone` sem passar por aqui.
 */

export type SourceKind = "github" | "folder" | "artifact";

export interface GithubSource {
  kind: "github";
  owner: string;
  repo: string;
  ref?: string;
  /** URL normalizada em HTTPS — nunca a string crua digitada. */
  cloneUrl: string;
}

export interface FolderSource {
  kind: "folder";
  path: string;
}

export interface ArtifactSource {
  kind: "artifact";
  path: string;
  format: "zip" | "tar" | "jar" | "war" | "image" | "binary";
}

export type ProjectSource = GithubSource | FolderSource | ArtifactSource;

export type SourceResult = { ok: true; source: ProjectSource } | { ok: false; reason: string };

/** Formas aceitas de referenciar um repo. Só GitHub, e só HTTPS. */
const GITHUB_PATTERNS = [
  /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w./-]+))?\/?$/i,
  /^git@github\.com:([\w.-]+)\/([\w.-]+?)(?:\.git)?$/i,
  /^([\w.-]+)\/([\w.-]+)$/
];

/**
 * Diretórios que nunca podem virar raiz de projeto — mesmo que o usuário peça.
 * Um build roda comandos arbitrários dentro da raiz; apontar para `.ssh` ou
 * para o próprio diretório do app é entregar as credenciais ao processo.
 */
const DENIED_ROOTS = [
  /[\\/]\.ssh([\\/]|$)/i,
  /[\\/]\.aws([\\/]|$)/i,
  /[\\/]\.gnupg([\\/]|$)/i,
  /[\\/]AppData[\\/](Roaming|Local)[\\/]AI Orchestrator([\\/]|$)/i,
  /^[A-Z]:[\\/]Windows([\\/]|$)/i,
  /^[A-Z]:[\\/]Program Files/i,
  /^\/(etc|bin|sbin|usr\/bin|boot|sys|proc)([\\/]|$)/i
];

/** Raiz do sistema ou do perfil inteiro — escopo grande demais para um build. */
const TOO_BROAD = [/^[A-Z]:[\\/]?$/i, /^\/$/, /^[A-Z]:[\\/]Users[\\/][^\\/]+[\\/]?$/i, /^\/(home|Users)\/[^/]+\/?$/];

const ARTIFACT_FORMATS: Array<[RegExp, ArtifactSource["format"]]> = [
  [/\.zip$/i, "zip"],
  [/\.(tar|tar\.gz|tgz)$/i, "tar"],
  [/\.jar$/i, "jar"],
  [/\.war$/i, "war"],
  [/\.(tar)?$/i, "binary"]
];

export function parseGithub(input: string): SourceResult {
  const raw = input.trim();
  for (const pattern of GITHUB_PATTERNS) {
    const match = raw.match(pattern);
    if (!match) continue;
    const [, owner, repo, ref] = match;
    return {
      ok: true,
      source: { kind: "github", owner, repo, ...(ref ? { ref } : {}), cloneUrl: `https://github.com/${owner}/${repo}.git` }
    };
  }
  if (/^https?:\/\//i.test(raw)) return { ok: false, reason: "Só repositórios do GitHub por HTTPS são aceitos." };
  return { ok: false, reason: "Formato não reconhecido. Use owner/repo ou a URL do GitHub." };
}

export function validateFolder(path: string): SourceResult {
  const raw = path.trim();
  if (!raw) return { ok: false, reason: "Informe a pasta do projeto." };
  if (TOO_BROAD.some((pattern) => pattern.test(raw))) {
    return { ok: false, reason: "Escopo amplo demais — aponte a pasta do projeto, não a raiz do disco ou do perfil." };
  }
  if (DENIED_ROOTS.some((pattern) => pattern.test(raw))) {
    return { ok: false, reason: "Pasta protegida: contém credenciais ou arquivos do sistema." };
  }
  return { ok: true, source: { kind: "folder", path: raw } };
}

export function validateArtifact(path: string): SourceResult {
  const raw = path.trim();
  if (!raw) return { ok: false, reason: "Informe o arquivo do artefato." };
  if (DENIED_ROOTS.some((pattern) => pattern.test(raw))) {
    return { ok: false, reason: "Caminho protegido." };
  }
  const hit = ARTIFACT_FORMATS.find(([pattern]) => pattern.test(raw));
  if (!hit || /[\\/]$/.test(raw)) return { ok: false, reason: "Artefato deve ser um arquivo (zip, tar, jar, war ou binário)." };
  return { ok: true, source: { kind: "artifact", path: raw, format: hit[1] } };
}

export function resolveSource(kind: SourceKind, input: string): SourceResult {
  if (kind === "github") return parseGithub(input);
  if (kind === "folder") return validateFolder(input);
  return validateArtifact(input);
}

/** Rótulo curto para a UI — o que aparece no cabeçalho da aba. */
export function sourceLabel(source: ProjectSource): string {
  if (source.kind === "github") return `${source.owner}/${source.repo}${source.ref ? `@${source.ref}` : ""}`;
  const parts = source.path.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? source.path;
}

/**
 * Artefato pré-compilado não tem código-fonte para detectar stack — o formato
 * já diz o que fazer com ele.
 */
export function artifactRunHint(source: ArtifactSource): string | undefined {
  if (source.format === "jar") return "java -jar <arquivo>";
  if (source.format === "war") return "Deploy em servlet container (Tomcat/Jetty)";
  if (source.format === "image") return "docker run <imagem>";
  return undefined;
}
