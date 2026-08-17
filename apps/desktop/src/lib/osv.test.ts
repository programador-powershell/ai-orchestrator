import { describe, expect, it } from "vitest";
import {
  buildFixPrompt,
  cvssBaseScore,
  deriveSeverity,
  detectLockfile,
  parseLockfile,
  parsePackageLock,
  parsePnpmLock,
  queryOsv,
  severityFromScore,
  worstSeverity,
  type PackageAudit,
  type PackageRef
} from "./osv";

/* ------------------------------------------------------------------ */
/* Fixture: trechos REAIS copiados de pnpm-lock.yaml deste repositório  */
/* (lockfileVersion 9.0 — importers, packages e snapshots).             */
/* ------------------------------------------------------------------ */
const PNPM_LOCK_V9_FIXTURE = `lockfileVersion: '9.0'

settings:
  autoInstallPeers: true
  excludeLinksFromLockfile: false

importers:

  .: {}

  apps/desktop:
    dependencies:
      '@ai-bot/contracts':
        specifier: workspace:*
        version: link:../../packages/contracts
      '@tauri-apps/api':
        specifier: ^2.8.0
        version: 2.11.1
      lucide-react:
        specifier: ^0.468.0
        version: 0.468.0(react@19.2.8)
      react:
        specifier: ^19.1.1
        version: 19.2.8
      zustand:
        specifier: ^5.0.14
        version: 5.0.14(@types/react@19.2.18)(react@19.2.8)
    devDependencies:
      typescript:
        specifier: ^5.9.2
        version: 5.9.3

packages:

  '@babel/code-frame@7.29.7':
    resolution: {integrity: sha512-Aup7aUOfpbAUg2ROOJN6Iw5f9DMBlzu0mIkm/malLQFN/YQgO48wCj0Kxa3sEHJvPVFg7siR+qRInwXd2qhQKw==}
    engines: {node: '>=6.9.0'}

  react@19.2.8:
    resolution: {integrity: sha512-x1ix.fake==}
    engines: {node: '>=0.10.0'}

  w3c-keyname@2.2.8:
    resolution: {integrity: sha512-fake==}

snapshots:

  '@vitejs/plugin-react@4.7.0(vite@7.3.6)':
    dependencies:
      '@babel/core': 7.29.7
      vite: 7.3.6

  react-dom@19.2.8(react@19.2.8):
    dependencies:
      react: 19.2.8
      scheduler: 0.27.0

  w3c-keyname@2.2.8: {}

  zustand@5.0.14(@types/react@19.2.18)(react@19.2.8):
    optionalDependencies:
      '@types/react': 19.2.18
      react: 19.2.8
`;

describe("parsePnpmLock (formato v9 real deste repo)", () => {
  const packages = parsePnpmLock(PNPM_LOCK_V9_FIXTURE);
  const key = (pkg: PackageRef) => `${pkg.name}@${pkg.version}`;
  const keys = packages.map(key);

  it("extrai dependências de importer em duas linhas (nome → version:)", () => {
    expect(keys).toContain("@tauri-apps/api@2.11.1");
    expect(keys).toContain("typescript@5.9.3");
  });

  it("descarta sufixos de peer em versões de importer", () => {
    expect(keys).toContain("lucide-react@0.468.0");
    expect(keys).toContain("zustand@5.0.14");
    expect(keys.some((entry) => entry.includes("("))).toBe(false);
  });

  it("extrai chaves de packages: e snapshots: (com e sem peers, com '{}')", () => {
    expect(keys).toContain("@babel/code-frame@7.29.7");
    expect(keys).toContain("@vitejs/plugin-react@4.7.0");
    expect(keys).toContain("react-dom@19.2.8");
    expect(keys).toContain("w3c-keyname@2.2.8");
  });

  it("extrai dependências em linha única dos snapshots", () => {
    expect(keys).toContain("scheduler@0.27.0");
    expect(keys).toContain("vite@7.3.6");
    expect(keys).toContain("@types/react@19.2.18");
  });

  it("ignora links de workspace e chaves reservadas, e deduplica", () => {
    expect(keys.some((entry) => entry.startsWith("@ai-bot/contracts"))).toBe(false);
    expect(keys.filter((entry) => entry === "react@19.2.8")).toHaveLength(1);
    expect(keys).not.toContain("specifier");
    expect(keys.some((entry) => entry.startsWith("version@"))).toBe(false);
  });

  it("todos os itens têm ecosystem npm e versão concreta", () => {
    for (const pkg of packages) {
      expect(pkg.ecosystem).toBe("npm");
      expect(pkg.version).toMatch(/^\d+\.\d+\.\d+/);
    }
  });
});

