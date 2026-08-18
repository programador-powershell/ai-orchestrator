/**
 * O catálogo de reserva e o mapa de ícones.
 *
 * A fonte da verdade dos especialistas é o Go
 * (`services/gateway/internal/specialist/specialist.go`). Este arquivo existe
 * por dois motivos concretos:
 *
 * 1. O `ready` do gateway manda só os IDS (`specialists: string[]`). A parte
 *    visual — matiz, superfície, trilho, placeholder, avatar — precisa estar do
 *    lado de cá para a tela se montar sem uma segunda chamada.
 * 2. Antes do `ready` (e enquanto o gateway está fora do ar) a tela ainda tem
 *    de existir. Sem catálogo local, o app abriria cinza e sem placeholder.
 *
 * O que NÃO é copiado do Go, de propósito: `system`, `tools`, `triggers` e
 * `preferredSkills`. Prompt, permissão e roteamento são decisão do servidor;
 * duplicá-los aqui criaria um segundo roteador que discorda em silêncio do
 * primeiro — e o cliente nunca lê esses campos.
 */

import type { CSSProperties } from "react";
import {
  Bot,
  Code2,
  Database,
  FileText,
  KanbanSquare,
  MessagesSquare,
  Palette,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  Workflow,
  type LucideIcon
} from "lucide-react";
import { MASTER_ID, type SpecialistDefinition } from "@ai-bot/contracts";

/** Para onde a conversa cai quando o id não é de ninguém (espelha o Go). */
const DEFAULT_ID = "chat";

/**
 * Saturação única do produto. O matiz muda por especialista; a saturação não —
 * é o que faz dez acentos diferentes ainda parecerem o mesmo app.
 */
const SATURATION = 62;

/**
 * O prompt de sistema mora no gateway. Manter o campo vazio aqui é deliberado:
 * é um contrato do servidor que o cliente não usa, e uma cópia desatualizada
 * seria pior que a ausência.
 */
const NO_SYSTEM = "";

const CHAT: SpecialistDefinition = {
  id: "chat",
  name: "Conversa",
  tagline: "Pergunta, pesquisa e raciocínio",
  glyph: "chat",
  hue: 158,
  surface: "conversation",
  rail: "conversations",
  system: NO_SYSTEM,
  placeholder: "Pergunte, pesquise ou pense junto…",
  newLabel: "Nova conversa",
  actions: [
    { id: "pesquisar", label: "Pesquisar", insert: "/pesquisar ", glyph: "search" },
    { id: "resumir", label: "Resumir", insert: "/resumir ", glyph: "file" }
  ],
  avatar: {
    seed: 11,
    shape: "orb",
    eyes: "dot",
    mouth: "smile",
    accessory: "none",
    motion: "breathe",
    hue: 158,
    saturation: SATURATION
  }
};

const CODE: SpecialistDefinition = {
  id: "code",
  name: "Código",
  tagline: "Edita, roda e revisa o repositório",
  glyph: "code",
  hue: 210,
  surface: "editor",
  rail: "files",
  system: NO_SYSTEM,
  placeholder: "Descreva a mudança de código…",
  newLabel: "Nova sessão",
  actions: [
    { id: "review", label: "Revisar", insert: "/review ", glyph: "review" },
    { id: "explain", label: "Explicar", insert: "/explain ", glyph: "explain" },
    { id: "testgen", label: "Testes", insert: "/testgen ", glyph: "testgen" }
  ],
  avatar: {
    seed: 22,
    shape: "squircle",
    eyes: "visor",
    mouth: "line",
    accessory: "none",
    motion: "scan",
    hue: 210,
    saturation: SATURATION
  }
};

const OFFICE: SpecialistDefinition = {
  id: "office",
  name: "Documentos",
  tagline: "DOCX, PPTX e PDF de verdade",
  glyph: "office",
  hue: 26,
  surface: "document",
  rail: "document",
  system: NO_SYSTEM,
  placeholder: "Diga o que quer alterar no arquivo…",
  newLabel: "Nova sessão",
  actions: [
    { id: "abrir", label: "Abrir", insert: "/abrir ", glyph: "file" },
    { id: "substituir", label: "Substituir", insert: "/substituir ", glyph: "diff" }
  ],
  avatar: {
    seed: 33,
    shape: "chip",
    eyes: "arc",
    mouth: "line",
    accessory: "glasses",
    motion: "idle",
    hue: 26,
    saturation: SATURATION
  }
};

