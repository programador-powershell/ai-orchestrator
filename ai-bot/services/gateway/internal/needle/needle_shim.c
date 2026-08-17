//go:build needle

/*
 * A restrição de build acima acompanha a de session_cgo.go, e sem ela o pacote
 * não compila em máquina nenhuma que tenha um compilador C.
 *
 * O motivo é indireto: `CGO_ENABLED` vale 1 por padrão onde há gcc, e aí o Go
 * passa a considerar os arquivos .c do pacote. Sem a tag `needle`, nenhum .go
 * ativo importa "C" — e um .c sem cgo é erro de compilação, não arquivo
 * ignorado. Nesta estação, que não tem compilador C, `CGO_ENABLED` é 0, os .c
 * nem são olhados e o build passa; num CI com gcc, `go build ./...` quebraria
 * na primeira execução, sem que nada tivesse mudado no código.
 *
 * PONTO DE ADAPTAÇÃO — este é o único arquivo do projeto que conhece a API C do
 * motor. Se a assinatura de lá mudar, muda aqui e em nenhum outro lugar.
 *
 * ================== LEIA ANTES DE COMPILAR COM -tags needle ==================
 *
 * ATENÇÃO: o esboço abaixo foi escrito contra uma API `needle_*` que NÃO EXISTE.
 * A conferência do upstream (agosto/2026) mostrou outra coisa:
 *
 *   - `cactus-compute/needle` (Apache-2.0, fixado em v2.0.5 pelo
 *     needle-router-pro/config/upstream.lock.json) é um pacote PYTHON de
 *     inferência e fine-tuning LoRA — `pip install cactus-needle`. Não é uma
 *     biblioteca C, e não existe `needle.h`.
 *   - Quem tem API C é `cactus-compute/cactus`, o motor de inferência: header
 *     `cactus_engine.h`, entrada `cactus_init`. E `cactus_init` carrega os pesos
 *     de um DIRETÓRIO, não de um arquivo — a diferença muda a assinatura e muda
 *     também o que `ResolveModelPath` precisa devolver.
 *
 * Ou seja: ligar a tag hoje dá erro de compilação no `#include`, antes mesmo do
 * link. É a falha certa para se ter aqui — barulhenta e imediata —, mas é bom
 * saber que ela virá do header, e não de um símbolo.
 *
 * Quem for reconciliar isto precisa do header na mão. Os marcadores
 * >>> UPSTREAM <<< abaixo dizem exatamente o que conferir em cada ponto.
 *
 * Enquanto isso, o projeto compila e roda sem a tag `needle`: o esboço em
 * session_stub.go assume, a cascata pula o degrau local e o roteamento fica
 * fast router → modelo grande. Desde a calibração do léxico por palavra inteira,
 * os pedidos comuns já decidem no PRIMEIRO degrau, então o degrau local rende
 * menos do que rendia — vale medir antes de investir na integração.
 *
 * DUAS TRAVAS ANTES DE ISTO VIRAR PADRÃO, e nenhuma delas é técnica:
 *   1. `cactus` é um projeto SEPARADO e a licença dele não foi verificada aqui;
 *      a Apache-2.0 do lock cobre o `needle`, não o motor.
 *   2. É dependência de terceiro DENTRO do processo que lê o prompt do usuário e
 *      decide roteamento. Vai a TI/SI antes (política da casa, item 4). A tag de
 *      build é o interruptor.
 * ============================================================================
 */

#include "needle_shim.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* >>> UPSTREAM <<< cabeçalho da biblioteca. O caminho vem do -I passado no
 * cgo CFLAGS (ver session_cgo.go). */
#include "needle.h"

/* Buffer de erro por thread. `_Thread_local` é C11; o MSVC aceita
 * __declspec(thread) e o MinGW/Clang aceitam _Thread_local. Sem "por thread" a
 * mensagem de erro de uma goroutine apareceria na outra — e o Go move goroutine
 * entre threads o tempo todo. */
#if defined(_MSC_VER)
#define AIBOT_TLS __declspec(thread)
#else
#define AIBOT_TLS _Thread_local
#endif

static AIBOT_TLS char aibot_error[512] = {0};

static void set_error(const char *message) {
  if (message == NULL) {
    aibot_error[0] = '\0';
    return;
  }
  snprintf(aibot_error, sizeof(aibot_error), "%s", message);
}

const char *aibot_needle_last_error(void) { return aibot_error; }

const char *aibot_needle_version(void) {
  /* >>> UPSTREAM <<< troque pela função de versão da release. */
  return needle_version();
}

int aibot_needle_open(const char *model_path, int threads, int max_tokens,
                      aibot_needle_handle *out) {
  if (model_path == NULL || out == NULL) {
    set_error("caminho do modelo ou saida nula");
    return AIBOT_NEEDLE_ERR_ARGS;
  }
  *out = NULL;

  /* >>> UPSTREAM <<< inicialização da sessão.
   * Espera-se algo como needle_init(caminho, opcoes) devolvendo um ponteiro
   * opaco, ou NULL em falha. */
  needle_options options;
  memset(&options, 0, sizeof(options));
  options.n_threads = threads;
  options.n_predict = max_tokens;

  needle_context *context = needle_init(model_path, &options);
  if (context == NULL) {
    set_error("nao foi possivel carregar o modelo local");
    return AIBOT_NEEDLE_ERR_LOAD;
  }

  *out = (aibot_needle_handle)context;
  set_error(NULL);
  return AIBOT_NEEDLE_OK;
}

int aibot_needle_call(aibot_needle_handle handle, const char *prompt,
                      const char *tools_json, char **out_json) {
  if (handle == NULL || prompt == NULL || tools_json == NULL ||
      out_json == NULL) {
    set_error("argumentos invalidos");
    return AIBOT_NEEDLE_ERR_ARGS;
  }
  *out_json = NULL;

  /* >>> UPSTREAM <<< a chamada de tool calling.
   * Espera-se que devolva uma string JSON alocada pela biblioteca — e é por
   * isso que copiamos para o NOSSO malloc antes de soltar a dela: o Go vai
   * liberar por aibot_needle_free, e liberar memória de outro alocador é o
   * tipo de falha que só aparece em produção, no Windows, sob carga. */
  char *raw = needle_tool_call((needle_context *)handle, prompt, tools_json);
  if (raw == NULL) {
    set_error("o modelo local nao devolveu resposta");
    return AIBOT_NEEDLE_ERR_CALL;
  }

  size_t length = strlen(raw);
  char *copy = (char *)malloc(length + 1);
  if (copy == NULL) {
    /* >>> UPSTREAM <<< liberação da string da biblioteca. */
    needle_free_string(raw);
    set_error("sem memoria para a resposta");
    return AIBOT_NEEDLE_ERR_MEMORY;
  }
  memcpy(copy, raw, length + 1);

  /* >>> UPSTREAM <<< */
  needle_free_string(raw);

  *out_json = copy;
  set_error(NULL);
  return AIBOT_NEEDLE_OK;
}

void aibot_needle_free(char *pointer) {
  if (pointer != NULL) {
    free(pointer);
  }
}

void aibot_needle_close(aibot_needle_handle handle) {
  if (handle == NULL) {
    return;
  }
  /* >>> UPSTREAM <<< */
  needle_free((needle_context *)handle);
}
