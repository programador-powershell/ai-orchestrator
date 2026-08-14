#!/usr/bin/env node
/**
 * Gera (e confere) o manifesto de atualização do AI-BOT.
 *
 * O manifesto é o centro da atualização descrita em `docs/atualizacao.md`: ele
 * declara uma publicação inteira — versão, canal, piso da casca nativa e um
 * artefato por trilha, cada um com tamanho e SHA-256 — e leva uma assinatura
 * Ed25519 sobre o corpo canônico. Quem VERIFICA é o gateway Go
 * (`services/gateway/internal/update`), com `crypto/ed25519` da biblioteca
 * padrão; este arquivo é a outra ponta, a que publica.
 *
 * # Por que só a biblioteca padrão
 *
 * `node:crypto` faz Ed25519 desde o Node 12 e SHA-256 desde sempre. Trazer uma
 * biblioteca de assinatura para a ferramenta que assina seria acrescentar um
 * fornecedor exatamente no ponto em que a cadeia de confiança começa — e é o
 * ponto que menos pode ter fornecedor a mais. Escrever criptografia à mão está
 * fora de questão; aqui não é preciso nenhuma das duas coisas.
 *
 * # O corpo canônico, e por que ele não é "o JSON do arquivo"
 *
 * O que se assina é derivado dos CAMPOS, com as chaves ordenadas e sem o campo
 * `signature`. Assinar os bytes do arquivo seria assinar a formatação: um
 * espaço a mais, um CDN que reserializa, uma chave em outra ordem, e a
 * assinatura de um manifesto legítimo para de conferir. A regra tem de ser
 * idêntica dos dois lados — a função `corpoCanonico` abaixo é o espelho de
 * `update.Canonical` no Go, incluindo dois detalhes que só aparecem quando
 * divergem:
 *
 *   - `publishedAt` sai em RFC3339 UTC com os zeros à direita CORTADOS
 *     (é o `time.RFC3339Nano` do Go: `.000` vira nada, `.120` vira `.12`);
 *   - campo que não está na lista NÃO é assinado — acrescentar um campo novo
 *     ao manifesto exige acrescentá-lo aos dois lados, e é assim que se quer.
 *
 * # A chave privada
 *
 * Vem de `AIBOT_UPDATE_PRIVATE_KEY` (PEM), e não de arquivo do repositório.
 * Ela mora no cofre da TI (Vaultwarden / AWS Secrets Manager) e NUNCA é
 * commitada: quem tem a privada publica atualização para todas as estações, o
 * que é o mesmo poder de quem assina o instalador.
 *
 * # Uso
 *
 *   node scripts/gerar-manifesto.mjs \
 *     --versao 0.2.0 --canal stable --casca-minima 0.1.0 \
 *     --artefato track=ui,id=bundle,arquivo=dist/ui-0.2.0.tar,url=https://.../ui-0.2.0.tar \
 *     --artefato track=gateway,id=aibotd,arquivo=dist/aibotd.exe,url=https://.../aibotd-0.2.0.exe \
 *     --saida dist/manifesto.json
 *
 *   node scripts/gerar-manifesto.mjs --verificar dist/manifesto.json
 */