const DESIGN: SpecialistDefinition = {
  id: "design",
  name: "Design",
  tagline: "Interface, tokens e réplica de layout",
  glyph: "design",
  hue: 282,
  surface: "canvas",
  rail: "layers",
  system: NO_SYSTEM,
  placeholder: "Descreva a interface ou cole uma URL para replicar…",
  newLabel: "Nova sessão",
  actions: [
    { id: "replicar", label: "Replicar URL", insert: "/replicar ", glyph: "connect" },
    { id: "tokens", label: "Tokens", insert: "/tokens ", glyph: "design" }
  ],
  avatar: {
    seed: 44,
    shape: "bloom",
    eyes: "ring",
    mouth: "wave",
    accessory: "none",
    motion: "orbit",
    hue: 282,
    saturation: SATURATION
  }
};

const DATA: SpecialistDefinition = {
  id: "data",
  name: "Dados",
  tagline: "Schema, ERD, SQL e migração",
  glyph: "data",
  hue: 190,
  surface: "schema",
  rail: "tables",
  system: NO_SYSTEM,
  placeholder: "Peça tabelas, relações ou migrações…",
  newLabel: "Novo schema",
  actions: [
    { id: "erd", label: "ERD", insert: "/erd ", glyph: "erd" },
    { id: "sql", label: "SQL", insert: "/sql ", glyph: "data" },
    { id: "migrar", label: "Migração", insert: "/migrar ", glyph: "diff" }
  ],
  avatar: {
    seed: 55,
    shape: "hex",
    eyes: "scan",
    mouth: "grid",
    accessory: "none",
    motion: "pulse",
    hue: 190,
    saturation: SATURATION
  }
};

const WORK: SpecialistDefinition = {
  id: "work",
  name: "Trabalho",
  tagline: "Tarefas, automações e rotina",
  glyph: "work",
  hue: 340,
  surface: "board",
  rail: "tasks",
  system: NO_SYSTEM,
  placeholder: "Descreva o objetivo ou a automação…",
  newLabel: "Novo quadro",
  actions: [
    { id: "tarefa", label: "Tarefa", insert: "/tarefa ", glyph: "plan" },
    { id: "automacao", label: "Automação", insert: "/automacao ", glyph: "dag" }
  ],
  avatar: {
    seed: 66,
    shape: "squircle",
    eyes: "dot",
    mouth: "smile",
    accessory: "antenna",
    motion: "idle",
    hue: 340,
    saturation: SATURATION
  }
};

const SECURITY: SpecialistDefinition = {
  id: "security",
  name: "Segurança",
  tagline: "Revisão, achado e correção",
  glyph: "security",
  hue: 4,
  surface: "findings",
  rail: "findings",
  system: NO_SYSTEM,
  placeholder: "Peça uma revisão, simulação ou correção…",
  newLabel: "Nova revisão",
  actions: [
    { id: "revisar", label: "Revisar", insert: "/revisar ", glyph: "security" },
    { id: "deps", label: "Dependências", insert: "/deps ", glyph: "policy" }
  ],
  avatar: {
    seed: 77,
    shape: "shield",
    eyes: "scan",
    mouth: "line",
    accessory: "shield",
    motion: "pulse",
    hue: 4,
    saturation: SATURATION
  }
};

const AGENT: SpecialistDefinition = {
  id: "agent",
  name: "Equipe",
  tagline: "Monta e supervisiona vários agentes",
  glyph: "agent",
  hue: 258,
  surface: "crew",
  rail: "crew",
  system: NO_SYSTEM,
  placeholder: "Descreva o objetivo — a equipe se organiza para entregar…",
  newLabel: "Nova equipe",
  actions: [
    { id: "planejar", label: "Planejar", insert: "/planejar ", glyph: "plan" },
    { id: "executar", label: "Executar", insert: "/executar ", glyph: "play" }
  ],
  avatar: {
    seed: 88,
    shape: "hex",
    eyes: "ring",
    mouth: "none",
    accessory: "crown",
    motion: "orbit",
    hue: 258,
    saturation: SATURATION
  }
};

const FLUXO: SpecialistDefinition = {
  id: "fluxo",
  name: "Fluxo",
  tagline: "Monta o pipeline na tela",
  glyph: "dag",
  hue: 174,
  surface: "flow",
  rail: "nodes",
  system: NO_SYSTEM,
  placeholder: "Descreva o que deve acontecer — o fluxo é montado na tela…",
  newLabel: "Novo fluxo",
  actions: [
    { id: "no", label: "Nó", insert: "/no ", glyph: "dag" },
    { id: "validar", label: "Validar", insert: "/validar", glyph: "approve" }
  ],
  avatar: {
    seed: 99,
    shape: "hex",
    eyes: "dot",
    mouth: "grid",
    accessory: "antenna",
    motion: "pulse",
    hue: 174,
    saturation: SATURATION
  }
};

