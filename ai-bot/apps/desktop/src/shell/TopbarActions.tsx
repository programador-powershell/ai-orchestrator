/**
 * O slot da barra superior.
 *
 * A superfície ativa NÃO desenha barra própria: ela injeta os botões dela no
 * mesmo lugar físico da barra do app, por portal. É isso que sustenta a promessa
 * de tela única — trocar de especialista muda o conteúdo da barra, não empilha
 * uma segunda barra embaixo da primeira.
 */
import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

/** Um id, um host. Quem renderizar dois `TopbarSlot` quebra o portal em silêncio. */
const SLOT_ID = "topbar-actions";

/** O host. Vive dentro da `Topbar`, e só lá. */
export function TopbarSlot() {
  return <div id={SLOT_ID} className="topbar-actions" />;
}

export function TopbarActions({ children }: { children: ReactNode }) {
  // O host é procurado num efeito, e não no corpo do render, porque no primeiro
  // render da superfície o div do slot ainda não foi comitado no DOM. Guardar em
  // estado força o segundo render — que é quando o portal tem para onde ir.
  const [host, setHost] = useState<HTMLElement | null>(null);

  useEffect(() => {
    setHost(document.getElementById(SLOT_ID));
  }, []);

  if (!host) return null;
  return createPortal(children, host);
}

export default TopbarActions;
