/// <reference types="vite/client" />

/**
 * Variáveis de ambiente do cliente.
 *
 * Só entra aqui o que pode ser público: tudo que leva o prefixo VITE_ é
 * INLINEADO no bundle em texto puro. O token do gateway NÃO mora em .env por
 * isso — ele é obtido em runtime do processo local (Tauri) e fica só em
 * memória. Segredo em .env do Vite é segredo publicado.
 */
interface ImportMetaEnv {
  /** Endpoint do gateway local. Padrão do app: ws://127.0.0.1:8799/v1/stream */
  readonly VITE_GATEWAY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
