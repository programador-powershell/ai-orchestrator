/**
 * Code mode — o modelo escreve UM programa que combina várias ferramentas.
 *
 * O loop normal gasta uma ida e volta por chamada de ferramenta: para uma
 * tarefa de oito passos, são oito requisições de modelo, cada uma relendo o
 * contexto inteiro. Aqui o modelo escreve o roteiro de uma vez e nós o
 * executamos.
 *
 * ## Por que um interpretador próprio, e não `eval`
 *
 * `eval` ou `new Function` dariam ao texto gerado pelo modelo o **mesmo poder
 * do app**: cofre, sessão, rede, DOM. Isso devolveria de uma vez tudo que a
 * edição `managed` fecha compilando as saídas diretas para fora do binário — e
 * um prompt injetado numa página lida pelo agente passaria a escrever código
 * que roda aqui dentro. Web Worker também não resolve: ele nasce com `fetch`.
 *
 * Então o programa é **analisado e interpretado por este módulo**. O avaliador
 * não tem acesso a nada do host: as únicas coisas que existem para o programa
 * são os valores literais, as variáveis que ele mesmo declarou e as ferramentas
 * que o chamador passou. Não há como alcançar `window`, `globalThis`, `import`
 * ou qualquer objeto do app, porque o interpretador não implementa nenhum
 * caminho até eles.
 *
 * ## O que o subconjunto NÃO tem, de propósito
 *
 * - função definida pelo usuário, `while`, `try` — sem elas, todo laço tem
 *   fim conhecido e não há como esconder recursão;
 * - reatribuição — um nome, um valor; mata a classe inteira de bug de estado;
 * - acesso a índice calculado (`a[expr]`) — a superfície mais comum de
 *   travessia; só campo nomeado.
 *
 * Sobra o que orquestrar ferramentas exige: chamar, guardar, ler campo,
 * percorrer lista, decidir e devolver.
 *
 * ## O gate continua valendo
 *
 * Cada `tool.x()` do programa passa pelo MESMO `needsApproval` de uma chamada
 * avulsa. Code mode não é porta lateral para gravar arquivo sem aprovação — se
 * fosse, seria mais fácil pedir ao modelo para escrever um programa do que
 * pedir a ferramenta direto.
 *
 * Módulo puro: sem rede, sem DOM. Coberto por codeMode.test.ts.
 */

/* ------------------------------- Tokens ------------------------------- */

type TokenKind = "num" | "str" | "name" | "punct" | "eof";

interface Token {
  kind: TokenKind;
  value: string;
  pos: number;
}

const PUNCT = [
  "===",
  "!==",
  ">=",
  "<=",
  "&&",
  "||",
  "{",
  "}",
  "(",
  ")",
  "[",
  "]",
  ",",
  ".",
  ":",
  ";",
  "+",
  "-",
  "*",
  "/",
  ">",
  "<",
  "=",
  "!"
];

export class CodeModeError extends Error {}

export function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const char = source[i];
    if (/\s/.test(char)) {
      i += 1;
      continue;
    }
    // Comentário de linha: o modelo escreve muito, e ignorar é mais barato
    // que recusar o programa inteiro por causa de uma explicação.
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i += 1;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      const fim = char;
      let valor = "";
      i += 1;
      while (i < source.length && source[i] !== fim) {
        if (source[i] === "\\" && i + 1 < source.length) {
          const proximo = source[i + 1];
          valor += proximo === "n" ? "\n" : proximo === "t" ? "\t" : proximo;
          i += 2;
          continue;
        }
        valor += source[i];
        i += 1;
      }
      if (i >= source.length) throw new CodeModeError("texto sem aspas de fechamento");
      i += 1;
      tokens.push({ kind: "str", value: valor, pos: i });
      continue;
    }
    if (/[0-9]/.test(char)) {
      let valor = "";
      while (i < source.length && /[0-9.]/.test(source[i])) {
        valor += source[i];
        i += 1;
      }
      tokens.push({ kind: "num", value: valor, pos: i });
      continue;
    }
    if (/[A-Za-z_$]/.test(char)) {
      let valor = "";
      while (i < source.length && /[A-Za-z0-9_$]/.test(source[i])) {
        valor += source[i];
        i += 1;
      }
      tokens.push({ kind: "name", value: valor, pos: i });
      continue;
    }
    const achado = PUNCT.find((item) => source.startsWith(item, i));
    if (!achado) throw new CodeModeError(`caractere não suportado: ${char}`);
    i += achado.length;
    tokens.push({ kind: "punct", value: achado, pos: i });
  }
  tokens.push({ kind: "eof", value: "", pos: i });
  return tokens;
}