import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat, writeFile } from "node:fs/promises";
import { argv, env, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

/** As trilhas do manifesto — as mesmas de `update.Track` no Go. */
export const TRILHAS = ["data", "ui", "gateway", "shell"];

/** A única forma de manifesto que o gateway entende (`update.SchemaVersion`). */
export const SCHEMA_VERSION = 1;

export const PRODUTO_PADRAO = "AI-BOT";
export const CANAL_PADRAO = "stable";

/* ------------------------------ corpo canônico ---------------------------- */

/**
 * O instante no formato que o Go produz com `time.RFC3339Nano` em UTC.
 *
 * `toISOString()` do JavaScript sempre escreve três casas de milissegundo
 * (`.000`), e o Go corta os zeros à direita. Sem esta normalização, o mesmo
 * instante gera dois corpos diferentes e a assinatura só falha do lado de quem
 * verifica — depois de publicada.
 */
export function normalizarInstante(valor) {
  const data = valor instanceof Date ? valor : new Date(valor);
  if (Number.isNaN(data.getTime())) {
    throw new Error(`instante inválido: ${JSON.stringify(valor)}`);
  }
  const iso = data.toISOString(); // 2026-08-14T12:00:00.000Z
  const [semZ] = iso.split("Z");
  const [tempo, fracao = ""] = semZ.split(".");
  const cortada = fracao.replace(/0+$/, "");
  return cortada === "" ? `${tempo}Z` : `${tempo}.${cortada}Z`;
}

/**
 * Serializa com as chaves ORDENADAS, recursivamente.
 *
 * É o que o encoder do Go faz com `map[string]any` — e a razão de o lado Go
 * transformar o struct em map antes de serializar: struct sairia na ordem de
 * declaração, que é convenção da linguagem, não do formato.
 */
function ordenado(valor) {
  if (Array.isArray(valor)) return valor.map(ordenado);
  if (valor !== null && typeof valor === "object") {
    const saida = {};
    for (const chave of Object.keys(valor).sort()) saida[chave] = ordenado(valor[chave]);
    return saida;
  }
  return valor;
}

/**
 * O corpo assinado: o manifesto SEM `signature`, com as chaves ordenadas.
 *
 * Espelho exato de `update.Canonical`. Os campos são escolhidos um a um, e não
 * copiados do objeto recebido, porque é isso que garante que um campo
 * desconhecido — acrescentado por engano ou por um intermediário — não entre no
 * que se assina nem mude o que se verifica.
 */
export function corpoCanonico(manifesto) {
  const artefatos = (manifesto.artifacts ?? []).map((artefato) => ({
    track: String(artefato.track ?? ""),
    id: String(artefato.id ?? ""),
    url: String(artefato.url ?? ""),
    size: Number(artefato.size ?? 0),
    sha256: String(artefato.sha256 ?? "")
  }));

  const corpo = {
    schemaVersion: Number(manifesto.schemaVersion ?? SCHEMA_VERSION),
    product: String(manifesto.product ?? ""),
    channel: String(manifesto.channel ?? ""),
    version: String(manifesto.version ?? ""),
    publishedAt: normalizarInstante(manifesto.publishedAt),
    minimumShellVersion: String(manifesto.minimumShellVersion ?? ""),
    artifacts: artefatos
  };

  return Buffer.from(JSON.stringify(ordenado(corpo)), "utf8");
}

/* --------------------------------- chaves --------------------------------- */

/**
 * Base64 com os dois alfabetos, com ou sem padding.
 *
 * O gateway gera em base64url cru; gente que copia de um cofre costuma trazer a
 * forma padrão. Recusar uma das duas transformaria "chave certa colada do lugar
 * errado" num erro de assinatura, que é o erro mais caro de diagnosticar.
 */
function base64ParaBytes(texto) {
  const limpo = String(texto).trim().replace(/\s+/g, "");
  const normalizado = limpo.replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Buffer.from(normalizado, "base64");
  if (bytes.length === 0 && limpo !== "") {
    throw new Error("a chave não é base64 válido");
  }
  return bytes;
}

/**
 * Chave pública Ed25519 a partir dos 32 bytes crus.
 *
 * O `node:crypto` só aceita chave em DER/PEM, então os bytes crus recebem o
 * prefixo SPKI do OID 1.3.101.112 (Ed25519). São doze bytes constantes — é a
 * forma padrão de fazer isso sem biblioteca, e o Go do outro lado guarda a
 * mesma chave como 32 bytes puros.
 */
export function chavePublicaDeBase64(texto) {
  const bytes = base64ParaBytes(texto);
  if (bytes.length !== 32) {
    throw new Error(`a chave pública tem ${bytes.length} bytes depois do base64, e Ed25519 usa 32`);
  }
  const spki = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), bytes]);
  return createPublicKey({ key: spki, format: "der", type: "spki" });
}

/** Aceita a chave pública já em PEM ou nos 32 bytes em base64. */
function lerChavePublica(texto) {
  const bruto = String(texto).trim();
  if (bruto.includes("BEGIN")) return createPublicKey(bruto);
  return chavePublicaDeBase64(bruto);
}

/* ----------------------------- assinar/conferir --------------------------- */

/**
 * Assina o corpo canônico e devolve o manifesto com `signature`.
 *
 * `null` como algoritmo não é omissão: em Ed25519 a função de hash é parte do
 * esquema, e o `node:crypto` exige `null` justamente para deixar claro que não
 * há um digest escolhido por fora.
 */
export function assinar(manifesto, chavePrivadaPem) {
  const chave = createPrivateKey(String(chavePrivadaPem).trim());
  if (chave.asymmetricKeyType !== "ed25519") {
    throw new Error(`a chave privada é ${chave.asymmetricKeyType}, e o manifesto usa ed25519`);
  }
  const assinatura = sign(null, corpoCanonico(manifesto), chave);
  // base64url SEM padding — é o único formato que `update.Verify` decodifica.
  return { ...manifesto, signature: assinatura.toString("base64url") };
}

