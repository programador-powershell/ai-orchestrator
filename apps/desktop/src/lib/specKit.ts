/**
 * Fluxo spec-driven: constituição → spec → plano → tarefas → execução.
 *
 * O acionamento de agentes (agentTree/agentRuntime) é ótimo quando o objetivo
 * é claro e o modelo pode decidir sozinho. Ele é ruim quando o trabalho tem
 * **regras inegociáveis** — padrão de commit do time, stack permitida, testes
 * obrigatórios, o que não pode ser tocado. Nesses casos, deixar o modelo
 * decidir do zero a cada execução produz resultado diferente toda vez.
 *
 * Aqui a ordem é outra: primeiro escreve-se a **constituição** (os princípios
 * que não se negociam), e ela entra no prompt de TODAS as etapas seguintes. A
 * spec diz o QUE e por quê, sem escolher tecnologia; o plano diz COMO; as
 * tarefas são unidades pequenas e verificáveis. Cada etapa é revisada por uma
 * pessoa antes da seguinte — o ganho é previsibilidade e auditoria, não
 * velocidade.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por specKit.test.ts.
 */

export type StageId = "constitution" | "spec" | "plan" | "tasks";

export const STAGE_ORDER: StageId[] = ["constitution", "spec", "plan", "tasks"];

export const STAGE_LABEL: Record<StageId, string> = {
  constitution: "Constituição",
  spec: "Especificação",
  plan: "Plano técnico",
  tasks: "Tarefas"
};

export const STAGE_HINT: Record<StageId, string> = {
  constitution: "Princípios inegociáveis do time. Valem para todas as etapas seguintes.",
  spec: "O QUE será construído e por quê — sem escolher tecnologia.",
  plan: "COMO construir: arquitetura, arquivos, decisões técnicas e riscos.",
  tasks: "Unidades pequenas, ordenadas e verificáveis, prontas para executar."
};

export interface SpecTask {
  id: string;
  title: string;
  /** Instrução autocontida — vira o prompt do agente que executa. */
  detail: string;
  /** Como saber que ficou pronto. Sem isto, "concluído" é opinião. */
  verify: string;
  status: "pending" | "running" | "done" | "failed";
  /** Relatório do agente que executou. */
  report?: string;
}

export interface SpecDoc {
  schemaVersion: 1;
  name: string;
  constitution: string;
  spec: string;
  plan: string;
  tasks: SpecTask[];
  /** Etapas já aprovadas por uma pessoa. */
  approved: StageId[];
  updatedAt: number;
}

export const SPEC_STORAGE_KEY = "aio.spec.doc.v1";

export function emptyDoc(name = "Nova feature"): SpecDoc {
  return {
    schemaVersion: 1,
    name,
    constitution: "",
    spec: "",
    plan: "",
    tasks: [],
    approved: [],
    updatedAt: 0
  };
}

/* ----------------------------- progressão ---------------------------- */

/** Conteúdo textual da etapa (tarefas contam pela lista). */
export function stageContent(doc: SpecDoc, stage: StageId): string {
  switch (stage) {
    case "constitution":
      return doc.constitution;
    case "spec":
      return doc.spec;
    case "plan":
      return doc.plan;
    case "tasks":
      return doc.tasks.map((task) => `${task.title}\n${task.detail}`).join("\n");
  }
}

export function isStageFilled(doc: SpecDoc, stage: StageId): boolean {
  return stage === "tasks" ? doc.tasks.length > 0 : stageContent(doc, stage).trim().length > 0;
}

export function isApproved(doc: SpecDoc, stage: StageId): boolean {
  return doc.approved.includes(stage);
}

export interface StageBlock {
  ok: false;
  message: string;
}

/**
 * Pode gerar/editar esta etapa?
 *
 * A ordem é obrigatória de propósito: gerar o plano antes da spec aprovada
 * produziria um plano para um alvo que ainda pode mudar — e a revisão humana
 * perderia o sentido.
 */
