/**
 * Busca por conteúdo — o overlay do Ctrl+K.
 *
 * A varredura é do GATEWAY (GET /v1/sessions/search): as linhas do store são só
 * a conversa aberta, e buscar nelas responderia "onde falei disso?" apenas para
 * a conversa que a pessoa já está vendo. O overlay manda o termo, o gateway
 * varre os logs e devolve sessão + trecho; clicar (ou Enter) abre a conversa.
 *
 * Auto-suficiente de propósito: o atalho, o estado aberto/fechado e a busca
 * moram aqui dentro — o resto do app não ganhou prop nem campo de store novo
 * por causa de um overlay que quase sempre está fechado.
 *
 * `buscar` é injetável SÓ para teste: o padrão fala com o transporte ativo.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react";
import { MessagesSquare, Search } from "lucide-react";
import { activeTransport, useApp } from "../lib/store";

/** Um resultado como o gateway devolve (store.SearchHit do Go). */
export interface SearchHit {
  session: string;
  title: string;
  seq: number;
  turn?: string;
  role: string;
  snippet: string;
  updatedAt: string;
}

export type Buscar = (query: string) => Promise<SearchHit[]>;

/** Espera entre a tecla e a ida à rede: digitação normal não vira dez buscas. */
const DEBOUNCE_MS = 200;

async function buscarNoGateway(query: string): Promise<SearchHit[]> {
  const transport = activeTransport();
  if (transport === null) throw new Error("sem conexão com o gateway");
  const body = await transport.get(`/v1/sessions/search?q=${encodeURIComponent(query)}`);
  const results = (body as { results?: unknown } | undefined)?.results;
  return Array.isArray(results) ? (results as SearchHit[]) : [];
}

export function SearchOverlay({ buscar = buscarNoGateway }: { buscar?: Buscar }): ReactNode {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [selected, setSelected] = useState(0);
  const [failure, setFailure] = useState("");
  const openSession = useApp((state) => state.openSession);

  const field = useRef<HTMLInputElement | null>(null);
  /** Carimbo da última busca disparada: resposta atrasada de termo velho não pinta a lista. */
  const stamp = useRef(0);

  // O atalho é GLOBAL e vive aqui: registrar no App obrigaria o shell a saber
  // que a busca existe. Ctrl+K abre (e foca); Escape fecha só o overlay.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && (event.key === "k" || event.key === "K")) {
        event.preventDefault();
        setOpen((value) => !value);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    if (!open) return;
    field.current?.focus();
  }, [open]);

  // A busca com debounce. O carimbo resolve a corrida clássica: a resposta de
  // "de" não pode chegar DEPOIS da de "deploy" e sobrescrevê-la.
  useEffect(() => {
    if (!open) return;
    const term = query.trim();
    if (term === "") {
      setHits([]);
      setFailure("");
      return;
    }
    const mine = stamp.current + 1;
    stamp.current = mine;
    const timer = window.setTimeout(() => {
      buscar(term).then(
        (results) => {
          if (stamp.current !== mine) return;
          setHits(results);
          setSelected(0);
          setFailure("");
        },
        (cause: unknown) => {
          if (stamp.current !== mine) return;
          setHits([]);
          setFailure(cause instanceof Error ? cause.message : "a busca falhou");
        }
      );
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [open, query, buscar]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery("");
    setHits([]);
    setSelected(0);
    setFailure("");
  }, []);

  const openHit = useCallback(
    (hit: SearchHit | undefined) => {
      if (!hit) return;
      openSession(hit.session);
      close();
    },
    [openSession, close]
  );

  const onFieldKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelected((value) => Math.min(value + 1, Math.max(hits.length - 1, 0)));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelected((value) => Math.max(value - 1, 0));
        return;
      }
      if (event.key === "Enter") {
        event.preventDefault();
        openHit(hits[selected]);
      }
    },
    [close, hits, selected, openHit]
  );

  if (!open) return null;

  return (
    /* O clique no pano de fundo fecha; o clique DENTRO do cartão não — o
       stopPropagation é o que separa os dois. */
    <div className="search-overlay" onClick={close} role="presentation">
      <div
        className="search-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Buscar nas conversas"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="search-field">
          <Search size={15} aria-hidden />
          <input
            ref={field}
            type="text"
            value={query}
            placeholder="Buscar nas conversas…"
            aria-label="Termo da busca"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onFieldKeyDown}
          />
          <kbd>esc</kbd>
        </div>

        {failure !== "" ? <p className="search-failure">{failure}</p> : null}

        {query.trim() !== "" && failure === "" && hits.length === 0 ? (
          <p className="search-empty">Nada com “{query.trim()}” nas conversas salvas.</p>
        ) : null}

        {hits.length > 0 ? (
          <ul className="search-results" role="listbox" aria-label="Resultados">
            {hits.map((hit, index) => (
              <li key={`${hit.session}-${hit.seq}`}>
                <button
                  type="button"
                  className="search-hit"
                  role="option"
                  aria-selected={index === selected}
                  data-selected={index === selected}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => openHit(hit)}
                >
                  <span className="search-hit-title">
                    <MessagesSquare size={13} aria-hidden />
                    {hit.title === "" ? hit.session : hit.title}
                  </span>
                  <span className="search-hit-snippet">{hit.snippet}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}

export default SearchOverlay;