/** Confere a assinatura de um manifesto contra a chave pública. */
export function verificar(manifesto, chavePublica) {
  const assinatura = String(manifesto.signature ?? "").trim();
  if (assinatura === "") return false;
  const bytes = Buffer.from(assinatura, "base64url");
  if (bytes.length !== 64) return false;
  return verify(null, corpoCanonico(manifesto), lerChavePublica(chavePublica), bytes);
}

/* -------------------------------- artefatos ------------------------------- */

/** SHA-256 em streaming: um binário de 12 MB não precisa caber na memória. */
export async function sha256Do(caminho) {
  const hash = createHash("sha256");
  for await (const bloco of createReadStream(caminho)) hash.update(bloco);
  return hash.digest("hex");
}

/** Mede o arquivo e devolve o artefato pronto para entrar no manifesto. */
export async function artefatoDe({ track, id, arquivo, url }) {
  if (!TRILHAS.includes(track)) {
    throw new Error(`trilha desconhecida ${JSON.stringify(track)}; use uma de ${TRILHAS.join(", ")}`);
  }
  if (!id) throw new Error(`o artefato da trilha ${track} está sem id`);
  if (!url) throw new Error(`o artefato ${track}/${id} está sem url`);
  if (!url.startsWith("https://")) {
    // O gateway já recusa o que não é HTTPS (internal/netguard); recusar aqui é
    // descobrir o erro na publicação, e não na estação de quem baixa.
    throw new Error(`o artefato ${track}/${id} tem url que não é https: ${url}`);
  }
  const info = await stat(arquivo);
  return { track, id, url, size: info.size, sha256: await sha256Do(arquivo) };
}

/* ------------------------------ linha de comando -------------------------- */

/** `--chave valor` e `--bandeira`, com repetição acumulada em lista. */
export function lerArgumentos(lista) {
  const opcoes = {};
  for (let i = 0; i < lista.length; i += 1) {
    const item = lista[i];
    if (!item.startsWith("--")) continue;
    const nome = item.slice(2);
    const proximo = lista[i + 1];
    // Bandeira sem valor (`--ajuda`) vira `true`; o resto consome o próximo item.
    let valor = true;
    if (proximo !== undefined && !proximo.startsWith("--")) {
      valor = proximo;
      i += 1;
    }
    if (opcoes[nome] === undefined) opcoes[nome] = valor;
    else if (Array.isArray(opcoes[nome])) opcoes[nome].push(valor);
    else opcoes[nome] = [opcoes[nome], valor];
  }
  return opcoes;
}

/** `track=ui,id=bundle,arquivo=…,url=…` vira objeto. */
export function lerArtefato(texto) {
  const campos = {};
  for (const parte of String(texto).split(",")) {
    const corte = parte.indexOf("=");
    if (corte < 0) throw new Error(`--artefato espera chave=valor, e veio ${JSON.stringify(parte)}`);
    campos[parte.slice(0, corte).trim()] = parte.slice(corte + 1).trim();
  }
  return campos;
}

const AJUDA = `
Gera o manifesto de atualização do AI-BOT (docs/atualizacao.md).

  node scripts/gerar-manifesto.mjs --versao <x.y.z> --artefato <campos> [...] [--saida <arquivo>]
  node scripts/gerar-manifesto.mjs --verificar <manifesto.json> [--chave-publica <base64|PEM>]

Opções
  --versao <x.y.z>          versão publicada (obrigatória)
  --artefato <campos>       track=…,id=…,arquivo=…,url=…  (repetível)
  --produto <nome>          padrão: ${PRODUTO_PADRAO}
  --canal <stable|beta>     padrão: ${CANAL_PADRAO}
  --casca-minima <x.y.z>    piso da casca nativa (minimumShellVersion)
  --publicado-em <ISO>      padrão: agora
  --saida <arquivo>         padrão: a saída padrão
  --verificar <arquivo>     confere a assinatura e sai com 0 ou 1

Ambiente
  AIBOT_UPDATE_PRIVATE_KEY  chave privada Ed25519 em PEM — do cofre da TI, NUNCA do repositório
  AIBOT_UPDATE_PUBLIC_KEY   chave pública em base64, usada por --verificar
`;

