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
import { ProviderForm, keyLabel, type NewProvider } from "./SettingsPanel";

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
      enabled: true
    };
    expect(keyLabel({ ...base, needsKey: true, hasKey: true })).toBe("chave: cadastrada");
    expect(keyLabel({ ...base, needsKey: true, hasKey: false })).toBe("chave: ausente");
    expect(keyLabel({ ...base, needsKey: false, hasKey: false })).toBe("não usa chave");
  });
});
