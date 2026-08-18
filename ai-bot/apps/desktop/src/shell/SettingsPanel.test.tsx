/**
 * O contrato de segredo do formulário de provedor.
 *
 * O que está em teste não é o CRUD — é a regra de que a CHAVE NÃO FICA: ela
 * sai no submit e o campo zera em seguida, com sucesso OU com falha. Um campo
 * de senha que segura o valor depois do envio é um segredo esperando o
 * próximo print de tela, e é exatamente o defeito que este arquivo fixa.
 *
 * Sem @testing-library, como no Topbar.test.tsx: montagem crua com
 * react-dom/client e o `act` do React 19 — cada dependência passa por
 * homologação de TI/SI, e uma biblioteca para preencher quatro campos não se
 * justifica.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  PROVIDER_KINDS,
  ProviderConfigForm,
  ProviderForm,
  SettingsPanel,
  keyLabel,
  type CatalogProvider,
  type NewProvider
} from "./SettingsPanel";
import { useApp } from "../lib/store";

declare global {
  // A bandeira que o React 19 procura para aceitar `act()` fora de uma suíte
  // oficial. `var` porque é o que declara global em TypeScript.
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

/**
 * Digita num input controlado sem biblioteca: o setter NATIVO de `value`
 * seguido do evento `input`. Setar `input.value` direto não funciona — o React
 * rastreia o último valor que ele mesmo escreveu e ignora o evento quando o
 * valor "não mudou".
 */
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) throw new Error("jsdom sem setter de value");
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function field(label: string): HTMLInputElement {
  const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
  if (!found) throw new Error(`campo "${label}" não está na tela`);
  return found;
}

async function submitForm() {
  const form = container.querySelector("form");
  if (!form) throw new Error("formulário não está na tela");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
}

describe("ProviderForm", () => {
  it("envia a chave e ZERA o campo de senha após o submit", async () => {
    const submitted: NewProvider[] = [];
    const onSubmit = vi.fn(async (provider: NewProvider) => {
      submitted.push(provider);
    });

    act(() => {
      root.render(<ProviderForm onSubmit={onSubmit} />);
    });

    type(field("id do provedor"), "openrouter");
    type(field("baseUrl do provedor"), "https://openrouter.ai/api/v1");
    const password = field("chave de API");
    expect(password.type).toBe("password");
    type(password, "sk-or-super-secreta");

    await submitForm();

    // A chave saiu no corpo…
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(submitted[0]?.apiKey).toBe("sk-or-super-secreta");
    expect(submitted[0]?.id).toBe("openrouter");

    // …e NÃO ficou no campo. É este o contrato: o segredo não espera no DOM.
    expect(password.value).toBe("");
    // Sucesso também limpa os campos comuns, para o próximo cadastro.
    expect(field("id do provedor").value).toBe("");
  });

  it("zera a senha MESMO quando o gateway recusa, e mantém o resto para corrigir", async () => {
    const onSubmit = vi.fn(async () => {
      throw new Error("kind \"banana\" desconhecido");
    });

    act(() => {
      root.render(<ProviderForm onSubmit={onSubmit} />);
    });

    type(field("id do provedor"), "acme");
    type(field("baseUrl do provedor"), "https://api.acme.dev/v1");
    type(field("chave de API"), "sk-nao-pode-sobrar");

    await submitForm();

    // A falha aparece com a frase do gateway…
    expect(container.textContent).toContain("banana");
    // …a senha zera mesmo assim (o segredo não fica esperando o retry)…
    expect(field("chave de API").value).toBe("");
    // …e os campos comuns ficam, porque é neles que a correção acontece.
    expect(field("id do provedor").value).toBe("acme");
  });
});

describe("keyLabel", () => {
  it("traduz o estado da chave sem nunca ter o valor", () => {
    const base = {
      id: "p",
      name: "P",
      kind: "openai",
      baseUrl: "https://x",
      enabled: true,
      canDelete: true
    };
    expect(keyLabel({ ...base, needsKey: true, hasKey: true })).toBe("chave: cadastrada");
    expect(keyLabel({ ...base, needsKey: true, hasKey: false })).toBe("chave: ausente");
    expect(keyLabel({ ...base, needsKey: false, hasKey: false })).toBe("não usa chave");
  });
});

describe("integração xAI", () => {
  it("oferece xAI entre os dialetos configuráveis", () => {
    expect(PROVIDER_KINDS).toContain("xai");
  });

  it("habilita provedor existente, envia a chave e limpa o segredo", async () => {
    const provider: CatalogProvider = {
      id: "xai",
      name: "xAI",
      kind: "xai",
      baseUrl: "https://api.x.ai/v1",
      enabled: false,
      needsKey: true,
      hasKey: false,
      canDelete: false
    };
    const submitted: Array<{ apiKey?: string; enabled: boolean }> = [];

    act(() => {
      root.render(
        <ProviderConfigForm
          provider={provider}
          onSubmit={async (change) => {
            submitted.push(change);
          }}
        />
      );
    });

    const password = field("chave de API de xai");
    type(password, "xai-segredo");
    const enabled = field("habilitar xai");
    act(() => enabled.click());
    await submitForm();

    expect(submitted).toEqual([{ apiKey: "xai-segredo", enabled: true }]);
    expect(password.value).toBe("");
  });
});