async function comandoVerificar(opcoes) {
  const caminho = opcoes.verificar;
  if (caminho === true) throw new Error("--verificar precisa do caminho do manifesto");
  const manifesto = JSON.parse(await readFile(caminho, "utf8"));
  const chave = opcoes["chave-publica"] ?? env.AIBOT_UPDATE_PUBLIC_KEY;
  if (!chave) {
    throw new Error(
      "sem chave pública: passe --chave-publica ou defina AIBOT_UPDATE_PUBLIC_KEY (a mesma que foi embutida no build)"
    );
  }

  const problemas = [];
  if (Number(manifesto.schemaVersion) !== SCHEMA_VERSION) {
    problemas.push(`schemaVersion ${manifesto.schemaVersion}: este gerador escreve ${SCHEMA_VERSION}`);
  }
  for (const artefato of manifesto.artifacts ?? []) {
    if (!TRILHAS.includes(artefato.track)) problemas.push(`trilha desconhecida: ${artefato.track}`);
    if (!/^[0-9a-f]{64}$/.test(String(artefato.sha256))) {
      problemas.push(`sha256 malformado em ${artefato.track}/${artefato.id}`);
    }
  }

  if (!verificar(manifesto, chave)) {
    stderr.write(`assinatura NÃO confere: ${caminho}\n`);
    for (const problema of problemas) stderr.write(`  - ${problema}\n`);
    return 1;
  }
  stdout.write(`assinatura confere: ${caminho} (versão ${manifesto.version}, canal ${manifesto.channel})\n`);
  for (const artefato of manifesto.artifacts ?? []) {
    stdout.write(`  ${artefato.track}/${artefato.id} — ${artefato.size} bytes — ${artefato.sha256}\n`);
  }
  for (const problema of problemas) stderr.write(`  aviso: ${problema}\n`);
  return problemas.length === 0 ? 0 : 1;
}

async function comandoGerar(opcoes) {
  if (!opcoes.versao || opcoes.versao === true) throw new Error("--versao é obrigatória");
  const chavePrivada = env.AIBOT_UPDATE_PRIVATE_KEY;
  if (!chavePrivada) {
    throw new Error(
      "AIBOT_UPDATE_PRIVATE_KEY não está definida. Ela é a chave privada Ed25519 em PEM e mora no cofre da TI " +
        "(Vaultwarden / AWS Secrets Manager) — não no repositório. Gere um par com scripts/gerar-chaves.mjs."
    );
  }

  const entradas = opcoes.artefato === undefined ? [] : [].concat(opcoes.artefato);
  if (entradas.length === 0) throw new Error("nenhum --artefato: um manifesto sem artefato não publica nada");

  const artifacts = [];
  for (const entrada of entradas) artifacts.push(await artefatoDe(lerArtefato(entrada)));

  const manifesto = assinar(
    {
      schemaVersion: SCHEMA_VERSION,
      product: opcoes.produto === undefined || opcoes.produto === true ? PRODUTO_PADRAO : opcoes.produto,
      channel: opcoes.canal === undefined || opcoes.canal === true ? CANAL_PADRAO : opcoes.canal,
      version: opcoes.versao,
      publishedAt: normalizarInstante(
        opcoes["publicado-em"] === undefined || opcoes["publicado-em"] === true
          ? new Date()
          : opcoes["publicado-em"]
      ),
      minimumShellVersion:
        opcoes["casca-minima"] === undefined || opcoes["casca-minima"] === true
          ? ""
          : opcoes["casca-minima"],
      artifacts
    },
    chavePrivada
  );

  // Escrito com indentação porque manifesto é lido por gente durante o
  // release. A formatação não afeta a assinatura — é exatamente por isso que o
  // corpo canônico existe.
  const texto = `${JSON.stringify(manifesto, null, 2)}\n`;
  if (opcoes.saida === undefined || opcoes.saida === true) stdout.write(texto);
  else {
    await writeFile(opcoes.saida, texto, "utf8");
    stdout.write(`manifesto escrito em ${opcoes.saida} (versão ${manifesto.version}, ${artifacts.length} artefato(s))\n`);
  }
  return 0;
}

export async function main(argumentos) {
  const opcoes = lerArgumentos(argumentos);
  if (opcoes.ajuda || opcoes.help || argumentos.length === 0) {
    stdout.write(AJUDA);
    return 0;
  }
  if (opcoes.verificar !== undefined) return comandoVerificar(opcoes);
  return comandoGerar(opcoes);
}

// Só roda como programa; importado pelo teste, não executa nada.
if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  main(argv.slice(2))
    .then((codigo) => exit(codigo))
    .catch((erro) => {
      stderr.write(`${erro.message}\n`);
      exit(1);
    });
}