describe("parsePnpmLock (formatos antigos v6/v5)", () => {
  it("aceita chaves '/nome@versão(peer):' do v6", () => {
    const text = "packages:\n\n  /lodash@4.17.15:\n    resolution: {integrity: sha512-x==}\n\n  /react-dom@18.2.0(react@18.2.0):\n    resolution: {integrity: sha512-y==}\n";
    const keys = parsePnpmLock(text).map((pkg) => `${pkg.name}@${pkg.version}`);
    expect(keys).toContain("lodash@4.17.15");
    expect(keys).toContain("react-dom@18.2.0");
  });

  it("aceita chaves '/nome/1.2.3:' do v5", () => {
    const keys = parsePnpmLock("packages:\n\n  /minimist/1.2.5:\n    resolution: {integrity: sha512-z==}\n").map(
      (pkg) => `${pkg.name}@${pkg.version}`
    );
    expect(keys).toEqual(["minimist@1.2.5"]);
  });
});

describe("parsePackageLock", () => {
  const V3_LOCK = JSON.stringify({
    name: "app",
    lockfileVersion: 3,
    packages: {
      "": { name: "app", version: "1.0.0" },
      "node_modules/lodash": { version: "4.17.15" },
      "node_modules/@babel/core": { version: "7.23.0" },
      "node_modules/a/node_modules/b": { version: "2.0.0" },
      "node_modules/linked": { link: true, resolved: "../linked" },
      "node_modules/sem-versao": {}
    }
  });

  it("extrai packages{} do v2/v3 inclusive aninhados, sem o projeto raiz", () => {
    const keys = parsePackageLock(V3_LOCK).map((pkg) => `${pkg.name}@${pkg.version}`);
    expect(keys).toContain("lodash@4.17.15");
    expect(keys).toContain("@babel/core@7.23.0");
    expect(keys).toContain("b@2.0.0");
    expect(keys).toHaveLength(3); // raiz, link e sem versão ficam de fora
  });

  it("cai para a árvore dependencies{} do lockfileVersion 1", () => {
    const v1 = JSON.stringify({
      lockfileVersion: 1,
      dependencies: {
        lodash: { version: "4.17.15", dependencies: { minimist: { version: "1.2.5" } } }
      }
    });
    const keys = parsePackageLock(v1).map((pkg) => `${pkg.name}@${pkg.version}`);
    expect(keys).toEqual(["lodash@4.17.15", "minimist@1.2.5"]);
  });

  it("devolve vazio para JSON inválido", () => {
    expect(parsePackageLock("{quebrado")).toEqual([]);
  });
});

describe("detectLockfile / parseLockfile", () => {
  it("detecta package-lock, pnpm-lock e desconhecido", () => {
    expect(detectLockfile('{"lockfileVersion":3,"packages":{}}')).toBe("package-lock");
    expect(detectLockfile(PNPM_LOCK_V9_FIXTURE)).toBe("pnpm-lock");
    expect(detectLockfile("texto qualquer")).toBe("unknown");
    expect(detectLockfile("{}")).toBe("unknown");
  });

  it("parseLockfile despacha para o parser certo", () => {
    const pnpm = parseLockfile(PNPM_LOCK_V9_FIXTURE);
    expect(pnpm.kind).toBe("pnpm-lock");
    expect(pnpm.packages.length).toBeGreaterThan(5);
    const unknown = parseLockfile("nada a ver");
    expect(unknown).toEqual({ kind: "unknown", packages: [] });
  });
});