const TUNE: SpecialistDefinition = {
  id: "tune",
  name: "Tuning",
  tagline: "Dataset, treino e avaliação",
  glyph: "tune",
  hue: 96,
  surface: "train",
  rail: "runs",
  system: NO_SYSTEM,
  placeholder: "Peça exemplos de dataset, config de treino ou avaliação…",
  newLabel: "Novo treino",
  actions: [
    { id: "dataset", label: "Dataset", insert: "/dataset ", glyph: "data" },
    { id: "avaliar", label: "Avaliar", insert: "/avaliar ", glyph: "diagnostics" }
  ],
  avatar: {
    seed: 111,
    shape: "bloom",
    eyes: "spark",
    mouth: "wave",
    accessory: "bolt",
    motion: "pulse",
    hue: 96,
    saturation: SATURATION
  }
};

/**
 * O master não entra na lista: ele não é uma opção que a pessoa escolhe, é
 * quem roda ANTES de a escolha existir. Aparece na barra lateral (o botão do
 * laboratório de avatares) e na faixa de troca de especialista.
 */
export const MASTER: SpecialistDefinition = {
  id: MASTER_ID,
  name: "AI-BOT",
  tagline: "Lê o pedido e chama quem resolve",
  glyph: "bot",
  hue: 158,
  surface: "conversation",
  rail: "conversations",
  system: NO_SYSTEM,
  placeholder: "O que você quer fazer?",
  newLabel: "Nova conversa",
  avatar: {
    seed: 1,
    shape: "orb",
    eyes: "spark",
    mouth: "none",
    accessory: "halo",
    motion: "breathe",
    hue: 158,
    saturation: SATURATION
  }
};

/** A ordem é a de exibição, igual à do Go. */
export const FALLBACK_SPECIALISTS: SpecialistDefinition[] = [
  CHAT,
  CODE,
  OFFICE,
  DESIGN,
  DATA,
  WORK,
  SECURITY,
  AGENT,
  FLUXO,
  TUNE
];

/**
 * Ícone por especialista.
 *
 * `Record<string, LucideIcon>` e não `Record<SpecialistId, …>` porque a chave
 * vem do envelope, onde ela é texto livre: uma conversa antiga pode carregar um
 * id que o app de hoje não conhece, e derrubar a tela por causa disso seria
 * desproporcional.
 */
export const SPECIALIST_ICON: Record<string, LucideIcon> = {
  chat: MessagesSquare,
  code: Code2,
  office: FileText,
  design: Palette,
  data: Database,
  work: KanbanSquare,
  security: ShieldCheck,
  agent: Users,
  fluxo: Workflow,
  tune: SlidersHorizontal,
  master: Bot
};

/**
 * Nunca devolve `undefined`.
 *
 * Está no caminho de renderização de TODA linha da conversa: um especialista
 * zerado não teria superfície nem matiz, e a tela não saberia o que montar.
 * Id desconhecido cai no "chat", como no `GetOrDefault` do Go.
 */
export function specialistById(list: SpecialistDefinition[], id: string): SpecialistDefinition {
  const found = list.find((item) => item.id === id);
  if (found) return found;
  // O master fica fora do catálogo, mas continua sendo um id legítimo.
  if (id === MASTER_ID) return MASTER;
  const fallback = list.find((item) => item.id === DEFAULT_ID);
  return fallback ?? CHAT;
}

/**
 * O matiz do especialista aplicado ao pedaço de interface que fala por ele.
 *
 * Vai como custom property porque o tema deriva tudo de `--accent-h`, e o
 * pedaço precisa manter a cor de QUEM RESPONDEU mesmo depois de a conversa
 * trocar de especialista. ARMADILHA JÁ PAGA NESTE PROJETO: não declare
 * `transition` sobre `--accent-h`. A transição encalha no valor de partida e
 * todas as linhas terminam com o matiz da primeira.
 *
 * Mora aqui, e não na superfície de conversa, porque o shell também precisa
 * dele (o popup de delegação) — e importar da superfície arrastaria o chunk
 * inteiro da conversa, com o markdown junto, para dentro do bundle inicial.
 */
export function hueStyle(hue: number): CSSProperties {
  // `CSSProperties` não declara custom properties; a asserção dupla é o caminho
  // sem `any` para escrever uma.
  return { "--accent-h": String(hue) } as unknown as CSSProperties;
}
