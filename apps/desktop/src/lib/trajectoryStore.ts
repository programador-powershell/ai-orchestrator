"use client";

/**
 * Trilha da última execução, compartilhada com a interface.
 *
 * Guarda só a mais recente: a trilha existe para responder "por que ESTA
 * resposta saiu assim", e acumular histórico aqui viraria um segundo log de
 * conversa, que já existe. Quem quer guardar exporta o texto.
 */

import { create } from "zustand";

import type { UiMode } from "@multiplike/contracts";

import { createTrajectory, type ContextSource, type Trajectory, type TrajectoryEvent } from "./trajectory";
import type { HarnessMode } from "./contextAssembly";

interface TrajectoryState {
  current: Trajectory | null;
  /** Fontes que o modo do harness barrou nesta execução. */
  skipped: ContextSource[];
  harnessMode: HarnessMode;
  begin: (mode: UiMode) => Trajectory;
  publish: (trajectory: Trajectory, skipped: ContextSource[]) => void;
  /** Acrescenta um evento à trilha viva; sem trilha, é ignorado. */
  append: (event: TrajectoryEvent) => void;
  setHarnessMode: (mode: HarnessMode) => void;
  clear: () => void;
}

export const HARNESS_MODE_KEY = "aio.harness.mode";

function loadMode(): HarnessMode {
  if (typeof window === "undefined") return "standard";
  return window.localStorage.getItem(HARNESS_MODE_KEY) === "minimal" ? "minimal" : "standard";
}

let contador = 0;

export const useTrajectory = create<TrajectoryState>((set, get) => ({
  current: null,
  skipped: [],
  harnessMode: loadMode(),
  begin: (mode) => {
    contador += 1;
    return createTrajectory(`run-${contador}`, mode, Date.now());
  },
  publish: (trajectory, skipped) => set({ current: trajectory, skipped }),
  append: (event) => {
    const atual = get().current;
    if (!atual) return;
    set({ current: { ...atual, events: [...atual.events, event] } });
  },
  setHarnessMode: (mode) => {
    try {
      window.localStorage.setItem(HARNESS_MODE_KEY, mode);
    } catch {
      // storage indisponível — vale para esta sessão
    }
    set({ harnessMode: mode });
  },
  clear: () => set({ current: null, skipped: [] })
}));