export function canEnterStage(doc: SpecDoc, stage: StageId): { ok: true } | StageBlock {
  const index = STAGE_ORDER.indexOf(stage);
  if (index <= 0) return { ok: true };
  const previous = STAGE_ORDER[index - 1];
  if (!isStageFilled(doc, previous)) {
    return { ok: false, message: `preencha "${STAGE_LABEL[previous]}" antes de "${STAGE_LABEL[stage]}"` };
  }
  if (!isApproved(doc, previous)) {
    return {
      ok: false,
      message: `"${STAGE_LABEL[previous]}" precisa ser aprovada antes de gerar "${STAGE_LABEL[stage]}"`
    };
  }
  return { ok: true };
}

/**
 * Aprova a etapa. Aprovar invalida as POSTERIORES: se a spec mudou, o plano
 * feito em cima dela não está mais revisado — manter a aprovação seria
 * carimbar trabalho que ninguém olhou de novo.
 */
export function approveStage(doc: SpecDoc, stage: StageId, now: number): SpecDoc {
  const index = STAGE_ORDER.indexOf(stage);
  const kept = doc.approved.filter((entry) => STAGE_ORDER.indexOf(entry) <= index);
  return {
    ...doc,
    approved: kept.includes(stage) ? kept : [...kept, stage],
    updatedAt: now
  };
}

/** Editar uma etapa derruba a aprovação dela e de tudo que veio depois. */
export function setStage(doc: SpecDoc, stage: StageId, content: string, now: number): SpecDoc {
  const index = STAGE_ORDER.indexOf(stage);
  const approved = doc.approved.filter((entry) => STAGE_ORDER.indexOf(entry) < index);
  const base = { ...doc, approved, updatedAt: now };
  switch (stage) {
    case "constitution":
      return { ...base, constitution: content };
    case "spec":
      return { ...base, spec: content };
    case "plan":
      return { ...base, plan: content };
    case "tasks":
      return { ...base, tasks: parseTasks(content) };
  }
}

/* ------------------------------- tarefas ----------------------------- */

/**
 * Lê a lista de tarefas do texto do modelo.
 *
 * Formato pedido no prompt (e tolerante a variações):
 *   ## 1. Título
 *   <instrução>
 *   Verificação: <como saber que ficou pronto>
 *
 * Tarefa sem verificação NÃO é descartada — ela entra com a verificação
 * vazia e a UI cobra. Descartar em silêncio esconderia trabalho.
 */
/**
 * A linha inicia uma tarefa? Devolve o título limpo, ou `null`.
 *
 * O prompt pede `## 1. Título`, mas modelo não obedece formato à risca: vem
 * `## Título` sem número, `**1. Título**`, `- Título`. Exigir os três de uma
 * vez fazia a lista inteira ser lida como corpo da primeira tarefa — pior que
 * um título feio, porque some trabalho.
 */
function taskHeading(linha: string): string | null {
  const semHeader = linha.replace(/^\s*#{1,6}\s*/, "");
  const eraHeader = semHeader !== linha;
  // `[-*]\s+` não casa `**negrito**`, que não tem espaço depois do asterisco.
  const bullet = semHeader.match(/^\s*[-*]\s+(.*)$/);
  const numerada = semHeader.match(/^\s*\d+[.)]\s*(.*)$/);
  /**
   * Linha INTEIRA em negrito — `**1. Título**` — sem `##` na frente.
   *
   * É um dos formatos que o docstring acima promete tolerar, e era
   * justamente o que não passava: o bullet exige espaço depois do
   * asterisco, a numerada exige dígito no começo e sem `##` não havia
   * header. Com as tarefas todas nesse formato, `parseTasks` devolvia
   * lista vazia e o trabalho gerado sumia sem aviso.
   */
  const negrito = semHeader.match(/^\s*\*\*(.+)\*\*\s*$/);
  const corpo = bullet?.[1] ?? numerada?.[1] ?? negrito?.[1] ?? (eraHeader ? semHeader : null);
  if (corpo === null) return null;
  const limpo = corpo
    .replace(/^\*\*(.*)\*\*$/, "$1") // **Título**
    .replace(/^\s*\d+[.)]\s*/, "") // "**1. Título**" → "1. Título" → "Título"
    .trim();
  return limpo || null;
}

