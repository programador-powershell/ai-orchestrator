/**
 * As configurações.
 *
 * É um painel de LEITURA, e isso é a decisão principal daqui: tudo o que ele
 * mostra já é decidido em outro lugar — o endereço vem do processo que subiu o
 * gateway, o modelo e o tema têm controle próprio na barra superior, e os
 * especialistas são catálogo do servidor. Repetir esses controles aqui criaria
 * dois botões para a mesma coisa, e o segundo é sempre o que fica dessincronizado.
 *
 * O que ele resolve é a pergunta "com o que eu estou falando agora?", que hoje
 * não tinha resposta em lugar nenhum da tela: o botão de engrenagem (e o Ctrl+,)
 * ligava `settingsOpen` e ninguém lia o estado.
 *
 * A moldura é a do cartão de aprovação (`.approval-backdrop`/`.approval-card`)
 * porque é a mesma interrupção: a tela para e mostra uma coisa só.
 */
import { Bot, Moon, Settings, Sun, X } from "lucide-react";
import { useApp } from "../lib/store";
import { SPECIALIST_ICON } from "../lib/specialists";

const STATUS_LABEL: Record<"connecting" | "ready" | "offline", string> = {
  connecting: "conectando…",
  ready: "conectado",
  offline: "offline"
};

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="settings-row">
      <span className="settings-key">{label}</span>
      <span className="settings-value">{value}</span>
    </div>
  );
}

export function SettingsPanel() {
  const gatewayUrl = useApp((state) => state.gatewayUrl);
  const status = useApp((state) => state.status);
  const models = useApp((state) => state.models);
  const activeModel = useApp((state) => state.activeModel);
  const theme = useApp((state) => state.theme);
  const specialists = useApp((state) => state.specialists);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);

  // O endereço só é conhecido depois que o Rust responde de onde subiu o
  // gateway. Dizer isso é melhor que mostrar o padrão como se fosse o real.
  const url = gatewayUrl === "" ? "ainda descobrindo…" : gatewayUrl;

  // O rótulo do modelo é do catálogo; um id fora da lista aparece como veio, e
  // marcado — inventar um nome bonito esconderia justamente a divergência.
  const known = models.find((model) => model.id === activeModel);
  const model =
    activeModel === ""
      ? "nenhum escolhido"
      : known
        ? `${known.label} · ${known.provider}${known.local ? " · local" : ""}`
        : `${activeModel} (fora da lista do gateway)`;

  return (
    <div className="approval-backdrop">
      <section
        className="approval-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-title"
      >
        <header className="approval-head">
          <Settings size={16} aria-hidden />
          <h2 id="settings-title" className="approval-tool">
            configurações
          </h2>
        </header>

        <div className="settings-list">
          <Row label="Gateway" value={url} />
          <Row label="Conexão" value={STATUS_LABEL[status]} />
          <Row label="Modelo" value={model} />
          <Row label="Tema" value={theme === "dark" ? "escuro" : "claro"} />
        </div>

        <p className="approval-summary">Especialistas</p>

        <ul className="settings-list">
          {specialists.map((specialist) => {
            const Glyph = SPECIALIST_ICON[specialist.id] ?? Bot;
            return (
              <li key={specialist.id} className="settings-bot">
                <Glyph size={14} strokeWidth={1.75} aria-hidden />
                <span>{specialist.name}</span>
                <span className="settings-bot-tag">{specialist.tagline}</span>
              </li>
            );
          })}
        </ul>

        <p className="approval-note">
          {theme === "dark" ? <Moon size={13} aria-hidden /> : <Sun size={13} aria-hidden />}
          O tema e o modelo são trocados na barra superior; aqui eles só são mostrados.
        </p>

        <p className="approval-note">
          O token do gateway e as chaves dos provedores ficam no cofre do sistema operacional e
          não são exibidos aqui — nem por engano, nem em log.
        </p>

        <footer className="approval-actions">
          <button type="button" className="button-secondary" onClick={() => setSettingsOpen(false)}>
            <X size={14} aria-hidden />
            Fechar
          </button>
        </footer>
      </section>
    </div>
  );
}

export default SettingsPanel;
