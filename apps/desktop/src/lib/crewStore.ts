"use client";

/**
 * Estado vivo da equipe — compartilhado entre a barra lateral e a tela.
 *
 * Precisa ser um store, e não `useState` dentro da view: a lista "modelo -
 * papel" mora no rail, que é um componente irmão da tela do agente. Com estado
 * local, o rail nunca veria quem foi contratado.
 *
 * Só guarda o que está acontecendo AGORA; o histórico da execução fica com o
 * resultado, não aqui.
 */

import { create } from "zustand";

import type { CrewMember, CrewPlan, ComplexityVerdict } from "./agentCrew";

interface CrewState {
  /** Objetivo em execução — vazio quando não há nada rodando. */
  goal: string;
  verdict: ComplexityVerdict | null;
  plan: CrewPlan | null;
  /** Na ordem de contratação: é assim que a barra lateral cresce. */
  crew: CrewMember[];
  running: boolean;
  /** Entrega de cada agente, por id. */
  outputs: Record<string, string>;
  /**
   * Marca que uma execução COMEÇOU, antes de existir equipe.
   *
   * O orquestrador leva alguns segundos para decidir, e nesse intervalo o
   * `running` precisa já valer: senão um segundo envio no composer dispararia
   * uma segunda equipe sobre o mesmo objetivo.
   */
  begin: (goal: string) => void;
  /** A equipe ficou pronta — o orquestrador decidiu. */
  setPlan: (verdict: ComplexityVerdict, plan: CrewPlan) => void;
  hire: (member: CrewMember) => void;
  activity: (id: string, activity: string) => void;
  fire: (id: string, status: CrewMember["status"], output: string) => void;
  stop: () => void;
  reset: () => void;
}

export const useCrew = create<CrewState>((set) => ({
  goal: "",
  verdict: null,
  plan: null,
  crew: [],
  running: false,
  outputs: {},
  begin: (goal) => set({ goal, verdict: null, plan: null, crew: [], outputs: {}, running: true }),
  setPlan: (verdict, plan) => set({ verdict, plan }),
  hire: (member) =>
    set((state) => ({
      // Reexecução do mesmo slot substitui a linha em vez de duplicá-la.
      crew: [...state.crew.filter((entry) => entry.id !== member.id), { ...member }]
    })),
  activity: (id, activity) =>
    set((state) => ({
      crew: state.crew.map((member) => (member.id === id ? { ...member, activity, status: "working" } : member))
    })),
  fire: (id, status, output) =>
    set((state) => ({
      crew: state.crew.map((member) =>
        member.id === id ? { ...member, status, activity: "", finishedAt: Date.now() } : member
      ),
      outputs: { ...state.outputs, [id]: output }
    })),
  stop: () => set({ running: false }),
  reset: () => set({ goal: "", verdict: null, plan: null, crew: [], outputs: {}, running: false })
}));