describe("cvssBaseScore (base score oficial CVSS 3.x)", () => {
  it("calcula vetores conhecidos", () => {
    expect(cvssBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBe(9.8);
    expect(cvssBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:C/C:H/I:H/A:H")).toBe(10);
    expect(cvssBaseScore("CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N")).toBe(6.1);
    expect(cvssBaseScore("CVSS:3.0/AV:N/AC:L/PR:N/UI:N/S:U/C:N/I:N/A:N")).toBe(0);
  });

  it("rejeita vetores inválidos ou de outras versões", () => {
    expect(cvssBaseScore("CVSS:4.0/AV:N/AC:L")).toBeNull();
    expect(cvssBaseScore("CVSS:3.1/AV:X/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H")).toBeNull();
    expect(cvssBaseScore("qualquer coisa")).toBeNull();
  });

  it("severityFromScore segue as faixas CVSS", () => {
    expect(severityFromScore(9.8)).toBe("critical");
    expect(severityFromScore(7.4)).toBe("high");
    expect(severityFromScore(5.3)).toBe("medium");
    expect(severityFromScore(2.1)).toBe("low");
  });
});

describe("deriveSeverity", () => {
  it("prefere o vetor CVSS 3.x e devolve o score", () => {
    const derived = deriveSeverity({
      severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" }],
      database_specific: { severity: "LOW" }
    });
    expect(derived).toEqual({ severity: "critical", score: 9.8 });
  });

  it("cai para database_specific.severity (GHSA)", () => {
    expect(deriveSeverity({ database_specific: { severity: "MODERATE" } }).severity).toBe("medium");
    expect(deriveSeverity({ database_specific: { severity: "HIGH" } }).severity).toBe("high");
  });

  it("sem informação → unknown", () => {
    expect(deriveSeverity({}).severity).toBe("unknown");
  });
});

/* ------------------------------------------------------------------ */
/* queryOsv com fetch mockado (a chamada real é validada no navegador)  */
/* ------------------------------------------------------------------ */

const LODASH_DETAIL = {
  id: "GHSA-p6mc-m468-83gw",
  summary: "Prototype Pollution in lodash",
  aliases: ["CVE-2020-8203"],
  severity: [{ type: "CVSS_V3", score: "CVSS:3.1/AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:H/A:H" }],
  database_specific: { severity: "HIGH" },
  affected: [
    {
      package: { ecosystem: "npm", name: "lodash" },
      ranges: [{ type: "SEMVER", events: [{ introduced: "3.7.0" }, { fixed: "4.17.19" }] }]
    }
  ]
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function makeFetchMock(handler: (url: string, init?: RequestInit) => Response) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    calls.push({ url, init });
    return handler(url, init);
  }) as typeof fetch;
  return { impl, calls };
}

