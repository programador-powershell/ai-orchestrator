/**
 * Resolução de preset por TIPO DE ATIVIDADE.
 *
 * Um preset de fusion pode definir modelos específicos por aba (chat, code,
 * data…): ao rodar na aba X, os campos de `perMode[X]` sobrepõem o preset base
 * — o que não for definido lá continua vindo do base. Puro e testável.
 */
import type { FusionPreset, Mode, UiMode } from "@multiplike/contracts";

export function resolvePresetForMode(preset: FusionPreset, mode: Mode | UiMode): FusionPreset {
  const override = preset.perMode?.[mode as UiMode];
  if (!override) return preset;
  return {
    ...preset,
    strategy: override.strategy ?? preset.strategy,
    orchestrator: override.orchestrator ?? preset.orchestrator,
    executors: override.executors?.length ? override.executors : preset.executors
  };
}
