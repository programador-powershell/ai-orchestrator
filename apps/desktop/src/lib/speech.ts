/**
 * Modo voz — núcleo puro sobre a Web Speech API.
 *
 * Nada aqui toca no DOM nem no `window` global: a janela entra por parâmetro,
 * então o ditado e a fala rodam em Node com dublês (speech.test.ts) e no Tauri
 * com a janela real. Os tipos são estruturais de propósito — o `lib.dom` só
 * declara `speechSynthesis`, e `SpeechRecognition` sequer existe no TS padrão.
 */

export interface SpeechAlternative {
  transcript: string;
}

export interface SpeechResult {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechAlternative;
}

export interface SpeechResultEvent {
  /** Primeiro resultado novo do evento; o motor reenvia os anteriores. */
  resultIndex?: number;
  results: ArrayLike<SpeechResult>;
}

export interface SpeechErrorEvent {
  error?: string;
  message?: string;
}

export interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
}

export interface SpeechVoiceLike {
  lang: string;
  name: string;
}

export interface SpeechUtteranceLike {
  lang: string;
  rate: number;
  voice?: SpeechVoiceLike | null;
  onend: (() => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
}

export interface SpeechSynthesisLike {
  speak(utterance: SpeechUtteranceLike): void;
  cancel(): void;
  getVoices?(): SpeechVoiceLike[];
}

export interface SpeechWindow {
  SpeechRecognition?: new () => SpeechRecognitionLike;
  webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  speechSynthesis?: SpeechSynthesisLike;
  SpeechSynthesisUtterance?: new (text: string) => SpeechUtteranceLike;
}

export const DEFAULT_SPEECH_LANG = "pt-BR";

type MaybeWindow = SpeechWindow | null | undefined;

/**
 * Janela do navegador já no formato do núcleo — null no render do servidor.
 * A UI usa isto em vez de converter `window` na mão.
 */
export function speechWindow(): SpeechWindow | null {
  return typeof window === "undefined" ? null : (window as unknown as SpeechWindow);
}

/* -------------------------------- Suporte -------------------------------- */

function recognitionCtor(win: MaybeWindow): (new () => SpeechRecognitionLike) | null {
  return win?.SpeechRecognition ?? win?.webkitSpeechRecognition ?? null;
}

export function isDictationSupported(win: MaybeWindow): boolean {
  return recognitionCtor(win) !== null;
}

export function isSpeechOutputSupported(win: MaybeWindow): boolean {
  return !!win?.speechSynthesis && typeof win.SpeechSynthesisUtterance === "function";
}

/** Modo voz completo: ouvir e falar. */
export function isSpeechSupported(win: MaybeWindow): boolean {
  return isDictationSupported(win) && isSpeechOutputSupported(win);
}

/* --------------------------------- Ditado -------------------------------- */

export interface DictationOptions {
  lang?: string;
  /** Transcrição acumulada + o trecho interino em andamento. */
  onText?: (text: string, isFinal: boolean) => void;
  onError?: (message: string) => void;
  onEnd?: () => void;
  continuous?: boolean;
}

export interface Dictation {
  start(): void;
  stop(): void;
}

const RECOGNITION_ERRORS: Record<string, string> = {
  "not-allowed": "Permissão de microfone negada.",
  "service-not-allowed": "Permissão de microfone negada.",
  "no-speech": "Nada foi captado pelo microfone.",
  "audio-capture": "Nenhum microfone disponível.",
  network: "Falha de rede no reconhecimento de voz."
};

const join = (left: string, right: string) => (left && right ? `${left} ${right}` : left || right);

/**
 * Ditado contínuo. A transcrição acumula enquanto a instância viver — uma
 * instância por sessão de voz; para começar do zero, crie outra.
 */
export function createDictation(win: MaybeWindow, options: DictationOptions = {}): Dictation {
  const { lang = DEFAULT_SPEECH_LANG, onText, onError, onEnd, continuous = true } = options;
  let recognition: SpeechRecognitionLike | null = null;
  let transcript = "";

  function handleResult(event: SpeechResultEvent) {
    const results = event.results;
    let interim = "";
    let final = false;
    for (let index = event.resultIndex ?? 0; index < results.length; index += 1) {
      const result = results[index];
      const text = result?.[0]?.transcript?.trim() ?? "";
      if (!text) continue; // intermediário vazio: ruído, não atualiza nada
      if (result.isFinal) {
        transcript = join(transcript, text);
        final = true;
      } else {
        interim = join(interim, text);
      }
    }
    if (!final && !interim) return;
    onText?.(join(transcript, interim), final && !interim);
  }

  return {
    start() {
      if (recognition) return;
      const Recognition = recognitionCtor(win);
      if (!Recognition) {
        onError?.("Reconhecimento de voz indisponível neste ambiente.");
        return;
      }

      const instance = new Recognition();
      instance.lang = lang;
      instance.continuous = continuous;
      instance.interimResults = true;
      instance.onresult = handleResult;
      instance.onerror = (event) => {
        // "aborted" é o eco da própria parada — não vira erro na tela.
        if (event.error === "aborted") return;
        onError?.(
          RECOGNITION_ERRORS[event.error ?? ""] ??
            event.message ??
            `Falha no reconhecimento de voz (${event.error ?? "desconhecida"}).`
        );
      };
      instance.onend = () => {
        if (recognition !== instance) return;
        recognition = null;
        onEnd?.();
      };

      recognition = instance;
      try {
        instance.start();
      } catch (error) {
        recognition = null;
        onError?.(error instanceof Error ? error.message : String(error));
      }
    },

    stop() {
      const instance = recognition;
      if (!instance) return;
      recognition = null;
      instance.onresult = null;
      instance.onerror = null;
      instance.onend = null;
      try {
        instance.stop();
      } catch {
        // motor já parado: nada a fazer
      }
      onEnd?.();
    }
  };
}

/* ---------------------------------- Fala --------------------------------- */

export interface SpeakOptions {
  lang?: string;
  rate?: number;
}

/** Cancelamento pedido pelo app não é falha — resolve como fim normal. */
const CANCELED = new Set(["interrupted", "canceled", "cancelled"]);

function pickVoice(synthesis: SpeechSynthesisLike, lang: string): SpeechVoiceLike | null {
  const voices = synthesis.getVoices?.() ?? [];
  const wanted = lang.toLowerCase();
  const normalize = (value: string) => (value ?? "").toLowerCase().replace("_", "-");
  return (
    voices.find((voice) => normalize(voice.lang) === wanted) ??
    voices.find((voice) => normalize(voice.lang).startsWith(wanted.slice(0, 2))) ??
    null
  );
}

/** Lê o texto em voz alta; resolve quando a locução termina. */
export function speak(win: MaybeWindow, text: string, options: SpeakOptions = {}): Promise<void> {
  const { lang = DEFAULT_SPEECH_LANG, rate = 1 } = options;
  const synthesis = win?.speechSynthesis;
  const Utterance = win?.SpeechSynthesisUtterance;
  if (!text.trim() || !synthesis || typeof Utterance !== "function") return Promise.resolve();

  return new Promise((resolve, reject) => {
    const utterance = new Utterance(text);
    utterance.lang = lang;
    utterance.rate = Math.min(2, Math.max(0.5, rate));
    const voice = pickVoice(synthesis, lang);
    if (voice) utterance.voice = voice;

    let settled = false;
    const settle = (fail?: Error) => {
      if (settled) return;
      settled = true;
      utterance.onend = null;
      utterance.onerror = null;
      if (fail) reject(fail);
      else resolve();
    };

    utterance.onend = () => settle();
    utterance.onerror = (event) => {
      const code = event.error ?? "";
      settle(CANCELED.has(code) ? undefined : new Error(event.message ?? `Falha na síntese de voz (${code}).`));
    };
    synthesis.speak(utterance);
  });
}

/** Corta a fila da síntese (usuário mandou calar). */
export function stopSpeaking(win: MaybeWindow): void {
  win?.speechSynthesis?.cancel();
}