describe("queryOsv", () => {
  const lodash: PackageRef = { name: "lodash", version: "4.17.15", ecosystem: "npm" };
  const react: PackageRef = { name: "react", version: "19.2.8", ecosystem: "npm" };

  it("consulta em lote, exclui pacotes limpos e enriquece com GET /v1/vulns", async () => {
    const { impl, calls } = makeFetchMock((url) => {
      if (url.endsWith("/v1/querybatch")) {
        return jsonResponse({ results: [{ vulns: [{ id: "GHSA-p6mc-m468-83gw" }] }, {}] });
      }
      if (url.includes("/v1/vulns/GHSA-p6mc-m468-83gw")) return jsonResponse(LODASH_DETAIL);
      return jsonResponse({}, 404);
    });

    const audits = await queryOsv([lodash, react], impl);
    expect(audits).toHaveLength(1);
    expect(audits[0].name).toBe("lodash");
    expect(audits[0].vulns).toHaveLength(1);

    const vuln = audits[0].vulns[0];
    expect(vuln.link).toBe("https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw");
    expect(vuln.summary).toBe("Prototype Pollution in lodash");
    expect(vuln.severity).toBe("high"); // CVSS:3.1 AV:N/AC:H/.../I:H/A:H = 7.4
    expect(vuln.score).toBe(7.4);
    expect(vuln.fixed).toBe("4.17.19");
    expect(vuln.aliases).toContain("CVE-2020-8203");
    expect(vuln.enriched).toBe(true);

    // corpo do querybatch segue o contrato da API
    const body = JSON.parse(String(calls[0].init?.body)) as {
      queries: Array<{ package: { name: string; ecosystem: string }; version: string }>;
    };
    expect(body.queries).toHaveLength(2);
    expect(body.queries[0]).toEqual({ package: { name: "lodash", ecosystem: "npm" }, version: "4.17.15" });
  });

  it("divide em lotes de 100 e deduplica a entrada", async () => {
    const { impl, calls } = makeFetchMock((url) => {
      if (url.endsWith("/v1/querybatch")) {
        const body = JSON.parse("[]");
        void body;
        return jsonResponse({ results: [] });
      }
      return jsonResponse({}, 404);
    });
    const many: PackageRef[] = Array.from({ length: 130 }, (_, index) => ({
      name: `pacote-${index}`,
      version: "1.0.0",
      ecosystem: "npm"
    }));
    // duplicata não deve gerar consulta extra
    await queryOsv([...many, many[0]], impl);
    const batchCalls = calls.filter((call) => call.url.endsWith("/v1/querybatch"));
    expect(batchCalls).toHaveLength(2);
    const first = JSON.parse(String(batchCalls[0].init?.body)) as { queries: unknown[] };
    const second = JSON.parse(String(batchCalls[1].init?.body)) as { queries: unknown[] };
    expect(first.queries).toHaveLength(100);
    expect(second.queries).toHaveLength(30);
  });

  it("propaga erro HTTP do querybatch", async () => {
    const { impl } = makeFetchMock(() => jsonResponse({}, 503));
    await expect(queryOsv([lodash], impl)).rejects.toThrow(/HTTP 503/);
  });

  it("falha no GET de detalhe não invalida a auditoria (fica unknown)", async () => {
    const { impl } = makeFetchMock((url) => {
      if (url.endsWith("/v1/querybatch")) {
        return jsonResponse({ results: [{ vulns: [{ id: "GHSA-xxxx-yyyy-zzzz" }] }] });
      }
      return jsonResponse({}, 500);
    });
    const audits = await queryOsv([lodash], impl);
    expect(audits).toHaveLength(1);
    expect(audits[0].vulns[0].enriched).toBe(false);
    expect(audits[0].vulns[0].severity).toBe("unknown");
  });

  it("respeita detailLimit e ordena por pior severidade", async () => {
    const { impl, calls } = makeFetchMock((url) => {
      if (url.endsWith("/v1/querybatch")) {
        return jsonResponse({
          results: [
            { vulns: [{ id: "GHSA-aaaa-aaaa-aaaa" }] },
            { vulns: [{ id: "GHSA-p6mc-m468-83gw" }] }
          ]
        });
      }
      if (url.includes("GHSA-p6mc-m468-83gw")) return jsonResponse(LODASH_DETAIL);
      if (url.includes("GHSA-aaaa-aaaa-aaaa")) {
        return jsonResponse({ id: "GHSA-aaaa-aaaa-aaaa", summary: "leve", database_specific: { severity: "LOW" } });
      }
      return jsonResponse({}, 404);
    });

    const audits = await queryOsv([react, lodash], impl, { detailLimit: 10 });
    // lodash (high) vem antes de react (low)
    expect(audits.map((audit) => audit.name)).toEqual(["lodash", "react"]);
    expect(worstSeverity(audits[0])).toBe("high");

    const detailCalls = calls.filter((call) => call.url.includes("/v1/vulns/"));
    expect(detailCalls).toHaveLength(2);

    // com detailLimit 0, nenhum GET de detalhe acontece
    const { impl: impl2, calls: calls2 } = makeFetchMock((url) =>
      url.endsWith("/v1/querybatch")
        ? jsonResponse({ results: [{ vulns: [{ id: "GHSA-aaaa-aaaa-aaaa" }] }] })
        : jsonResponse({}, 404)
    );
    await queryOsv([lodash], impl2, { detailLimit: 0 });
    expect(calls2.filter((call) => call.url.includes("/v1/vulns/"))).toHaveLength(0);
  });
});

describe("buildFixPrompt", () => {
  it("monta prompt real com pacote, advisories e versão corrigida", () => {
    const audits: PackageAudit[] = [
      {
        name: "lodash",
        version: "4.17.15",
        ecosystem: "npm",
        vulns: [
          {
            id: "GHSA-p6mc-m468-83gw",
            summary: "Prototype Pollution in lodash",
            severity: "high",
            score: 7.4,
            link: "https://osv.dev/vulnerability/GHSA-p6mc-m468-83gw",
            fixed: "4.17.19",
            aliases: ["CVE-2020-8203"],
            enriched: true
          }
        ]
      }
    ];
    const prompt = buildFixPrompt(audits, "pnpm-lock.yaml");
    expect(prompt).toContain("pnpm-lock.yaml");
    expect(prompt).toContain("lodash@4.17.15");
    expect(prompt).toContain("GHSA-p6mc-m468-83gw");
    expect(prompt).toContain("Corrigido em: 4.17.19");
    expect(prompt).toContain("pior severidade: high");
    expect(prompt).toContain("Proponha o plano de atualização");
  });
});