/* -------------------------------- AST -------------------------------- */

export type Expr =
  | { type: "lit"; value: string | number | boolean | null }
  | { type: "ref"; name: string }
  | { type: "member"; target: Expr; field: string }
  | { type: "call"; tool: string; args: Expr }
  | { type: "array"; items: Expr[] }
  | { type: "object"; entries: Array<{ key: string; value: Expr }> }
  | { type: "binary"; op: string; left: Expr; right: Expr }
  | { type: "not"; value: Expr };

export type Stmt =
  | { type: "let"; name: string; value: Expr }
  | { type: "for"; name: string; list: Expr; body: Stmt[] }
  | { type: "if"; test: Expr; then: Stmt[]; else: Stmt[] }
  | { type: "log"; value: Expr }
  | { type: "return"; value: Expr }
  | { type: "expr"; value: Expr };

/* ------------------------------- Parser ------------------------------- */

const RESERVADAS = new Set(["const", "let", "for", "of", "if", "else", "return", "await", "true", "false", "null"]);

class Parser {
  private at = 0;
  constructor(private readonly tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.at];
  }

  private eat(value?: string): Token {
    const token = this.tokens[this.at];
    if (value !== undefined && token.value !== value) {
      throw new CodeModeError(`esperava "${value}" e veio "${token.value || "fim do programa"}"`);
    }
    this.at += 1;
    return token;
  }

  private is(value: string): boolean {
    return this.peek().value === value && this.peek().kind !== "str";
  }

  parseProgram(): Stmt[] {
    const stmts: Stmt[] = [];
    while (this.peek().kind !== "eof") stmts.push(this.parseStmt());
    return stmts;
  }

  private parseBlock(): Stmt[] {
    this.eat("{");
    const stmts: Stmt[] = [];
    while (!this.is("}")) {
      if (this.peek().kind === "eof") throw new CodeModeError("bloco sem chave de fechamento");
      stmts.push(this.parseStmt());
    }
    this.eat("}");
    return stmts;
  }

  private parseStmt(): Stmt {
    if (this.is(";")) {
      this.eat(";");
      return { type: "expr", value: { type: "lit", value: null } };
    }
    if (this.is("const") || this.is("let")) {
      this.eat();
      const nome = this.eat().value;
      if (RESERVADAS.has(nome)) throw new CodeModeError(`"${nome}" é palavra reservada`);
      this.eat("=");
      const value = this.parseExpr();
      if (this.is(";")) this.eat(";");
      return { type: "let", name: nome, value };
    }
    if (this.is("for")) {
      this.eat("for");
      this.eat("(");
      if (this.is("const") || this.is("let")) this.eat();
      const nome = this.eat().value;
      this.eat("of");
      const list = this.parseExpr();
      this.eat(")");
      return { type: "for", name: nome, list, body: this.parseBlock() };
    }
    if (this.is("if")) {
      this.eat("if");
      this.eat("(");
      const test = this.parseExpr();
      this.eat(")");
      const then = this.parseBlock();
      let senao: Stmt[] = [];
      if (this.is("else")) {
        this.eat("else");
        senao = this.is("if") ? [this.parseStmt()] : this.parseBlock();
      }
      return { type: "if", test, then, else: senao };
    }
    if (this.is("return")) {
      this.eat("return");
      const value = this.parseExpr();
      if (this.is(";")) this.eat(";");
      return { type: "return", value };
    }
    if (this.is("log")) {
      this.eat("log");
      const value = this.parseExpr();
      if (this.is(";")) this.eat(";");
      return { type: "log", value };
    }
    const value = this.parseExpr();
    if (this.is(";")) this.eat(";");
    return { type: "expr", value };
  }

  private parseExpr(): Expr {
    return this.parseBinary(0);
  }

  /** Precedência: || < && < comparação < + - < * / */
  private parseBinary(nivel: number): Expr {
    const NIVEIS = [["||"], ["&&"], ["===", "!==", ">", "<", ">=", "<="], ["+", "-"], ["*", "/"]];
    if (nivel >= NIVEIS.length) return this.parseUnary();
    let left = this.parseBinary(nivel + 1);
    while (NIVEIS[nivel].includes(this.peek().value) && this.peek().kind === "punct") {
      const op = this.eat().value;
      const right = this.parseBinary(nivel + 1);
      left = { type: "binary", op, left, right };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.is("!")) {
      this.eat("!");
      return { type: "not", value: this.parseUnary() };
    }
    if (this.is("await")) {
      // `await` é aceito e ignorado: o modelo escreve por hábito, e recusar o
      // programa por causa disso seria pedantismo caro.
      this.eat("await");
      return this.parseUnary();
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let alvo = this.parsePrimary();
    for (;;) {
      if (this.is(".")) {
        this.eat(".");
        const campo = this.eat();
        if (campo.kind !== "name") throw new CodeModeError("depois do ponto vem um nome de campo");
        // `tool.alguma(...)` é a única forma de chamada que existe.
        if (alvo.type === "ref" && alvo.name === "tool" && this.is("(")) {
          this.eat("(");
          const args: Expr = this.is(")") ? { type: "object", entries: [] } : this.parseExpr();
          this.eat(")");
          alvo = { type: "call", tool: campo.value, args };
          continue;
        }
        alvo = { type: "member", target: alvo, field: campo.value };
        continue;
      }
      // Chamada em qualquer outra coisa não existe no subconjunto — recusar
      // aqui é o que impede `algumObjeto.metodo()` de virar caminho novo.
      if (this.is("(")) throw new CodeModeError("só `tool.nome(...)` pode ser chamado");
      if (this.is("[")) throw new CodeModeError("acesso por índice não é suportado; use campo nomeado");
      return alvo;
    }
  }

  private parsePrimary(): Expr {
    const token = this.peek();
    if (token.kind === "num") {
      this.eat();
      return { type: "lit", value: Number(token.value) };
    }
    if (token.kind === "str") {
      this.eat();
      return { type: "lit", value: token.value };
    }
    if (this.is("(")) {
      this.eat("(");
      const dentro = this.parseExpr();
      this.eat(")");
      return dentro;
    }
    if (this.is("[")) {
      this.eat("[");
      const items: Expr[] = [];
      while (!this.is("]")) {
        items.push(this.parseExpr());
        if (this.is(",")) this.eat(",");
      }
      this.eat("]");
      return { type: "array", items };
    }
    if (this.is("{")) {
      this.eat("{");
      const entries: Array<{ key: string; value: Expr }> = [];
      while (!this.is("}")) {
        const chave = this.eat();
        if (chave.kind !== "name" && chave.kind !== "str") throw new CodeModeError("chave de objeto inválida");
        this.eat(":");
        entries.push({ key: chave.value, value: this.parseExpr() });
        if (this.is(",")) this.eat(",");
      }
      this.eat("}");
      return { type: "object", entries };
    }
    if (token.kind === "name") {
      this.eat();
      if (token.value === "true") return { type: "lit", value: true };
      if (token.value === "false") return { type: "lit", value: false };
      if (token.value === "null") return { type: "lit", value: null };
      return { type: "ref", name: token.value };
    }
    throw new CodeModeError(`não entendi "${token.value || "o fim do programa"}"`);
  }
}

