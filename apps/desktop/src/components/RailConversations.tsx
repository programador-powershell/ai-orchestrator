/**
 * Lista de conversas reais para o rail dinâmico — reutilizada pelas abas.
 * Organiza por projeto (pastas colapsáveis), exporta .md/.json e, quando
 * `searchable`, busca em TODAS as abas mostrando a origem de cada resultado.
 */
import { useMemo, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Download,
  Folder,
  FolderPlus,
  MessageCircle,
  MoreHorizontal,
  Pencil,
  Search,
  Trash2,
  X
} from "lucide-react";
import type { UiMode } from "@ai-orchestrator/contracts";
import {
  exportFileName,
  groupByProject,
  searchConversations,
  toJson,
  toMarkdown
} from "../lib/conversations";
import { useApp, type Conversation } from "../lib/store";

const modeLabels: Record<UiMode, string> = {
  chat: "Chat",
  code: "Code",
  design: "Design",
  data: "Data",
  work: "Work",
  security: "Security",
  agent: "Agent",
  game: "Game",
  tune: "Tuning"
};

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "agora";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

function downloadText(fileName: string, text: string, type: string) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

export function RailConversations({ mode, searchable = false }: { mode: UiMode; searchable?: boolean }) {
  const conversations = useApp((state) => state.conversations[mode]);
  const allConversations = useApp((state) => state.conversations);
  const projects = useApp((state) => state.projects);
  const active = useApp((state) => state.activeConversation[mode]);
  const setMode = useApp((state) => state.setMode);
  const loadConversation = useApp((state) => state.loadConversation);
  const deleteConversation = useApp((state) => state.deleteConversation);
  const createProject = useApp((state) => state.createProject);
  const renameProject = useApp((state) => state.renameProject);
  const deleteProject = useApp((state) => state.deleteProject);
  const moveConversation = useApp((state) => state.moveConversation);

  const [query, setQuery] = useState("");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [draftProject, setDraftProject] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; name: string } | null>(null);

  const term = searchable ? query.trim() : "";
  const results = useMemo(
    () => (term ? searchConversations(allConversations, term) : []),
    [allConversations, term]
  );
  const groups = useMemo(() => groupByProject(conversations, projects), [conversations, projects]);

  function exportConversation(conversation: Conversation, format: "md" | "json") {
    const isMarkdown = format === "md";
    downloadText(
      exportFileName(conversation, format),
      isMarkdown ? toMarkdown(conversation) : toJson(conversation),
      isMarkdown ? "text/markdown;charset=utf-8" : "application/json;charset=utf-8"
    );
    setMenuFor(null);
  }

  function commitProject() {
    if (draftProject !== null) createProject(draftProject);
    setDraftProject(null);
  }

  function commitRename() {
    if (renaming) renameProject(renaming.id, renaming.name);
    setRenaming(null);
  }

  const renderConversation = (conversation: Conversation) => (
    <div className="rail-conv" key={conversation.id}>
      <button
        className={`rail-conversation ${conversation.id === active ? "active" : ""} ${
          menuFor === conversation.id ? "menu-open" : ""
        }`}
        title={conversation.title}
        onClick={() => loadConversation(mode, conversation.id)}
      >
        <MessageCircle size={14} />
        <span>{conversation.title}</span>
        <small>{relativeTime(conversation.updatedAt)}</small>
        <i
          className="conv-menu-trigger"
          role="button"
          aria-label="Ações da conversa"
          onClick={(event) => {
            event.stopPropagation();
            setMenuFor(menuFor === conversation.id ? null : conversation.id);
          }}
        >
          <MoreHorizontal size={12} />
        </i>
        <i
          role="button"
          aria-label="Excluir conversa"
          onClick={(event) => {
            event.stopPropagation();
            deleteConversation(mode, conversation.id);
          }}
        >
          <X size={12} />
        </i>
      </button>
      {menuFor === conversation.id && (
        <div className="conv-menu">
          <button onClick={() => exportConversation(conversation, "md")}>
            <Download size={12} />
            Exportar .md
          </button>
          <button onClick={() => exportConversation(conversation, "json")}>
            <Download size={12} />
            Exportar .json
          </button>
          <label>
            <Folder size={12} />
            <select
              value={conversation.projectId ?? ""}
              aria-label="Mover para projeto"
              onChange={(event) => {
                moveConversation(mode, conversation.id, event.target.value || null);
                setMenuFor(null);
              }}
            >
              <option value="">Sem projeto</option>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  );

  return (
    <>
      {searchable && (
        <label className="rail-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar em todas as abas…"
            aria-label="Buscar conversas"
          />
        </label>
      )}

      {term ? (
        <>
          {results.length === 0 && <span className="rail-empty">Nada encontrado no histórico.</span>}
          {results.map((result) => (
            <button
              className="rail-result"
              key={`${result.mode}-${result.conversationId}`}
              title={result.title}
              onClick={() => {
                setMode(result.mode);
                loadConversation(result.mode, result.conversationId);
              }}
            >
              <span className="rail-result-head">
                <span>{result.title}</span>
                <span className="rail-result-mode">{modeLabels[result.mode]}</span>
                <span className="rail-result-count">{result.matchCount}</span>
              </span>
              <small>{result.snippet}</small>
            </button>
          ))}
        </>
      ) : (
        <>
          <div className="rail-projects-bar">
            {draftProject === null ? (
              <button onClick={() => setDraftProject("")}>
                <FolderPlus size={12} />
                Novo projeto
              </button>
            ) : (
              <input
                autoFocus
                value={draftProject}
                placeholder="Nome do projeto"
                aria-label="Nome do novo projeto"
                onChange={(event) => setDraftProject(event.target.value)}
                onBlur={commitProject}
                onKeyDown={(event) => {
                  if (event.key === "Enter") commitProject();
                  if (event.key === "Escape") setDraftProject(null);
                }}
              />
            )}
          </div>

          {conversations.length === 0 && projects.length === 0 && (
            <span className="rail-empty">Sem histórico ainda — envie pelo composer.</span>
          )}

          {groups.map((group) => {
            const project = group.project;
            if (!project) return <div className="rail-group" key="loose">{group.conversations.map(renderConversation)}</div>;
            const open = !collapsed[project.id];
            return (
              <div className="rail-group" key={project.id}>
                {renaming?.id === project.id ? (
                  <input
                    autoFocus
                    className="rail-group-rename"
                    value={renaming.name}
                    aria-label="Novo nome do projeto"
                    onChange={(event) => setRenaming({ id: project.id, name: event.target.value })}
                    onBlur={commitRename}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") commitRename();
                      if (event.key === "Escape") setRenaming(null);
                    }}
                  />
                ) : (
                  <div className="rail-group-head">
                    <button
                      aria-expanded={open}
                      onClick={() => setCollapsed({ ...collapsed, [project.id]: open })}
                    >
                      {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
                      <Folder size={12} />
                      <span>{project.name}</span>
                      <small>{group.conversations.length}</small>
                    </button>
                    <i
                      role="button"
                      aria-label="Renomear projeto"
                      onClick={() => setRenaming({ id: project.id, name: project.name })}
                    >
                      <Pencil size={11} />
                    </i>
                    <i role="button" aria-label="Excluir projeto" onClick={() => deleteProject(project.id)}>
                      <Trash2 size={11} />
                    </i>
                  </div>
                )}
                {open && group.conversations.map(renderConversation)}
                {open && group.conversations.length === 0 && <span className="rail-empty">Pasta vazia.</span>}
              </div>
            );
          })}
        </>
      )}
    </>
  );
}
