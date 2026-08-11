/**
 * GAME STUDIO — ponte real para a engine (Blender / Unity / Unreal).
 * A construção acontece NO app da engine; esta aba mostra o que foi feito:
 * varre a pasta real do projeto e exibe os assets (FBX, GLB, mapas, texturas,
 * áudio, scripts), abre cada um na engine/aplicativo padrão e exporta o
 * inventário. Detecção de engine via terminal. Nada é simulado: no navegador
 * os recursos que exigem disco ficam rotulados.
 */
import "../styles/modes/game.css";
import { useMemo, useState } from "react";
import { create } from "zustand";
import {
  AudioLines,
  Box,
  Braces,
  Download,
  FileQuestion,
  FolderOpen,
  Gamepad2,
  Image as ImageIcon,
  Map as MapIcon,
  Play,
  RefreshCw,
  Search,
  Sparkles
} from "lucide-react";
import type { FsEntry } from "@ai-orchestrator/contracts";
import { EmptyHero, FloatingPulse, PanelScroll, PanelTitle, Surface, TopbarActions, VBody, VCenter, VRight, VStatus } from "../components/Primitives";
import { RailConversations } from "../components/RailConversations";
import { collectFiles, isTauriFs } from "../lib/fsx";
import { terminal } from "../lib/terminal";
import { useApp } from "../lib/store";

const isTauriHost = "__TAURI_INTERNALS__" in window;
const ROOT_KEY = "game.root";

const ENGINES = ["Blender", "Unreal Engine", "Unity"] as const;
type Engine = (typeof ENGINES)[number];

const engineProbeCommand: Record<Engine, string> = {
  Blender: "where blender.exe",
  "Unreal Engine": "where UnrealEditor.exe",
  Unity: "where Unity.exe"
};

type AssetGroup = "modelos" | "cenas" | "texturas" | "audio" | "scripts" | "outros";

const GROUPS: Record<AssetGroup, { label: string; icon: typeof Box; extensions: string[] }> = {
  modelos: { label: "Modelos 3D", icon: Box, extensions: ["fbx", "glb", "gltf", "obj", "dae", "3ds", "stl"] },
  cenas: { label: "Cenas & mapas", icon: MapIcon, extensions: ["blend", "unity", "umap", "uasset", "tscn", "usd", "usda"] },
  texturas: { label: "Texturas", icon: ImageIcon, extensions: ["png", "jpg", "jpeg", "tga", "exr", "hdr", "dds", "psd"] },
  audio: { label: "Áudio", icon: AudioLines, extensions: ["wav", "ogg", "mp3", "flac"] },
  scripts: { label: "Scripts", icon: Braces, extensions: ["cs", "cpp", "h", "gd", "lua"] },
  outros: { label: "Outros", icon: FileQuestion, extensions: [] }
};

const GROUP_ORDER: AssetGroup[] = ["modelos", "cenas", "texturas", "audio", "scripts", "outros"];
const ALL_KNOWN = new Set(GROUP_ORDER.flatMap((group) => GROUPS[group].extensions));

interface Asset extends FsEntry {
  extension: string;
  group: AssetGroup;
}

function classify(entry: FsEntry): Asset | null {
  const match = /\.([a-z0-9]+)$/i.exec(entry.name);
  if (!match || entry.isDir) return null;
  const extension = match[1].toLowerCase();
  const group = GROUP_ORDER.find((key) => GROUPS[key].extensions.includes(extension));
  if (group) return { ...entry, extension, group };
  return null;
}

const formatSize = (size: number) =>
  size >= 1_048_576 ? `${(size / 1_048_576).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(0)} KB` : `${size} B`;

interface GameState {
  root: string;
  assets: Asset[];
  scanned: boolean;
  scanning: boolean;
  filter: AssetGroup | "todos";
  engine: Engine;
  probe: string;
  setRoot: (root: string) => void;
  setFilter: (filter: AssetGroup | "todos") => void;
  setEngine: (engine: Engine) => void;
}

const useGame = create<GameState>()((set) => ({
  root: localStorage.getItem(ROOT_KEY) ?? "",
  assets: [],
  scanned: false,
  scanning: false,
  filter: "todos",
  engine: "Unreal Engine",
  probe: "",
  setRoot: (root) => {
    localStorage.setItem(ROOT_KEY, root);
    set({ root });
  },
  setFilter: (filter) => set({ filter }),
  // Troca de engine invalida a sondagem anterior (o resultado era da engine antiga).
  setEngine: (engine) => set({ engine, probe: "" })
}));

/** Varredura REAL da pasta do projeto de jogo (desktop). */
async function scanAssets() {
  const { root, scanning } = useGame.getState();
  if (scanning || !root.trim()) return;
  useGame.setState({ scanning: true });
  try {
    const entries = await collectFiles(root.trim(), { maxEntries: 800, maxDepth: 6 });
    const assets = entries.map(classify).filter((asset): asset is Asset => asset !== null);
    useGame.setState({ assets, scanned: true });
  } catch {
    useGame.setState({ assets: [], scanned: true });
  } finally {
    useGame.setState({ scanning: false });
  }
}