export function parseProgram(source: string): Stmt[] {
  return new Parser(tokenize(source)).parseProgram();
}

/* ----------------------------- Avaliação ----------------------------- */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface RunLimits {
  /** Passos totais; impede programa que gira sem sair do lugar. */
  maxSteps: number;
  /** Chamadas de ferramenta; é o teto de CUSTO e de efeito externo. */
  maxCalls: number;
  /** Iterações por laço. */
  maxLoop: number;
}

export const DEFAULT_LIMITS: RunLimits = { maxSteps: 2_000, maxCalls: 25, maxLoop: 100 };

export interface RunOptions {
  /** Executa a ferramenta de verdade — com o MESMO gate de aprovação. */
  call: (tool: string, args: Record<string, Json>) => Promise<Json>;
  /** Ferramentas que o programa pode citar. Fora da lista, recusa. */
  allowed: string[];
  limits?: Partial<RunLimits>;
  signal?: AbortSignal;
}

export interface RunResult {
  ok: boolean;
  /** Valor do `return`, se houve. */
  value: Json;
  logs: string[];
  calls: Array<{ tool: string; args: Record<string, Json> }>;
  steps: number;
  reason?: string;
}

/** Sinal interno do `return` — não é erro. */
class ReturnSignal {
  constructor(readonly value: Json) {}
}

