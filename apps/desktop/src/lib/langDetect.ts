/**
 * Ultra-terminal: detecção automática de linguagem de programação
 * (inspirado em programador-powershell/ultra-terminal).
 *
 * Três estratégias, na ordem: extensão de arquivo → shebang → heurística de
 * conteúdo. Devolve também o comando REAL de execução no Windows para o
 * runtime correspondente. Puro e testável.
 */

export interface DetectedLanguage {
  language: string;
  /** Extensão canônica usada para arquivos temporários. */
  extension: string;
  /** Monta o comando real de execução; null = sem runner direto. */
  run: ((file: string) => string) | null;
  /** Origem da detecção (extensão, shebang, conteúdo). */
  via: "extension" | "shebang" | "content";
}

interface LanguageSpec {
  language: string;
  extension: string;
  extensions: string[];
  shebangs: string[];
  /** Padrões distintivos de conteúdo (avaliados em ordem de especificidade). */
  patterns: RegExp[];
  run: ((file: string) => string) | null;
}

const q = (file: string) => (/\s/.test(file) ? `"${file}"` : file);

const SPECS: LanguageSpec[] = [
  {
    language: "python",
    extension: "py",
    extensions: ["py"],
    shebangs: ["python"],
    patterns: [/^\s*def\s+\w+\s*\(.*\)\s*:/m, /^\s*from\s+[\w.]+\s+import\s+/m, /^\s*import\s+\w+\s*$/m, /print\(/],
    run: (file) => `python ${q(file)}`
  },
  {
    language: "typescript",
    extension: "ts",
    extensions: ["ts", "mts", "tsx"],
    shebangs: ["ts-node", "tsx"],
    patterns: [/:\s*(string|number|boolean)\b/, /interface\s+\w+\s*\{/, /export\s+(type|interface)\s/],
    // Node 24 executa TypeScript nativamente (type stripping).
    run: (file) => `node ${q(file)}`
  },
  {
    language: "javascript",
    extension: "js",
    extensions: ["js", "mjs", "cjs", "jsx"],
    shebangs: ["node"],
    patterns: [/\bconsole\.log\(/, /\b(const|let)\s+\w+\s*=\s*require\(/, /=>\s*\{/, /module\.exports/],
    run: (file) => `node ${q(file)}`
  },
  {
    language: "go",
    extension: "go",
    extensions: ["go"],
    shebangs: [],
    patterns: [/^\s*package\s+main\b/m, /\bfunc\s+main\s*\(\s*\)/, /\bfmt\.Print/],
    run: (file) => `go run ${q(file)}`
  },
  {
    language: "rust",
    extension: "rs",
    extensions: ["rs"],
    shebangs: [],
    patterns: [/\bfn\s+main\s*\(\s*\)/, /\blet\s+mut\s+\w+/, /println!\s*\(/],
    run: (file) => `rustc ${q(file)} -o ultra_tmp.exe && ultra_tmp.exe`
  },
  {
    language: "java",
    extension: "java",
    extensions: ["java"],
    shebangs: [],
    patterns: [/public\s+static\s+void\s+main\s*\(/, /System\.out\.println/],
    // Java 11+ executa arquivo único direto.
    run: (file) => `java ${q(file)}`
  },
  {
    language: "csharp",
    extension: "cs",
    extensions: ["cs"],
    shebangs: [],
    patterns: [/using\s+System\s*;/, /namespace\s+\w+/, /Console\.WriteLine/],
    // dotnet 10+ roda arquivo único (dotnet run file.cs); em versões antigas exige projeto.
    run: (file) => `dotnet run ${q(file)}`
  },
  {
    language: "php",
    extension: "php",
    extensions: ["php"],
    shebangs: ["php"],
    patterns: [/<\?php/],
    run: (file) => `php ${q(file)}`
  },
  {
    language: "ruby",
    extension: "rb",
    extensions: ["rb"],
    shebangs: ["ruby"],
    patterns: [/\bputs\s+["']/, /^\s*def\s+\w+\s*$/m, /\bend\s*$/m],
    run: (file) => `ruby ${q(file)}`
  },
  {
    language: "powershell",
    extension: "ps1",
    extensions: ["ps1", "psm1"],
    shebangs: ["pwsh", "powershell"],
    patterns: [/Write-Host\b/i, /\$\w+\s*=\s*/, /Get-\w+/],
    run: (file) => `powershell -NoProfile -ExecutionPolicy Bypass -File ${q(file)}`
  },
  {
    language: "bash",
    extension: "sh",
    extensions: ["sh", "bash"],
    shebangs: ["bash", "sh"],
    patterns: [/^\s*echo\s+/m, /\bfi\s*$/m, /^\s*#!\s*\/bin\//m],
    run: (file) => `bash ${q(file)}`
  },
  {
    language: "sql",
    extension: "sql",
    extensions: ["sql"],
    shebangs: [],
    patterns: [/\bSELECT\b[\s\S]+\bFROM\b/i, /\bCREATE\s+TABLE\b/i, /\bINSERT\s+INTO\b/i],
    // Sem servidor alvo não há runner direto — a aba Data importa/exporta SQL.
    run: null
  }
];

/** Detecta pela extensão de um caminho de arquivo (ex.: "src/main.py"). */
export function detectByFileName(path: string): DetectedLanguage | null {
  const clean = path.trim().replace(/^["']|["']$/g, "");
  const match = /\.([a-z0-9]+)$/i.exec(clean);
  if (!match) return null;
  const extension = match[1].toLowerCase();
  const spec = SPECS.find((item) => item.extensions.includes(extension));
  if (!spec) return null;
  return { language: spec.language, extension: spec.extension, run: spec.run, via: "extension" };
}

/** Detecta pelo shebang da primeira linha. */
export function detectByShebang(source: string): DetectedLanguage | null {
  const first = source.split("\n", 1)[0] ?? "";
  if (!first.startsWith("#!")) return null;
  const spec = SPECS.find((item) => item.shebangs.some((shebang) => first.includes(shebang)));
  if (!spec) return null;
  return { language: spec.language, extension: spec.extension, run: spec.run, via: "shebang" };
}

/** Heurística de conteúdo: pontua padrões distintivos por linguagem. */
export function detectByContent(source: string): DetectedLanguage | null {
  if (!source.trim()) return null;
  let best: { spec: LanguageSpec; score: number } | null = null;
  for (const spec of SPECS) {
    let score = 0;
    for (const [index, pattern] of spec.patterns.entries()) {
      if (pattern.test(source)) score += spec.patterns.length - index;
    }
    if (score > 0 && (!best || score > best.score)) best = { spec, score };
  }
  if (!best) return null;
  return { language: best.spec.language, extension: best.spec.extension, run: best.spec.run, via: "content" };
}

/**
 * Detecção completa estilo ultra-terminal:
 * caminho de arquivo → extensão; senão shebang; senão conteúdo.
 */
export function detectLanguage(input: string): DetectedLanguage | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Uma linha única sem quebras que termina em extensão conhecida = arquivo.
  if (!trimmed.includes("\n")) {
    const byFile = detectByFileName(trimmed);
    if (byFile) return byFile;
  }
  return detectByShebang(trimmed) ?? detectByContent(trimmed);
}

/**
 * Um input de linha única "parece" um arquivo executável direto?
 * Sem quebras de linha; caminhos com espaço precisam vir entre aspas.
 */
export function isRunnableFileInput(input: string): boolean {
  const trimmed = input.trim();
  if (!trimmed || trimmed.includes("\n")) return false;
  const quoted = /^["'](.+)["']$/.exec(trimmed);
  const path = quoted ? quoted[1] : trimmed;
  if (!quoted && /\s/.test(path)) return false;
  return detectByFileName(path) !== null;
}
