/**
 * O rodapé promete uma máquina. Quando a máquina não está lá, o motivo tem de
 * viajar junto — é ele, e não a palavra "indisponível", que diz o que fazer.
 */

import { describe, expect, it } from "vitest";
import type { EnvironmentInfo } from "@aibot/contracts";
import { environmentInfo, environmentTitle, FALLBACK_ENVIRONMENTS } from "./environments";

const DOCKER_OFF: EnvironmentInfo = {
  id: "docker",
  label: "Docker",
  hint: "Sandbox do Docker (sbx), isolado do seu disco",
  available: false,
  detail: "o Docker Sandboxes não está instalado — instale o Docker Desktop e o sbx"
};

describe("environmentTitle", () => {
  it("leva o motivo do gateway para a dica do crachá", () => {
    const title = environmentTitle(DOCKER_OFF);
    expect(title).toContain("instale o Docker Desktop e o sbx");
    expect(title).toContain("Docker");
  });

  it("não inventa motivo quando o ambiente está de pé", () => {
    const local = environmentInfo(FALLBACK_ENVIRONMENTS, "local");
    expect(environmentTitle(local)).toBe(
      "o próximo comando roda em: Local — No seu computador"
    );
    expect(environmentTitle(local)).not.toContain("indisponível");
  });

  it("diz que o motivo faltou em vez de calar", () => {
    // Gateway antigo, que marca `available: false` sem explicar. Ficar em
    // silêncio aqui devolveria o crachá ao problema original.
    const { detail: _ignored, ...semMotivo } = DOCKER_OFF;
    expect(environmentTitle(semMotivo)).toContain("o gateway não disse o motivo");
  });
});