export async function runProgram(source: string, options: RunOptions): Promise<RunResult> {
  const limits = { ...DEFAULT_LIMITS, ...options.limits };
  const logs: string[] = [];
  const calls: RunResult["calls"] = [];
  let steps = 0;

  let stmts: Stmt[];
  try {
    stmts = parseProgram(source);
  } catch (cause) {
    return {
      ok: false,
      value: null,
      logs,
      calls,
      steps: 0,
      reason: cause instanceof Error ? cause.message : String(cause)
    };
  }

  /** Escopo encadeado. Sem reatribuição: declarar de novo é erro. */
  interface Scope {
    vars: Map<string, Json>;
    parent: Scope | null;
  }
  const raiz: Scope = { vars: new Map(), parent: null };

  function lookup(scope: Scope, name: string): Json {
    for (let atual: Scope | null = scope; atual; atual = atual.parent) {
      if (atual.vars.has(name)) return atual.vars.get(name)!;
    }
    throw new CodeModeError(`"${name}" não foi declarado`);
  }

  function tick() {
    steps += 1;
    if (steps > limits.maxSteps) throw new CodeModeError(`o programa passou de ${limits.maxSteps} passos`);
    if (options.signal?.aborted) throw new CodeModeError("execução cancelada");
  }

  async function evalExpr(expr: Expr, scope: Scope): Promise<Json> {
    tick();
    switch (expr.type) {
      case "lit":
        return expr.value;
      case "ref":
        return lookup(scope, expr.name);
      case "member": {
        const alvo = await evalExpr(expr.target, scope);
        if (Array.isArray(alvo)) {
          if (expr.field === "length") return alvo.length;
          throw new CodeModeError(`lista não tem campo "${expr.field}"`);
        }
        if (alvo && typeof alvo === "object") {
          // `Object.hasOwn` evita herdar `constructor`/`__proto__` — o caminho
          // clássico para sair de um sandbox de objeto.
          return Object.hasOwn(alvo, expr.field) ? (alvo as Record<string, Json>)[expr.field] : null;
        }
        if (typeof alvo === "string" && expr.field === "length") return alvo.length;
        return null;
      }
      case "array": {
        const saida: Json[] = [];
        for (const item of expr.items) saida.push(await evalExpr(item, scope));
        return saida;
      }
      case "object": {
        const saida: Record<string, Json> = {};
        for (const entry of expr.entries) {
          if (entry.key === "__proto__" || entry.key === "constructor" || entry.key === "prototype") {
            throw new CodeModeError(`chave "${entry.key}" não é permitida`);
          }
          saida[entry.key] = await evalExpr(entry.value, scope);
        }
        return saida;
      }
      case "not":
        return !truthy(await evalExpr(expr.value, scope));
      case "binary": {
        const left = await evalExpr(expr.left, scope);
        if (expr.op === "&&") return truthy(left) ? await evalExpr(expr.right, scope) : left;
        if (expr.op === "||") return truthy(left) ? left : await evalExpr(expr.right, scope);
        const right = await evalExpr(expr.right, scope);
        return applyBinary(expr.op, left, right);
      }
      case "call": {
        if (!options.allowed.includes(expr.tool)) {
          throw new CodeModeError(`a ferramenta "${expr.tool}" não está liberada`);
        }
        if (calls.length >= limits.maxCalls) {
          throw new CodeModeError(`o programa passou de ${limits.maxCalls} chamadas de ferramenta`);
        }
        const args = await evalExpr(expr.args, scope);
        if (!args || typeof args !== "object" || Array.isArray(args)) {
          throw new CodeModeError(`"${expr.tool}" espera um objeto de argumentos`);
        }
        const registro = { tool: expr.tool, args: args as Record<string, Json> };
        calls.push(registro);
        return await options.call(registro.tool, registro.args);
      }
    }
  }

  async function runBlock(block: Stmt[], scope: Scope): Promise<void> {
    for (const stmt of block) {
      tick();
      switch (stmt.type) {
        case "let": {
          if (scope.vars.has(stmt.name)) throw new CodeModeError(`"${stmt.name}" já foi declarado`);
          scope.vars.set(stmt.name, await evalExpr(stmt.value, scope));
          break;
        }
        case "log":
          logs.push(stringify(await evalExpr(stmt.value, scope)));
          break;
        case "return":
          throw new ReturnSignal(await evalExpr(stmt.value, scope));
        case "expr":
          await evalExpr(stmt.value, scope);
          break;
        case "if": {
          const test = await evalExpr(stmt.test, scope);
          await runBlock(truthy(test) ? stmt.then : stmt.else, { vars: new Map(), parent: scope });
          break;
        }
        case "for": {
          const lista = await evalExpr(stmt.list, scope);
          if (!Array.isArray(lista)) throw new CodeModeError("só dá para percorrer uma lista");
          if (lista.length > limits.maxLoop) {
            throw new CodeModeError(`a lista tem ${lista.length} itens, acima do teto de ${limits.maxLoop}`);
          }
          for (const item of lista) {
            const filho: Scope = { vars: new Map([[stmt.name, item]]), parent: scope };
            await runBlock(stmt.body, filho);
          }
          break;
        }
      }
    }
  }

  try {
    await runBlock(stmts, raiz);
    return { ok: true, value: null, logs, calls, steps };
  } catch (cause) {
    if (cause instanceof ReturnSignal) {
      return { ok: true, value: cause.value, logs, calls, steps };
    }
    return {
      ok: false,
      value: null,
      logs,
      calls,
      steps,
      reason: cause instanceof Error ? cause.message : String(cause)
    };
  }
}