/**
 * O MENU das configurações.
 *
 * Ele existe para ser igual ao do orquestrador — item por item, na mesma ordem.
 * Um item que suma daqui é um assunto que o produto passou a esconder, e é
 * exatamente isso que este teste impede que aconteça em silêncio.
 *
 * O painel fala com o store e com o transporte; nos dois casos o teste usa o
 * que já existe (o store real, sem gateway, devolve transporte nulo — e as
 * seções que dependem dele dizem isso na tela, que também é comportamento).
 */
describe("menu das configurações", () => {
  const ROTULOS = [
    "Conexão",
    "Motores & Fusion",
    "Provedores (BYOK)",
    "Memória",
    "Extensões",
    "Plugins & trilha",
    "Conectores (MCP)",
    "Runtime local",
    "Ship (build & deploy)",
    "Servidor VPS",
    "Administração",
    "Aparência"
  ];

  const nav = () =>
    [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")];

  it("tem as doze seções do orquestrador, na ordem", async () => {
    await act(async () => {
      root.render(<SettingsPanel />);
    });

    expect(nav().map((botao) => botao.textContent?.trim())).toEqual(ROTULOS);
  });

  it("abre em Conexão e troca de painel ao clicar", async () => {
    await act(async () => {
      root.render(<SettingsPanel />);
    });

    const marcado = () => nav().find((botao) => botao.getAttribute("aria-current") === "true");
    expect(marcado()?.textContent).toContain("Conexão");
    expect(container.textContent).toContain("Gateway");

    const aparencia = nav().find((botao) => botao.textContent?.includes("Aparência"));
    await act(async () => {
      aparencia?.click();
    });

    expect(marcado()?.textContent).toContain("Aparência");
    expect(container.textContent).toContain("Especialistas");
    expect(container.textContent).not.toContain("Gateway");
  });

  it("as sete seções sem rota dizem o que falta, e não fingem controle", async () => {
    await act(async () => {
      root.render(<SettingsPanel />);
    });

    const semRota = [
      "Memória",
      "Extensões",
      "Plugins & trilha",
      "Conectores (MCP)",
      "Ship (build & deploy)",
      "Servidor VPS",
      "Administração"
    ];

    for (const rotulo of semRota) {
      const botao = nav().find((item) => item.textContent?.includes(rotulo));
      await act(async () => {
        botao?.click();
      });

      const painel = container.querySelector(".settings-content");
      expect(painel?.textContent).toContain("Ainda não configurável aqui");
      expect(painel?.textContent).toContain("sem rota no gateway");

      // Uma frase concreta sobre o que falta — não "em breve".
      const nota = painel?.querySelector(".settings-cardx .settings-help")?.textContent ?? "";
      expect(nota.length).toBeGreaterThan(80);

      // E nada de campo editável fingindo que a seção funciona.
      expect(painel?.querySelectorAll("input, select").length).toBe(0);
    }
  });

  it("Aparência troca o tema de verdade", async () => {
    await act(async () => {
      root.render(<SettingsPanel />);
    });

    const aparencia = nav().find((botao) => botao.textContent?.includes("Aparência"));
    await act(async () => {
      aparencia?.click();
    });

    const escuro = [...container.querySelectorAll<HTMLButtonElement>("button")].find((botao) =>
      botao.textContent?.includes("Escuro")
    );
    await act(async () => {
      escuro?.click();
    });

    expect(useApp.getState().theme).toBe("dark");
    expect(escuro?.getAttribute("aria-pressed")).toBe("true");

    const claro = [...container.querySelectorAll<HTMLButtonElement>("button")].find((botao) =>
      botao.textContent?.includes("Claro")
    );
    await act(async () => {
      claro?.click();
    });
    expect(useApp.getState().theme).toBe("light");
  });
});

/**
 * Sem gateway, a tela precisa dizer O QUE FAZER.
 *
 * Este é o defeito que a rodada anterior deixou passar: numa aba de navegador o
 * token do gateway não existe e nunca vai existir (quem o lê do disco é o
 * processo do aplicativo), então a mensagem "os provedores aparecem quando ele
 * conectar" mandava a pessoa esperar uma conexão que o desenho impede.
 */
describe("configurações sem gateway", () => {
  it("na aba de navegador manda abrir o aplicativo, com o comando", async () => {
    await act(async () => {
      root.render(<SettingsPanel />);
    });

    const provedores = [...container.querySelectorAll<HTMLButtonElement>(".settings-nav button")].find(
      (botao) => botao.textContent?.includes("Provedores")
    );
    await act(async () => {
      provedores?.click();
    });

    const painel = container.querySelector(".settings-content");
    expect(painel?.textContent).toContain("Sem conexão com o gateway");
    expect(painel?.textContent).toContain("aba de navegador");

    // O comando exato, em bloco copiável — não uma vaga menção ao "aplicativo".
    expect(painel?.querySelector(".settings-comando")?.textContent).toBe(
      "corepack pnpm dev:desktop"
    );

    // E nada de formulário de chave: sem transporte, um campo de senha ali seria
    // um segredo digitado para lugar nenhum.
    expect(painel?.querySelectorAll('input[type="password"]').length).toBe(0);
  });
});
