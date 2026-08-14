/**
 * A barra superior.
 *
 * Metade fixa (título, modelo, especialista, tema, configurações) e metade
 * dinâmica: o slot `#topbar-actions`, onde a superfície ativa injeta os botões
 * dela por portal. A superfície não desenha barra própria — se desenhasse, o app
 * teria duas barras empilhadas e a tela única viraria uma pilha de painéis.
 */
import { Bot, Moon, Settings, Sun, Wifi, WifiOff } from "lucide-react";
import { useApp } from "../lib/store";
import { MASTER, SPECIALIST_ICON, specialistById } from "../lib/specialists";
import { TopbarSlot } from "./TopbarActions";

export function Topbar() {
  const specialists = useApp((state) => state.specialists);
  const activeSpecialist = useApp((state) => state.activeSpecialist);
  const models = useApp((state) => state.models);
  const activeModel = useApp((state) => state.activeModel);
  const sessions = useApp((state) => state.sessions);
  const session = useApp((state) => state.session);
  const theme = useApp((state) => state.theme);
  const status = useApp((state) => state.status);
  const setModel = useApp((state) => state.setModel);
  const setTheme = useApp((state) => state.setTheme);
  const setSettingsOpen = useApp((state) => state.setSettingsOpen);

  // Enquanto o master não decidiu nada, quem aparece é o próprio master: mentir
  // "Conversa" antes da primeira rota faria a barra prometer um especialista que
  // ainda não atendeu ninguém.
  const active = activeSpecialist ? specialistById(specialists, activeSpecialist) : MASTER;
  const Icon = SPECIALIST_ICON[active.id] ?? Bot;

  const title = sessions.find((item) => item.id === session)?.title ?? "Nova conversa";

  // O `value` do select precisa existir entre as options, senão o React reclama e
  // o campo mostra o primeiro modelo como se fosse o escolhido — mentira visual.
  const modelIsKnown = models.some((model) => model.id === activeModel);

  return (
    <header className="topbar" data-status={status}>
      <div className="topbar-left">
        <h1 className="topbar-title" title={title}>
          {title}
        </h1>

        <span className="specialist-chip" data-specialist={active.id} title={active.tagline}>
          <Icon size={14} aria-hidden />
          <span>{active.name}</span>
        </span>

        {status !== "ready" ? (
          <span className="topbar-status" data-status={status} role="status">
            {status === "connecting" ? <Wifi size={13} aria-hidden /> : <WifiOff size={13} aria-hidden />}
            <span>{status === "connecting" ? "conectando…" : "offline"}</span>
          </span>
        ) : null}
      </div>

      {/* O que a superfície ativa injetar entra exatamente aqui. */}
      <TopbarSlot />

      <div className="topbar-right">
        <label className="topbar-model">
          <span className="visually-hidden">Modelo</span>
          <select
            value={activeModel}
            disabled={models.length === 0}
            onChange={(event) => setModel(event.target.value)}
            title="Modelo usado no próximo envio"
          >
            {models.length === 0 ? <option value="">sem modelos disponíveis</option> : null}
            {activeModel !== "" && !modelIsKnown ? (
              <option value={activeModel}>{activeModel} (fora da lista)</option>
            ) : null}
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.label}
                {model.local ? " · local" : ""}
              </option>
            ))}
          </select>
        </label>

        <button
          type="button"
          className="icon-button"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title={theme === "dark" ? "Usar o tema claro" : "Usar o tema escuro"}
          aria-label={theme === "dark" ? "Usar o tema claro" : "Usar o tema escuro"}
        >
          {theme === "dark" ? <Sun size={16} aria-hidden /> : <Moon size={16} aria-hidden />}
        </button>

        <button
          type="button"
          className="icon-button"
          onClick={() => setSettingsOpen(true)}
          title="Configurações (Ctrl+,)"
          aria-label="Configurações"
        >
          <Settings size={16} aria-hidden />
        </button>
      </div>
    </header>
  );
}

export default Topbar;