function truthy(value: Json): boolean {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return true;
  return Boolean(value);
}

function applyBinary(op: string, left: Json, right: Json): Json {
  switch (op) {
    case "+":
      // Texto concatena, número soma — mesma regra que o modelo já espera.
      if (typeof left === "string" || typeof right === "string") return `${stringify(left)}${stringify(right)}`;
      return num(left) + num(right);
    case "-":
      return num(left) - num(right);
    case "*":
      return num(left) * num(right);
    case "/":
      // Divisão por zero devolveria Infinity, que não é JSON.
      if (num(right) === 0) throw new CodeModeError("divisão por zero");
      return num(left) / num(right);
    case "===":
      return stringify(left) === stringify(right);
    case "!==":
      return stringify(left) !== stringify(right);
    case ">":
      return num(left) > num(right);
    case "<":
      return num(left) < num(right);
    case ">=":
      return num(left) >= num(right);
    case "<=":
      return num(left) <= num(right);
    default:
      throw new CodeModeError(`operador "${op}" não é suportado`);
  }
}

function num(value: Json): number {
  const convertido = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(convertido)) throw new CodeModeError("esperava um número");
  return convertido;
}

function stringify(value: Json): string {
  if (typeof value === "string") return value;
  if (value === null) return "null";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Instrução do code mode para o prompt.
 *
 * A lista de ferramentas é montada a partir do que o chamador liberou — dizer
 * ao modelo o que existe evita o desperdício de um programa inteiro recusado
 * por citar ferramenta que não está na lista.
 */
export function codeModeInstruction(allowed: string[], limits: RunLimits = DEFAULT_LIMITS): string {
  return [
    "MODO PROGRAMA: em vez de pedir uma ferramenta por vez, escreva UM programa que combina as chamadas.",
    "",
    "A linguagem é um subconjunto pequeno de JavaScript, interpretado aqui — não é Node nem navegador:",
    "- `const x = tool.nome({ campo: valor })` chama uma ferramenta;",
    "- `for (const item of lista) { … }`, `if (…) { … } else { … }`;",
    "- `log expressão` registra; `return expressão` encerra e devolve;",
    "- campo por nome (`a.b`), `.length` em lista e texto;",
    "- NÃO existem: função própria, `while`, reatribuição, `a[i]`, import, rede ou qualquer objeto do app.",
    "",
    `Ferramentas liberadas: ${allowed.join(", ") || "nenhuma"}.`,
    `Tetos: ${limits.maxCalls} chamadas, ${limits.maxLoop} itens por laço.`,
    "Cada chamada continua pedindo aprovação de quem usa, como se fosse avulsa.",
    "Responda apenas com o programa, sem cerca de markdown."
  ].join("\n");
}
