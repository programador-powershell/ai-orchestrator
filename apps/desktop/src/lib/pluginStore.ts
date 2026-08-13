"use client";

/**
 * Estado dos plugins — monta o registro a partir das DUAS origens.
 *
 * Os globais vêm da política assinada do grupo; os do usuário, do
 * `localStorage` da estação. A ordem de montagem não é detalhe: os globais
 * entram PRIMEIRO, porque é assim que a regra de precedência do kernel tem o
 * que comparar quando um plugin de usuário tenta declarar uma ferramenta que
 * já é da administração.
 *
 * Quando o admin fecha `userPluginsAllowed`, os manifestos locais continuam
 * salvos mas não são montados — o `resolve` do kernel também os derruba, então
 * são duas barreiras e não uma. Apagar o que a pessoa escreveu por causa de
 * uma mudança de política seria destruir trabalho dela sem necessidade.
 */

import { create } from "zustand";

import {
  createRegistry,
  mount,
  parseManifest,
  type PluginManifest,
  type PluginRegistry
} from "./plugins";

export const USER_PLUGINS_KEY = "aio.plugins.user.v1";

interface RebuildInput {
  global: unknown[];
  userPluginsAllowed: boolean;
  capabilities: string[];
}

interface PluginState {
  registry: PluginRegistry;
  /** Manifestos locais crus, como a pessoa salvou. */
  userPlugins: PluginManifest[];
  /** Motivos de recusa na última montagem — a UI mostra em vez de sumir. */
  rejected: Array<{ id: string; reason: string }>;
  /** A última política aplicada, para remontar sem esperar o próximo sync. */
  lastInput: RebuildInput;
  rebuild: (input: RebuildInput) => void;
  addUserPlugin: (raw: string) => { ok: true } | { ok: false; reason: string };
  removeUserPlugin: (id: string) => void;
}

function loadUser(): PluginManifest[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(USER_PLUGINS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as PluginManifest[]) : [];
  } catch {
    return [];
  }
}

function saveUser(items: PluginManifest[]): void {
  try {
    window.localStorage.setItem(USER_PLUGINS_KEY, JSON.stringify(items));
  } catch {
    // storage cheio — o plugin segue valendo nesta sessão
  }
}

/** Monta global → usuário e coleta os motivos de recusa. */
export function buildRegistry(input: {
  global: unknown[];
  user: PluginManifest[];
  userPluginsAllowed: boolean;
  capabilities: string[];
}): { registry: PluginRegistry; rejected: Array<{ id: string; reason: string }> } {
  let registry = createRegistry(input.capabilities);
  const rejected: Array<{ id: string; reason: string }> = [];

  for (const bruto of input.global) {
    const manifest = bruto as PluginManifest;
    const resultado = mount(registry, manifest, "global");
    if (resultado.ok) registry = resultado.registry;
    else rejected.push({ id: manifest?.id ?? "(sem id)", reason: resultado.reason });
  }

  if (input.userPluginsAllowed) {
    for (const manifest of input.user) {
      const resultado = mount(registry, manifest, "user");
      if (resultado.ok) registry = resultado.registry;
      else rejected.push({ id: manifest?.id ?? "(sem id)", reason: resultado.reason });
    }
  }

  return { registry, rejected };
}

export const usePlugins = create<PluginState>((set, get) => ({
  registry: createRegistry(),
  userPlugins: loadUser(),
  rejected: [],
  /**
   * Últimas entradas da política — guardadas para poder remontar sozinho.
   *
   * Sem elas, remontar exigia a política em mãos, e só o `policySync.apply()`
   * (boot/login) a tinha: salvar ou remover um plugin próprio não mudava nada
   * na sessão. O painel dizia "removido", mas o Composer seguia injetando o
   * prompt daquele plugin em TODA mensagem e o SecurityView continuava
   * rodando os scanners dele até alguém relogar.
   */
  lastInput: { global: [], userPluginsAllowed: false, capabilities: [] },
  rebuild: (input) => {
    const { registry, rejected } = buildRegistry({
      global: input.global,
      user: get().userPlugins,
      userPluginsAllowed: input.userPluginsAllowed,
      capabilities: input.capabilities
    });
    set({ registry, rejected, lastInput: input });
  },
  addUserPlugin: (raw) => {
    const lido = parseManifest(raw);
    if (!lido.ok) return lido;
    const atuais = get().userPlugins.filter((item) => item.id !== lido.manifest.id);
    const proximos = [...atuais, lido.manifest];
    saveUser(proximos);
    set({ userPlugins: proximos });
    get().rebuild(get().lastInput);
    return { ok: true };
  },
  removeUserPlugin: (id) => {
    const proximos = get().userPlugins.filter((item) => item.id !== id);
    saveUser(proximos);
    set({ userPlugins: proximos });
    get().rebuild(get().lastInput);
  }
}));
