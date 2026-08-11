/**
 * Lista de conversas reais para o rail dinâmico — reutilizada pelas abas.
 * Busca local opcional (filtra por conteúdo real das mensagens).
 */
import { useMemo, useState } from "react";
import { MessageCircle, Search, X } from "lucide-react";
import type { UiMode } from "@ai-orchestrator/contracts";
import { useApp } from "../lib/store";

function relativeTime(timestamp: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 60) return "agora";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h`;
  return `${Math.floor(seconds / 86400)} d`;
}

const fold = (value: string) =>
  value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");

export function RailConversations({ mode, searchable = false }: { mode: UiMode; searchable?: boolean }) {
  const conversations = useApp((state) => state.conversations[mode]);
  const active = useApp((state) => state.activeConversation[mode]);
  const loadConversation = useApp((state) => state.loadConversation);
  const deleteConversation = useApp((state) => state.deleteConversation);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const term = fold(query.trim());
    if (!term) return conversations;
    return conversations.filter((conversation) =>
      fold(`${conversation.title} ${conversation.messages.map((message) => message.content).join(" ")}`).includes(term)
    );
  }, [conversations, query]);

  return (
    <>
      {searchable && (
        <label className="rail-search">
          <Search size={13} />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Buscar no histórico…"
            aria-label="Buscar conversas"
          />
        </label>
      )}
      {filtered.length === 0 && (
        <span className="rail-empty">
          {query ? "Nada encontrado no histórico." : "Sem histórico ainda — envie pelo composer."}
        </span>
      )}
      {filtered.map((conversation) => (
        <button
          className={`rail-conversation ${conversation.id === active ? "active" : ""}`}
          key={conversation.id}
          title={conversation.title}
          onClick={() => loadConversation(mode, conversation.id)}
        >
          <MessageCircle size={14} />
          <span>{conversation.title}</span>
          <small>{relativeTime(conversation.updatedAt)}</small>
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
      ))}
    </>
  );
}
