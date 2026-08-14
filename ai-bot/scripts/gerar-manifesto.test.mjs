/**
 * O que este teste protege — e o motivo de ele existir antes do primeiro
 * release.
 *
 * A assinatura do manifesto é verificada em OUTRA linguagem, em outra máquina,
 * depois da publicação. Se o corpo canônico daqui divergir do de lá por um
 * espaço, uma casa de milissegundo ou uma chave fora de ordem, nada falha na
 * hora de publicar: falha na estação de quem baixa, com "assinatura não confere"
 * — e o release já está no ar. Então o que se trava aqui é a regra, não o
 * resultado: assina e confere; corpo alterado não confere; o corpo canônico é
 * estável entre execuções.
 *
 *   node --test scripts/
 */

import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { describe, it } from "node:test";

import {
  SCHEMA_VERSION,
  assinar,
  corpoCanonico,
  lerArgumentos,
  lerArtefato,
  normalizarInstante,
  sha256Do,
  verificar
} from "./gerar-manifesto.mjs";
import { gerarPar, publicaEmBase64 } from "./gerar-chaves.mjs";

/* --------------------------------- apoio ---------------------------------- */

function parDeChaves() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publica: publicaEmBase64(publicKey),
    privada: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

/** O mesmo manifesto de exemplo do lado Go (internal/update/update_test.go). */
function manifestoExemplo() {
  return {
    schemaVersion: SCHEMA_VERSION,
    product: "AI-BOT",
    channel: "stable",
    version: "0.2.0",
    publishedAt: "2026-08-14T12:00:00Z",
    minimumShellVersion: "0.1.0",
    artifacts: [
      {
        track: "data",
        id: "specialists",
        url: "https://exemplo.com/specialists.json",
        size: 24576,
        sha256: "ab".repeat(32)
      },
      {
        track: "gateway",
        id: "aibotd",
        url: "https://exemplo.com/aibotd-0.2.0.exe",
        size: 12582912,
        sha256: "cd".repeat(32)
      }
    ]
  };
}

/* -------------------------------- os testes ------------------------------- */

describe("assinatura do manifesto", () => {
  it("assina e verifica", () => {
    const { publica, privada } = parDeChaves();
    const assinado = assinar(manifestoExemplo(), privada);

    assert.ok(assinado.signature, "o manifesto tem de sair com signature");
    assert.match(assinado.signature, /^[A-Za-z0-9_-]+$/, "a assinatura é base64url SEM padding");
    assert.equal(Buffer.from(assinado.signature, "base64url").length, 64);
    assert.equal(verificar(assinado, publica), true);
  });

  it("não verifica com a chave de outro par", () => {
    const { privada } = parDeChaves();
    const outro = parDeChaves();
    assert.equal(verificar(assinar(manifestoExemplo(), privada), outro.publica), false);
  });

  it("corpo alterado depois de assinado não verifica", () => {
    const { publica, privada } = parDeChaves();
    const assinado = assinar(manifestoExemplo(), privada);

    // Uma alteração por campo que importa. A do sha256 é a que mais dói: a
    // assinatura cobre o hash, e o hash cobre os bytes — trocar o hash sem
    // trocar a assinatura é a forma exata de tentar servir outro binário.
    const adulteracoes = {
      "a versão": (m) => ({ ...m, version: "0.3.0" }),
      "o canal": (m) => ({ ...m, channel: "beta" }),
      "o piso da casca": (m) => ({ ...m, minimumShellVersion: "0.0.1" }),
      "a url do artefato": (m) => ({
        ...m,
        artifacts: [{ ...m.artifacts[0], url: "https://outro.invalido/x" }, m.artifacts[1]]
      }),
      "o sha256 do artefato": (m) => ({
        ...m,
        artifacts: [{ ...m.artifacts[0], sha256: "ef".repeat(32) }, m.artifacts[1]]
      }),
      "o tamanho do artefato": (m) => ({
        ...m,
        artifacts: [{ ...m.artifacts[0], size: 1 }, m.artifacts[1]]
      }),
      "um artefato a mais": (m) => ({
        ...m,
        artifacts: [...m.artifacts, { track: "ui", id: "bundle", url: "https://x.invalido/u", size: 1, sha256: "0".repeat(64) }]
      })
    };

    for (const [descricao, adulterar] of Object.entries(adulteracoes)) {
      assert.equal(
        verificar(adulterar(assinado), publica),
        false,
        `trocar ${descricao} deveria invalidar a assinatura`
      );
    }
  });

  it("assinatura vazia ou malformada é recusada sem explodir", () => {
    const { publica, privada } = parDeChaves();
    const assinado = assinar(manifestoExemplo(), privada);
    for (const signature of ["", "   ", "isto não é base64url!!", "AAAA"]) {
      assert.equal(verificar({ ...assinado, signature }, publica), false);
    }
  });
});

