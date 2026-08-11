/**
 * Guarda de boot do app: os side-effects de inicialização (migrations de
 * localStorage, updater em background) devem rodar UMA única vez por sessão.
 * Com React StrictMode os efeitos rodam duas vezes em dev — a guarda mantém
 * o comportamento idêntico ao boot antigo no import do main.tsx.
 */
let booted = false;

/** Executa `boot` só na primeira chamada; retorna se executou. */
export function runBootOnce(boot: () => void): boolean {
  if (booted) return false;
  booted = true;
  boot();
  return true;
}

/** Só para testes — reseta a guarda entre casos. */
export function __resetBootForTests(): void {
  booted = false;
}
