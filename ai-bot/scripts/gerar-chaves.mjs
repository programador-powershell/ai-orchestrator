#!/usr/bin/env node
/**
 * Gera o par de chaves Ed25519 que assina o manifesto de atualização.
 *
 * A PÚBLICA sai em base64 para ser EMBUTIDA no build — no gateway por
 * `-ldflags "-X …/internal/config.compiledUpdateKey=<base64>"`, e em
 * desenvolvimento por `AIBOT_UPDATE_PUBLIC_KEY`. Embutir em tempo de compilação
 * é a regra que sustenta a cadeia inteira: chave que viaja junto com o que ela
 * assina não assina nada, e chave que a variável de ambiente pode trocar é uma
 * sugestão — qualquer processo com acesso ao ambiente do usuário apontaria o
 * gateway para o próprio servidor de publicação.
 *
 * A PRIVADA sai em PEM na saída padrão e **nunca entra no repositório**. Ela vai
 * para o cofre da TI (Vaultwarden — https://vault.multiplikelabs.com/ — ou AWS
 * Secrets Manager, para o que é de DEV) e de lá para
 * `AIBOT_UPDATE_PRIVATE_KEY`, na máquina que publica. Quem tem essa chave
 * publica atualização para todas as estações: é o mesmo poder de quem assina o
 * instalador, e por isso o mesmo cuidado.
 *
 * Uso:
 *   node scripts/gerar-chaves.mjs              # par novo, os dois no terminal
 *   node scripts/gerar-chaves.mjs --so-publica # só a pública (conferir um build)
 */

import { generateKeyPairSync } from "node:crypto";
import { argv, exit, stderr, stdout } from "node:process";
import { pathToFileURL } from "node:url";

/**
 * Os 32 bytes crus da chave pública, em base64url sem padding.
 *
 * O DER de uma chave pública Ed25519 é o cabeçalho SPKI (12 bytes, com o OID
 * 1.3.101.112) seguido dos 32 bytes da chave. O lado Go guarda só esses 32 —
 * `ed25519.PublicKey` é exatamente isso —, então o que se embute é o final.
 *
 * base64url cru é o alfabeto que o gateway já usa para os próprios segredos; a
 * forma padrão também é aceita na leitura (`config.decodeBase64`), então colar
 * de um cofre que reformata não quebra nada.
 */
export function publicaEmBase64(chavePublica) {
  const der = chavePublica.export({ type: "spki", format: "der" });
  return Buffer.from(der.subarray(der.length - 32)).toString("base64url");
}

export function gerarPar() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publica: publicaEmBase64(publicKey),
    privadaPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString()
  };
}

export function main(argumentos) {
  const soPublica = argumentos.includes("--so-publica");
  const { publica, privadaPem } = gerarPar();

  stdout.write("# CHAVE PÚBLICA — embutir no build (32 bytes em base64)\n");
  stdout.write(`AIBOT_UPDATE_PUBLIC_KEY=${publica}\n`);
  stdout.write("#   gateway:  go build -ldflags \"-X aibot/gateway/internal/config.compiledUpdateKey=" + publica + "\"\n");

  if (soPublica) return 0;

  stdout.write("\n");
  stdout.write("# CHAVE PRIVADA — para o COFRE, nunca para o repositório.\n");
  stdout.write("#   Vaultwarden (https://vault.multiplikelabs.com/) ou AWS Secrets Manager;\n");
  stdout.write("#   de lá ela vira AIBOT_UPDATE_PRIVATE_KEY na máquina que publica.\n");
  stdout.write(privadaPem.endsWith("\n") ? privadaPem : `${privadaPem}\n`);

  // O aviso vai para a saída de ERRO de propósito: assim ele aparece na tela de
  // quem rodou mesmo quando a saída padrão foi redirecionada para um arquivo —
  // que é justamente o momento em que a chave privada acabou de virar arquivo
  // no disco e alguém precisa lembrar de tirá-la de lá.
  stderr.write("\nA chave privada acima é o poder de publicar atualização para todas as estações.\n");
  stderr.write("Guarde-a no cofre e apague qualquer cópia local. Nada de .env, nada de commit.\n");
  return 0;
}

if (import.meta.url === pathToFileURL(argv[1] ?? "").href) {
  exit(main(argv.slice(2)));
}
