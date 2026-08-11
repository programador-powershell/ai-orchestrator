/**
 * E2E REAL: lockfile real deste repo + API OSV.dev de verdade.
 * O teste de rede só roda com OSV_E2E=1 (CI permanece sem dependência de rede);
 * o parse do lockfile real roda sempre.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePnpmLock, queryOsv } from "./osv";

describe("OSV e2e com dados reais", () => {
  it("parseia o pnpm-lock.yaml real do repositório", () => {
    const lock = readFileSync(resolve(__dirname, "../../../../pnpm-lock.yaml"), "utf8");
    const packages = parsePnpmLock(lock);
    expect(packages.length).toBeGreaterThan(30);
    const names = packages.map((entry) => entry.name);
    expect(names).toContain("zustand");
    expect(names).toContain("react");
    const react = packages.find((entry) => entry.name === "react");
    expect(react?.version).toMatch(/^\d+\.\d+\.\d+/);
  });

  it.runIf(process.env.OSV_E2E === "1")("consulta a API OSV real (controle vulnerável + pacotes do repo)", async () => {
    const lock = readFileSync(resolve(__dirname, "../../../../pnpm-lock.yaml"), "utf8");
    const sample = parsePnpmLock(lock).slice(0, 30);
    const control = { name: "lodash", version: "4.17.15", ecosystem: "npm" as const };
    const audits = await queryOsv([...sample, control], fetch);
    const lodash = audits.find((audit) => audit.name === "lodash");
    expect(lodash).toBeDefined();
    expect(lodash!.vulns.length).toBeGreaterThan(0);
    expect(lodash!.vulns[0].id).toMatch(/^(GHSA|CVE|MAL)-/);
    expect(lodash!.vulns[0].link).toContain("osv.dev/vulnerability/");
    expect(lodash!.vulns.some((vuln) => vuln.enriched && vuln.summary.length > 0)).toBe(true);
  }, 60_000);
});
