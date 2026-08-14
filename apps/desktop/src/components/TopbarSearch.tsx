"use client";

/**
 * Busca na barra superior — uma para o app inteiro, escopada na aba atual.
 *
 * O campo vivia dentro do rail, repetido em cada aba, ocupando uma linha da
 * coluna mais estreita da tela — a mesma coluna onde moram a árvore do
 * projeto, o schema e a equipe. Em cima ele existe UMA vez, aparece em toda
 * aba e devolve a altura para quem precisava dela.
 *
 * Busca só na aba selecionada de propósito. Varrer os dez módulos parece
 * generoso e não é: abrir um resultado de outro módulo obrigaria a trocar de
 * aba, ou seja, tirar a pessoa de onde ela estava para levá-la a uma conversa
 * que ela não pediu. Quem quer o Chat vai ao Chat e busca lá.
 */

import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";

import { Glyph } from "./icons";
import { searchConversations, type ConversationSearchResult } from "../lib/conversations";
import { useApp } from "../lib/store";

/** Teto de resultados na lista — é uma busca, não um relatório. */
const MAX_RESULTADOS = 8;

export function TopbarSearch() {
  const mode = useApp((state) => state.mode);
  const conversations = useApp((state) => state.conversations);
  const activeId = useApp((state) => state.activeConversation[state.mode]);
  // Turno em voo: abrir outra conversa agora enxertaria a resposta na errada.
  const sending = useApp((state) => state.threads[state.mode].sending);
  const loadConversation = useApp((state) => state.loadConversation);

  const [query, setQuery] = useState("");
  const [aberto, setAberto] = useState(false);
  const [destaque, setDestaque] = useState(0);
  const raizRef = useRef<HTMLDivElement>(null);
  const campoRef = useRef<HTMLInputElement>(null);

  const termo = query.trim();
  /**
   * A varredura acompanha a digitação com atraso, e não junto.
   *
   * `searchConversations` percorre todas as mensagens de todas as conversas
   * da aba. Mesmo depois de a normalização ficar ~20x mais barata, num
   * histórico grande isso é dezenas de milissegundos — o bastante para a
   * letra seguinte engasgar se a busca rodar no mesmo passe do teclado.
   * `useDeferredValue` deixa o campo responder na hora e a lista chegar
   * atrás, sem escolher um número mágico de milissegundos como um debounce
   * exigiria.
   *
   * O teto vai como ARGUMENTO, não como `.slice` depois: o trecho de cada
   * linha é a parte cara, e cortar aqui significava pagá-lo por conversa
   * encontrada para mostrar oito.
   */
  const termoAdiado = useDeferredValue(termo);
  const resultados = useMemo<ConversationSearchResult[]>(
    () => (termoAdiado ? searchConversations(conversations, termoAdiado, mode, MAX_RESULTADOS) : []),
    [conversations, termoAdiado, mode]
  );
  /** A lista está atrás do que foi digitado — serve para esmaecer enquanto alcança. */
  const buscando = termo !== termoAdiado;

  // Trocar de aba zera a busca: o termo era da conversa de lá, e manter o
  // texto com uma lista vazia embaixo parece defeito.
  useEffect(() => {
    setQuery("");
    setAberto(false);
  }, [mode]);

  useEffect(() => setDestaque(0), [termo]);

  /** Ctrl+K / Cmd+K de qualquer lugar — menos de dentro de um campo de texto. */
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        campoRef.current?.focus();
        campoRef.current?.select();
        setAberto(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (!aberto) return;
    function fora(event: PointerEvent) {
      if (!raizRef.current?.contains(event.target as Node)) setAberto(false);
    }
    document.addEventListener("pointerdown", fora);
    return () => document.removeEventListener("pointerdown", fora);
  }, [aberto]);

  function abrir(resultado: ConversationSearchResult) {
    if (sending || resultado.conversationId === activeId) {
      setAberto(false);
      return;
    }
    loadConversation(mode, resultado.conversationId);
    setQuery("");
    setAberto(false);
  }

  function aoTeclar(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setQuery("");
      setAberto(false);
      campoRef.current?.blur();
      return;
    }
    if (!resultados.length) return;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setDestaque((atual) => (atual + 1) % resultados.length);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setDestaque((atual) => (atual - 1 + resultados.length) % resultados.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      abrir(resultados[destaque]);
    }
  }

  const mostrandoLista = aberto && termo.length > 0;

  return (
    <div className="tbsearch" ref={raizRef}>
      <label className="tbsearch-campo">
        <Glyph name="ui/search" size={13} />
        <input
          ref={campoRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setAberto(true);
          }}
          onFocus={() => setAberto(true)}
          onKeyDown={aoTeclar}
          placeholder="Buscar nesta aba…"
          aria-label="Buscar nas conversas desta aba"
          spellCheck={false}
        />
        {/* O atalho fica escrito: sem isso ninguém descobre que existe. */}
        {!termo ? <kbd className="tbsearch-atalho">Ctrl K</kbd> : null}
      </label>

      {mostrandoLista ? (
        <div className={`tbsearch-lista glass-strong ${buscando ? "buscando" : ""}`} role="listbox" aria-label="Resultados">
          {resultados.length === 0 ? (
            <p className="tbsearch-vazio">Nada nesta aba para “{termo}”.</p>
          ) : (
            resultados.map((resultado, indice) => (
              <button
                key={resultado.conversationId}
                type="button"
                role="option"
                aria-selected={indice === destaque}
                className={`tbsearch-item ${indice === destaque ? "ativo" : ""}`}
                disabled={sending}
                onPointerEnter={() => setDestaque(indice)}
                onClick={() => abrir(resultado)}
              >
                <strong>{resultado.title}</strong>
                <span>{resultado.snippet}</span>
                <em>{resultado.matchCount}</em>
              </button>
            ))
          )}
          {sending ? <p className="tbsearch-vazio">Turno em andamento — espere para trocar de conversa.</p> : null}
        </div>
      ) : null}
    </div>
  );
}