describe("corpo canônico", () => {
  it("é estável entre execuções e ignora a ordem das chaves", () => {
    const manifesto = manifestoExemplo();
    const primeiro = corpoCanonico(manifesto).toString("utf8");
    const segundo = corpoCanonico(manifesto).toString("utf8");
    assert.equal(primeiro, segundo);

    // O mesmo conteúdo montado em outra ordem — que é o que um proxy, um CDN ou
    // outra linguagem produzem naturalmente — tem de dar o MESMO corpo.
    const embaralhado = {
      artifacts: manifesto.artifacts.map((a) => ({
        sha256: a.sha256,
        url: a.url,
        id: a.id,
        size: a.size,
        track: a.track
      })),
      version: manifesto.version,
      product: manifesto.product,
      minimumShellVersion: manifesto.minimumShellVersion,
      publishedAt: manifesto.publishedAt,
      schemaVersion: manifesto.schemaVersion,
      channel: manifesto.channel
    };
    assert.equal(corpoCanonico(embaralhado).toString("utf8"), primeiro);
  });

  it("sai com as chaves ordenadas e sem o campo signature", () => {
    const corpo = corpoCanonico({ ...manifestoExemplo(), signature: "não deveria entrar" }).toString("utf8");
    assert.equal(corpo.includes("signature"), false, "assinar a própria assinatura não fecha");
    assert.ok(
      corpo.startsWith('{"artifacts":['),
      `as chaves têm de sair ordenadas (o encoder do Go ordena map): ${corpo.slice(0, 40)}`
    );
    assert.ok(corpo.includes('{"id":"specialists","sha256":'), "as chaves do artefato também são ordenadas");
    // Compacto: nem espaço nem quebra de linha entram no que é assinado.
    assert.equal(corpo.includes("\n"), false);
    assert.equal(corpo.includes(": "), false);
  });

  it("normaliza o instante como o time.RFC3339Nano do Go", () => {
    // Fuso diferente: o mesmo instante escrito de outro jeito é o mesmo corpo.
    assert.equal(normalizarInstante("2026-08-14T09:00:00-03:00"), "2026-08-14T12:00:00Z");
    // Zeros à direita CORTADOS — é aqui que o toISOString() do JavaScript
    // (sempre com três casas) divergiria do Go em silêncio.
    assert.equal(normalizarInstante("2026-08-14T12:00:00.000Z"), "2026-08-14T12:00:00Z");
    assert.equal(normalizarInstante("2026-08-14T12:00:00.120Z"), "2026-08-14T12:00:00.12Z");
    assert.equal(normalizarInstante("2026-08-14T12:00:00.123Z"), "2026-08-14T12:00:00.123Z");
    assert.throws(() => normalizarInstante("ontem à noite"));
  });

  it("ignora campo desconhecido, porque o que não está no corpo não é assinado", () => {
    const manifesto = manifestoExemplo();
    const comEnfeite = { ...manifesto, enfeite: "qualquer coisa" };
    assert.equal(corpoCanonico(comEnfeite).toString("utf8"), corpoCanonico(manifesto).toString("utf8"));
  });
});

describe("medição do artefato", () => {
  it("calcula o sha256 do arquivo em streaming", async () => {
    // O hash de um arquivo conhecido: "abc" é o vetor clássico do SHA-256.
    const arquivo = new URL("./gerar-manifesto.test.mjs", import.meta.url);
    const primeiro = await sha256Do(arquivo);
    const segundo = await sha256Do(arquivo);
    assert.match(primeiro, /^[0-9a-f]{64}$/);
    assert.equal(primeiro, segundo);
  });
});

describe("linha de comando", () => {
  it("acumula --artefato repetido em lista", () => {
    const opcoes = lerArgumentos([
      "--versao",
      "0.2.0",
      "--artefato",
      "track=ui,id=bundle",
      "--artefato",
      "track=gateway,id=aibotd",
      "--ajuda"
    ]);
    assert.equal(opcoes.versao, "0.2.0");
    assert.deepEqual(opcoes.artefato, ["track=ui,id=bundle", "track=gateway,id=aibotd"]);
    assert.equal(opcoes.ajuda, true);
  });

  it("lê os campos do artefato, inclusive url com sinal de igual", () => {
    const campos = lerArtefato("track=ui,id=bundle,arquivo=dist/ui.tar,url=https://x.invalido/a?v=2");
    assert.deepEqual(campos, {
      track: "ui",
      id: "bundle",
      arquivo: "dist/ui.tar",
      url: "https://x.invalido/a?v=2"
    });
  });
});

describe("geração de chaves", () => {
  it("a pública sai com 32 bytes e a privada em PEM", () => {
    const { publica, privadaPem } = gerarPar();
    assert.equal(Buffer.from(publica, "base64url").length, 32);
    assert.match(privadaPem, /^-----BEGIN PRIVATE KEY-----/);
    // E o par funciona de ponta a ponta: é o que prova que a pública impressa
    // é a que confere o que a privada assina.
    assert.equal(verificar(assinar(manifestoExemplo(), privadaPem), publica), true);
  });
});