async function openInEngine(asset: Asset) {
  if (!isTauriHost) return;
  const { root } = useGame.getState();
  const full = `${root.replace(/[\\/]+$/, "")}\\${asset.path.replace(/\//g, "\\")}`;
  try {
    const opener = await import("@tauri-apps/plugin-opener");
    await opener.openPath(full);
  } catch {
    // associação ausente: melhor esforço é revelar no Explorer
    try {
      const opener = await import("@tauri-apps/plugin-opener");
      await opener.revealItemInDir(full);
    } catch {
      // sem opener disponível — nada a fazer silenciosamente correto
    }
  }
}

function exportInventory(assets: Asset[], engine: Engine, root: string) {
  const inventory = {
    schema: 1,
    engineTarget: engine,
    projectRoot: root,
    exportedAt: new Date().toISOString(),
    totals: Object.fromEntries(GROUP_ORDER.map((group) => [group, assets.filter((asset) => asset.group === group).length])),
    assets: assets.map(({ name, path, size, extension, group }) => ({ name, path, size, extension, group }))
  };
  const blob = new Blob([JSON.stringify(inventory, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = "game-inventory.json";
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

/** Rail dinâmico: pasta do projeto + grupos com contagens reais + cenas. */
export function GameRail() {
  const root = useGame((state) => state.root);
  const assets = useGame((state) => state.assets);
  const filter = useGame((state) => state.filter);
  const scanning = useGame((state) => state.scanning);
  const { setRoot, setFilter } = useGame.getState();

  return (
    <>
      <span className="eyebrow">PROJETO DA ENGINE</span>
      <label className="rail-search">
        <FolderOpen size={13} />
        <input
          value={root}
          onChange={(event) => setRoot(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") void scanAssets();
          }}
          placeholder="pasta do projeto (Blender/Unity/UE)"
          aria-label="Pasta do projeto de jogo"
        />
      </label>
      <button className="lg-button compact" onClick={() => void scanAssets()} disabled={scanning || !root.trim()}>
        <RefreshCw size={13} className={scanning ? "spin" : undefined} />
        {scanning ? "Varrendo…" : "Varrer assets"}
      </button>
      {!isTauriFs && <span className="rail-empty">Leitura real da pasta requer o app desktop.</span>}
      <span className="eyebrow">ASSETS</span>
      <button className={`row-item ${filter === "todos" ? "active" : ""}`} onClick={() => setFilter("todos")}>
        <Gamepad2 size={14} />
        <span className="grow">Todos</span>
        <small>{assets.length}</small>
      </button>
      {GROUP_ORDER.map((group) => {
        const count = assets.filter((asset) => asset.group === group).length;
        const Icon = GROUPS[group].icon;
        return (
          <button
            key={group}
            className={`row-item ${filter === group ? "active" : ""}`}
            onClick={() => setFilter(group)}
            disabled={!count}
          >
            <Icon size={14} />
            <span className="grow">{GROUPS[group].label}</span>
            <small>{count}</small>
          </button>
        );
      })}
      <span className="eyebrow">CENAS</span>
      <RailConversations mode="game" />
    </>
  );
}

export function GameView() {
  const root = useGame((state) => state.root);
  const assets = useGame((state) => state.assets);
  const scanned = useGame((state) => state.scanned);
  const scanning = useGame((state) => state.scanning);
  const filter = useGame((state) => state.filter);
  const engine = useGame((state) => state.engine);
  const probe = useGame((state) => state.probe);
  const { setEngine } = useGame.getState();
  const sending = useApp((state) => state.threads.game.sending);
  const stage = useApp((state) => state.stage);
  const [probing, setProbing] = useState(false);
  const [query, setQuery] = useState("");

  const visible = useMemo(() => {
    const term = query.trim().toLowerCase();
    return assets
      .filter((asset) => (filter === "todos" ? true : asset.group === filter))
      .filter((asset) => (term ? asset.path.toLowerCase().includes(term) : true));
  }, [assets, filter, query]);

  async function probeEngine() {
    setProbing(true);
    try {
      if (!isTauriHost) {
        useGame.setState({ probe: "detecção real requer o app desktop" });
        return;
      }
      const result = await terminal.execute(engineProbeCommand[engine]);
      useGame.setState({
        probe: result.exitCode === 0 ? `${engine} detectado` : `${engine} não encontrado — ponte pronta`
      });
    } catch {
      useGame.setState({ probe: "falha ao sondar a engine" });
    } finally {
      setProbing(false);
    }
  }

  return (
    <Surface className="gamex">
      <TopbarActions>
        <div className="segmented">
          {ENGINES.map((item) => (
            <button key={item} className={engine === item ? "active" : ""} onClick={() => setEngine(item)}>
              {item.replace(" Engine", "")}
            </button>
          ))}
        </div>
        <button className="icon-button" onClick={() => void probeEngine()} disabled={probing} title="Detectar engine instalada">
          <RefreshCw size={14} className={probing ? "spin" : undefined} />
        </button>
        <button
          className="lg-button ghost"
          onClick={() => exportInventory(assets, engine, root)}
          disabled={!assets.length}
          title="Exportar inventário JSON dos assets reais"
        >
          <Download size={13} />
          Inventário
        </button>
        <button
          className="lg-button primary"
          disabled={!assets.length}
          onClick={() =>
            useApp
              .getState()
              .setInput(
                `No projeto ${engine} em "${root}", com ${assets.length} assets (${GROUP_ORDER.map(
                  (group) => `${assets.filter((asset) => asset.group === group).length} ${GROUPS[group].label.toLowerCase()}`
                ).join(", ")}), proponha o próximo passo do pipeline e os scripts necessários`
              )
          }
        >
          <Play size={13} />
          Pipeline
        </button>
      </TopbarActions>

      <VBody>
        <VCenter>
          {sending && <FloatingPulse label={stage || "Gerando"} detail="pipeline e scripts com o motor ativo" />}
          {assets.length === 0 ? (
            <EmptyHero
              icon={<Gamepad2 size={26} />}
              kicker="PONTE DE ENGINE"
              title="A construção mora na engine."
              detail={
                scanned
                  ? isTauriFs
                    ? "Nenhum asset reconhecido nesta pasta — aponte para o projeto da engine (FBX, GLB, mapas, texturas, áudio, scripts)."
                    : "No navegador a varredura usa a árvore de demonstração, sem assets de engine — a leitura real da pasta requer o app desktop."
                  : "Aponte a pasta do projeto no rail e varra: a aba mostra o que foi feito no Blender/Unity/Unreal — assets reais, abertos com um clique."
              }
            />
          ) : (
            <div className="gamex-browser">
              <label className="rail-search gamex-search">
                <Search size={13} />
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={`Filtrar ${visible.length} de ${assets.length} assets…`}
                  aria-label="Filtrar assets"
                />
              </label>
              <div className="gamex-grid">
                {visible.slice(0, 240).map((asset) => {
                  const Icon = GROUPS[asset.group].icon;
                  return (
                    <button
                      key={asset.path}
                      className="gamex-card"
                      title={`${asset.path} — ${isTauriHost ? "abrir na engine/app padrão" : "abrir requer o app desktop"}`}
                      onClick={() => void openInEngine(asset)}
                    >
                      <span className={`gamex-thumb ${asset.group}`}>
                        <Icon size={18} />
                        <em>.{asset.extension}</em>
                      </span>
                      <strong>{asset.name}</strong>
                      <small>
                        {asset.path.includes("/") ? asset.path.slice(0, asset.path.lastIndexOf("/")) : "raiz"} ·{" "}
                        {formatSize(asset.size)}
                      </small>
                    </button>
                  );
                })}
              </div>
              {visible.length > 240 && <p className="gamex-more">Mostrando 240 de {visible.length} — refine o filtro.</p>}
            </div>
          )}
        </VCenter>

        <VRight>
          <PanelTitle icon={<Gamepad2 size={13} />} label="Ponte da engine" meta={engine} />
          <PanelScroll>
            <div className="gamex-bridge">
              <p className="setx-hint">
                A construção acontece no {engine}; aqui você vê o resultado. Clique num asset para abrir no aplicativo
                associado{isTauriHost ? "" : " (requer o app desktop)"}.
              </p>
              <div className="gamex-stat">
                <span>Engine</span>
                <strong>{probe || "não sondada"}</strong>
              </div>
              <div className="gamex-stat">
                <span>Assets no projeto</span>
                <strong>{assets.length}</strong>
              </div>
              {GROUP_ORDER.map((group) => {
                const count = assets.filter((asset) => asset.group === group).length;
                if (!count) return null;
                return (
                  <div className="gamex-stat" key={group}>
                    <span>{GROUPS[group].label}</span>
                    <strong>{count}</strong>
                  </div>
                );
              })}
              <button
                className="lg-button ghost"
                onClick={() => useApp.getState().setInput("Gere um script de validação de assets (nomes, escala, LODs) para este projeto")}
              >
                <Sparkles size={13} />
                Pedir validação ao agente
              </button>
            </div>
          </PanelScroll>
        </VRight>
      </VBody>

      <VStatus>
        <span>
          <Gamepad2 size={11} /> {engine}
        </span>
        <span>
          <Box size={11} /> {assets.length} asset{assets.length === 1 ? "" : "s"} reais
        </span>
        <span>
          <FolderOpen size={11} /> {root.trim() || "pasta não definida"}
        </span>
        <div className="spacer" />
        <span>{scanning ? "varrendo…" : sending ? stage || "gerando…" : "pronto"}</span>
      </VStatus>
    </Surface>
  );
}