export function parseTasks(text: string): SpecTask[] {
  const linhas = text.split(/\r?\n/);
  const tasks: SpecTask[] = [];
  let atual: { title: string; corpo: string[] } | null = null;

  const fechar = () => {
    if (!atual) return;
    const corpo = atual.corpo.join("\n").trim();
    const match = corpo.match(/^(.*?)(?:^|\n)\s*verifica(?:ç|c)(?:ã|a)o\s*:\s*([\s\S]*)$/i);
    const detail = (match ? match[1] : corpo).trim();
    const verify = (match ? match[2] : "").trim();
    tasks.push({
      id: `t${tasks.length + 1}`,
      title: atual.title,
      detail,
      verify,
      status: "pending"
    });
    atual = null;
  };

  for (const linha of linhas) {
    const titulo = taskHeading(linha);
    if (titulo !== null) {
      fechar();
      atual = { title: titulo, corpo: [] };
      continue;
    }
    if (atual) atual.corpo.push(linha);
  }
  fechar();
  return tasks.filter((task) => task.title.length > 0);
}

export function patchTask(doc: SpecDoc, id: string, patch: Partial<SpecTask>, now: number): SpecDoc {
  return {
    ...doc,
    tasks: doc.tasks.map((task) => (task.id === id ? { ...task, ...patch } : task)),
    updatedAt: now
  };
}

/** Próxima tarefa a executar — a primeira pendente, na ordem escrita. */
export function nextPendingTask(doc: SpecDoc): SpecTask | null {
  return doc.tasks.find((task) => task.status === "pending") ?? null;
}

export interface TaskProgress {
  total: number;
  done: number;
  failed: number;
}

export function taskProgress(doc: SpecDoc): TaskProgress {
  return {
    total: doc.tasks.length,
    done: doc.tasks.filter((task) => task.status === "done").length,
    failed: doc.tasks.filter((task) => task.status === "failed").length
  };
}

/* ------------------------------- prompts ----------------------------- */

/**
 * A constituição entra em TODAS as etapas.
 *
 * É o que diferencia este fluxo de um chat comum: sem ela em cada prompt, o
 * modelo respeita as regras do time na primeira etapa e as esquece na
 * terceira, quando o contexto encheu.
 */
function constitutionBlock(doc: SpecDoc): string {
  const texto = doc.constitution.trim();
  if (!texto) return "";
  return (
    "CONSTITUIÇÃO DO PROJETO — princípios INEGOCIÁVEIS. Se algo que você propuser " +
    "conflitar com eles, o princípio vence e você deve dizer explicitamente qual foi " +
    "o conflito e o que fez no lugar:\n\n" +
    texto +
    "\n\n"
  );
}

export function stagePrompt(doc: SpecDoc, stage: StageId, pedido: string): string {
  const base = constitutionBlock(doc);
  switch (stage) {
    case "constitution":
      return (
        "Escreva a CONSTITUIÇÃO deste projeto: os princípios inegociáveis que vão governar " +
        "toda especificação, plano e tarefa daqui para frente.\n\n" +
        "Regras do documento: cada princípio numerado, uma frase afirmativa e verificável, " +
        "com o PORQUÊ em seguida. Nada de generalidade (\"escrever bom código\"). Prefira " +
        "restrições que dá para checar (\"toda função pública tem teste\", \"sem dependência " +
        "nova sem aprovação\").\n\n" +
        `CONTEXTO DO TIME:\n${pedido}`
      );
    case "spec":
      return (
        base +
        "Escreva a ESPECIFICAÇÃO: o QUE será construído e POR QUÊ.\n\n" +
        "Não escolha tecnologia, biblioteca nem estrutura de arquivo — isso é do plano. " +
        "Inclua: problema, quem é afetado, comportamento esperado, critérios de aceitação " +
        "verificáveis e o que está FORA de escopo. Onde faltar informação, escreva " +
        "\"EM ABERTO: <pergunta>\" em vez de supor.\n\n" +
        `PEDIDO:\n${pedido}`
      );
    case "plan":
      return (
        base +
        "Escreva o PLANO TÉCNICO para a especificação abaixo: COMO construir.\n\n" +
        "Inclua: arquitetura, arquivos a criar/alterar, decisões técnicas com a alternativa " +
        "descartada e o motivo, riscos e como testar. Se a especificação tiver algum " +
        "\"EM ABERTO\", trate-o antes de planejar em cima dele.\n\n" +
        `ESPECIFICAÇÃO APROVADA:\n${doc.spec}` +
        (pedido.trim() ? `\n\nRESTRIÇÕES ADICIONAIS:\n${pedido}` : "")
      );
    case "tasks":
      return (
        base +
        "Quebre o plano abaixo em TAREFAS executáveis.\n\n" +
        "Formato EXATO, uma tarefa por bloco:\n" +
        "## 1. Título curto\n" +
        "Instrução completa e autocontida — quem executar não verá esta conversa.\n" +
        "Verificação: como saber que ficou pronto (comando, teste ou critério observável).\n\n" +
        "Cada tarefa deve caber em poucos minutos e ser verificável sozinha. Ordene por " +
        "dependência. Não crie tarefa de \"revisar tudo\" — verificação é parte de cada uma.\n\n" +
        `PLANO APROVADO:\n${doc.plan}` +
        (pedido.trim() ? `\n\nRESTRIÇÕES ADICIONAIS:\n${pedido}` : "")
      );
  }
}

