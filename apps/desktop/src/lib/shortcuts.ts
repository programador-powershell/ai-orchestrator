/** Atalhos globais do shell — lógica pura, testável fora do DOM. */

/** Ctrl/Cmd+1..9 → modo visível correspondente (1-indexado). */
export function modeForDigitKey<T>(key: string, modes: readonly T[]): T | null {
  if (!/^[1-9]$/.test(key)) return null;
  const index = Number(key) - 1;
  return index < modes.length ? modes[index] : null;
}

interface ModifierKeyEvent {
  ctrlKey: boolean;
  metaKey: boolean;
  key: string;
}

/** Ctrl+, (ou Cmd+, no macOS) abre as Configurações — padrão de apps desktop. */
export function isSettingsShortcut(event: ModifierKeyEvent): boolean {
  return (event.ctrlKey || event.metaKey) && event.key === ",";
}
