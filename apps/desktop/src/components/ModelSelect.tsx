"use client";

/**
 * Troca do motor pelo chip do composer.
 *
 * A escolha de motor sempre foi de quem administra: escolher modelo é escolher
 * quanto se gasta e quanta inteligência entra na tarefa. O chip existia só
 * para INFORMAR, e a troca vivia enterrada em Configurações → Motores &
 * Fusion. Para o time de TI — que é quem opera a aba Code — isso era um
 * caminho longo para uma decisão que eles têm autoridade de tomar.
 *
 * Agora o chip abre a lista. Quem não é admin continua caindo nas
 * Configurações, como antes.
 *
 * ## Isto NÃO é controle de acesso
 *
 * `settings.engines` mora no `localStorage` do webview: qualquer restrição
 * aplicada aqui é editável pelo próprio usuário. O portão de verdade é o
 * gateway, que recusa o modelo fora da política. O que este componente faz é
 * poupar cliques de quem já está autorizado — não conceder autorização.
 */

import { useEffect, useRef, useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import type { EngineSelection, UiMode } from "@multiplike/contracts";

import { describeSelection } from "../lib/engine";
import { useApp } from "../lib/store";
import { avaliarSelecao } from "../lib/enginePolicy";

interface Opcao {
  chave: string;
  selection: EngineSelection;
  rotulo: string;
  detalhe: string;
  fusion?: boolean;
  recomendado?: boolean;
}

export function ModelSelect({ mode }: { mode: string }) {
  const settings = useApp((state) => state.settings);
  const setEngine = useApp((state) => state.setEngine);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);
  const profile = useApp((state) => state.profile);
  const policy = useApp((state) => state.policy);
  const policyVerified = useApp((state) => state.policyVerified);
  const session = useApp((state) => state.session);
  // Trocar de motor no meio de um turno mandaria a continuação para outro
  // modelo — a resposta sairia costurada por dois.
  const sending = useApp((state) => state.threads[mode as keyof typeof state.threads]?.sending ?? false);

  const [aberto, setAberto] = useState(false);
  const raizRef = useRef<HTMLDivElement>(null);

  // Sem perfil (ainda sem gateway), o app é local e quem opera é a TI.
  const podeTrocar = profile ? profile.role === "admin" || profile.role === "owner" : true;
  const selection = settings.engines[mode as keyof typeof settings.engines] ?? settings.engines.chat;

  useEffect(() => {
    if (!aberto) return;
    function fora(event: PointerEvent) {
      if (!raizRef.current?.contains(event.target as Node)) setAberto(false);
    }
    function esc(event: KeyboardEvent) {
      if (event.key === "Escape") setAberto(false);
    }
    document.addEventListener("pointerdown", fora);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("pointerdown", fora);
      document.removeEventListener("keydown", esc);
    };
  }, [aberto]);

  const rotulo = describeSelection(selection, settings.fusionPresets, settings.modelCatalog);

  if (!podeTrocar) {
    return (
      <button
        className="model-select readonly"
        onClick={() => setSettingsOpen(true)}
        title="O modelo deste módulo é definido nas Configurações (administração)"
      >
        {selection.kind === "fusion" ? <span className="fusion-dot" /> : <Sparkles size={13} />}
        {rotulo}
      </button>
    );
  }

  /**
   * A ordem da lista é a recomendação.
   *
   * Fusão primeiro porque é onde mora a política de custo/inteligência do
   * produto — e o `Code Pair` no topo de tudo, marcado, porque já é o padrão
   * da aba Code. Modelo avulso vem por último: escolher um fixa a conta num
   * provedor só, o que é decisão consciente, não a primeira da lista.
   */
  /** O mesmo contexto que o motor usa — ver `lib/enginePolicy.ts`. */
  const contextoDePolitica = {
    policy,
    policyVerified,
    temGateway: Boolean(settings.gateway?.baseUrl?.trim())
  };

  const opcoes: Opcao[] = [
    ...settings.fusionPresets.map((preset) => ({
      chave: `fusion:${preset.id}`,
      selection: { kind: "fusion", presetId: preset.id } as EngineSelection,
      rotulo: preset.name,
      detalhe: describeSelection({ kind: "fusion", presetId: preset.id }, settings.fusionPresets, settings.modelCatalog),
      fusion: true,
      recomendado: preset.id === "code-pair"
    })),
    {
      chave: "workspace",
      selection: { kind: "workspace" },
      rotulo: "Rota do workspace",
      detalhe: "O gateway decide o modelo pela política do grupo"
    },
/*
     * As duas regras saem de `avaliarSelecao`, a MESMA que o `chatOnce`
     * aplica na hora de usar. Antes a checagem morava só aqui, escrita como
     * `policy?.byokAllowed !== false` — o que tratava "ainda nao sei" (o
     * bootstrap que nao respondeu) como "pode".
     */
    ...(avaliarSelecao({ kind: "local" }, contextoDePolitica).permitido
      ? [
          {
            chave: "local",
            selection: { kind: "local" } as EngineSelection,
            rotulo: "Runtime local",
            detalhe: "Roda na estação, sem sair para a rede"
          }
        ]
      : []),
    ...(avaliarSelecao(
      { kind: "model", target: { providerId: "", model: "" } },
      contextoDePolitica
    ).permitido
      ? (settings.modelCatalog ?? []).map((item) => ({
          chave: `model:${item.providerId}:${item.model}`,
          selection: { kind: "model", target: { providerId: item.providerId, model: item.model } } as EngineSelection,
          rotulo: item.label ?? item.model,
          detalhe: item.providerId
        }))
      : [])
  ];
  opcoes.sort((a, b) => Number(!!b.recomendado) - Number(!!a.recomendado));

  const atual = (opcao: Opcao) => {
    if (opcao.selection.kind !== selection.kind) return false;
    if (opcao.selection.kind === "fusion" && selection.kind === "fusion") {
      return opcao.selection.presetId === selection.presetId;
    }
    if (opcao.selection.kind === "model" && selection.kind === "model") {
      return (
        opcao.selection.target.providerId === selection.target.providerId &&
        opcao.selection.target.model === selection.target.model
      );
    }
    return true;
  };

  function escolher(opcao: Opcao) {
    // `setEngine` e não `updateSettings`: é a ação que já existe para isto, e
    // escrever `engines` inteiro por fora dela abriria um segundo caminho para
    // a mesma mudança.
    setEngine(mode as UiMode, opcao.selection);
    setAberto(false);
  }

  return (
    <div className="model-select-wrap" ref={raizRef}>
      <button
        className={`model-select ${aberto ? "aberto" : ""}`}
        onClick={() => setAberto((valor) => !valor)}
        disabled={sending}
        aria-haspopup="listbox"
        aria-expanded={aberto}
        title={
          sending
            ? "Turno em andamento — espere para trocar de motor"
            : "Trocar o motor deste módulo. A política do gateway continua valendo."
        }
      >
        {selection.kind === "fusion" ? <span className="fusion-dot" /> : <Sparkles size={13} />}
        {rotulo}
        <ChevronDown size={12} className="model-select-seta" />
      </button>

      {aberto ? (
        <div className="engine-menu glass-strong" role="listbox" aria-label="Motor do módulo">
          {opcoes.map((opcao) => (
            <button
              key={opcao.chave}
              type="button"
              role="option"
              aria-selected={atual(opcao)}
              className={`engine-item ${atual(opcao) ? "ativo" : ""}`}
              onClick={() => escolher(opcao)}
            >
              <span className="engine-marca">{atual(opcao) ? <Check size={12} /> : null}</span>
              <span className="engine-texto">
                <strong>
                  {opcao.fusion ? <span className="fusion-dot" /> : null}
                  {opcao.rotulo}
                  {opcao.recomendado ? <em className="engine-tag">recomendado</em> : null}
                </strong>
                <small>{opcao.detalhe}</small>
              </span>
            </button>
          ))}
          {/*
           * O rodapé não é decoração: sem gateway o app roda com o que está no
           * disco, e com gateway a política PODE recusar o que foi escolhido
           * aqui. Dizer isso evita a leitura de que o chip concede permissão.
           */}
          <p className="engine-rodape">
            {session
              ? "A política do gateway continua valendo — ela pode recusar o motor escolhido."
              : "Sem gateway conectado: vale o que estiver configurado nesta estação."}
          </p>
        </div>
      ) : null}
    </div>
  );
}