/** Prompt do agente que EXECUTA uma tarefa, já com a constituição. */
export function taskPrompt(doc: SpecDoc, task: SpecTask): string {
  return (
    constitutionBlock(doc) +
    `TAREFA: ${task.title}\n\n${task.detail}\n\n` +
    (task.verify
      ? `VERIFICAÇÃO — a tarefa só está pronta quando isto for verdade:\n${task.verify}\n\n`
      : "") +
    "Execute a tarefa e responda com o que foi feito e o resultado da verificação. " +
    "Se não conseguir concluir, diga o que faltou — não declare pronto o que não está."
  );
}

/* ---------------------------- persistência --------------------------- */

export function serializeDoc(doc: SpecDoc): string {
  return JSON.stringify(doc);
}

/** Valida e restaura. `null` se ausente, corrompido ou de outra versão. */
export function parseDoc(json: string | null): SpecDoc | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Partial<SpecDoc>;
    if (raw.schemaVersion !== 1) return null;
    const texto = (value: unknown) => (typeof value === "string" ? value : "");
    const tasks = Array.isArray(raw.tasks)
      ? raw.tasks
          .filter((task): task is SpecTask => Boolean(task) && typeof (task as SpecTask).id === "string")
          .map((task) => ({
            id: task.id,
            title: texto(task.title),
            detail: texto(task.detail),
            verify: texto(task.verify),
            status: (["pending", "running", "done", "failed"] as const).includes(task.status)
              ? task.status
              : ("pending" as const),
            ...(task.report ? { report: texto(task.report) } : {})
          }))
      : [];
    const approved = Array.isArray(raw.approved)
      ? raw.approved.filter((stage): stage is StageId => STAGE_ORDER.includes(stage as StageId))
      : [];
    return {
      schemaVersion: 1,
      name: texto(raw.name) || "Nova feature",
      constitution: texto(raw.constitution),
      spec: texto(raw.spec),
      plan: texto(raw.plan),
      tasks,
      approved,
      updatedAt: typeof raw.updatedAt === "number" ? raw.updatedAt : 0
    };
  } catch {
    return null;
  }
}

/** Documento inteiro em Markdown, para anexar ao card ou ao PR. */
export function toMarkdown(doc: SpecDoc): string {
  const partes = [`# ${doc.name}`];
  if (doc.constitution.trim()) partes.push(`## Constituição\n\n${doc.constitution.trim()}`);
  if (doc.spec.trim()) partes.push(`## Especificação\n\n${doc.spec.trim()}`);
  if (doc.plan.trim()) partes.push(`## Plano técnico\n\n${doc.plan.trim()}`);
  if (doc.tasks.length) {
    const linhas = doc.tasks.map((task, index) => {
      const marca = task.status === "done" ? "x" : " ";
      const verify = task.verify ? `\n  - Verificação: ${task.verify}` : "";
      return `- [${marca}] **${index + 1}. ${task.title}**\n  ${task.detail.replace(/\n/g, "\n  ")}${verify}`;
    });
    partes.push(`## Tarefas\n\n${linhas.join("\n")}`);
  }
  return partes.join("\n\n");
}
