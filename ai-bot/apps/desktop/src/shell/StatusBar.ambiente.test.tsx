/**
 * O rodapé honesto da jaula.
 *
 * Desde que o sandbox virou o padrão do turno de trabalho, o crachá que
 * mostrava só o ambiente ativo MENTIA: escrevia "Local" enquanto o proc.run
 * do turno ia para o container. Aqui se fixa o contrato: sem escolha
 * explícita e com o Docker são, o crachá diz "auto (sandbox)"; fixado um
 * ambiente, volta a dizer o fixado; e sem sandbox nesta máquina, o rótulo de
 * sempre continua — não há jaula para anunciar.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { EnvironmentInfo } from "@aibot/contracts";
import { initialAppData, useApp } from "../lib/store";
import { EnvBadge } from "./StatusBar";

declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  act(() => {
    root = createRoot(container);
  });
  useApp.setState(initialAppData());
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
  globalThis.IS_REACT_ACT_ENVIRONMENT = undefined;
});

function monta() {
  act(() => {
    root.render(<EnvBadge />);
  });
}

/** Catálogo medido COM o sandbox são — a condição que liga a jaula por padrão. */
const COM_SANDBOX: EnvironmentInfo[] = [
  { id: "local", label: "Local", hint: "No seu computador", available: true },
  { id: "docker", label: "Docker", hint: "Sandbox do Docker (sbx)", available: true }
];

/** Catálogo sem o Docker: não há jaula, não há "auto" para anunciar. */
const SEM_SANDBOX: EnvironmentInfo[] = [
  { id: "local", label: "Local", hint: "No seu computador", available: true },
  {
    id: "docker",
    label: "Docker",
    hint: "Sandbox do Docker (sbx)",
    available: false,
    detail: "instale o Docker Desktop e o sbx"
  }
];

describe("o crachá de ambiente", () => {
  it("sem escolha explícita e com sandbox são, diz auto (sandbox)", () => {
    useApp.setState({ environment: "local", environmentChosen: false, environments: COM_SANDBOX });
    monta();

    const botao = container.querySelector(".envbadge-button");
    expect(botao?.textContent).toBe("auto (sandbox)");
    // O title explica o desenho: trabalho na jaula, conversa no ambiente ativo.
    expect(botao?.getAttribute("title")).toContain("sandbox");
    expect(botao?.getAttribute("title")).toContain("Local");
  });

  it("fixado um ambiente, o crachá volta a mostrar o fixado", () => {
    useApp.setState({ environment: "local", environmentChosen: true, environments: COM_SANDBOX });
    monta();

    expect(container.querySelector(".envbadge-button")?.textContent).toBe("Local");
  });

  it("sem sandbox nesta máquina, o rótulo de sempre continua", () => {
    useApp.setState({ environment: "local", environmentChosen: false, environments: SEM_SANDBOX });
    monta();

    expect(container.querySelector(".envbadge-button")?.textContent).toBe("Local");
  });

  it("escolher no menu fixa o ambiente — mesmo escolhendo o que já estava ativo", () => {
    // É assim que se sai do "auto (sandbox)" e se FIXA o Local: o gesto tem de
    // chegar ao gateway (Registry.Set) mesmo sem trocar o id ativo. Sem
    // transporte o setEnvironment recusa com aviso — o que este teste fixa é
    // que o crachá NÃO finge que fixou.
    useApp.setState({
      environment: "local",
      environmentChosen: false,
      environments: COM_SANDBOX,
      session: null
    });
    monta();

    act(() => {
      container
        .querySelector(".envbadge-button")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    const opcaoLocal = [...container.querySelectorAll(".envbadge-option")].find((item) =>
      item.textContent?.includes("Local")
    );
    act(() => {
      opcaoLocal?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });

    // Sem conexão a escolha não vale — e o rodapé segue no automático em vez
    // de prometer um ambiente que o gateway não registrou.
    expect(useApp.getState().environmentChosen).toBe(false);
    expect(useApp.getState().error).toContain("sem conexão");
    expect(container.querySelector(".envbadge-button")?.textContent).toBe("auto (sandbox)");
  });
});
