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
 * Needle. Se a assinatura de lá mudar, muda aqui e em nenhum outro lugar.
 *
 * ================== LEIA ANTES DE COMPILAR COM -tags needle ==================
 *
 * As chamadas marcadas com  >>> UPSTREAM <<<  precisam ser conferidas contra o
 * cabeçalho da release do Needle que você baixou (cactus-compute/needle). Elas
 * estão escritas contra a forma DOCUMENTADA da biblioteca — inicializa uma
 * sessão a partir de um arquivo de pesos, recebe prompt mais ferramentas em
 * formato function-calling e devolve JSON — mas o nome exato dos símbolos e a
 * ordem dos parâmetros são detalhe da versão, e conferir isso exige o header na
 * mão.
 *
 * Enquanto isso não for conferido numa máquina com a biblioteca, o projeto
 * compila e roda sem a tag `needle`: o esboço em session_stub.go assume, a
 * cascata pula o degrau local e o roteamento fica fast router → modelo grande.
 * Ligar a tag sem conferir daria erro de LINK, não comportamento errado em
 * silêncio — que é a falha certa para se ter aqui.
 *
 * A biblioteca também é dependência de terceiro em processo que decide
 * roteamento e lê o prompt do usuário: precisa passar por TI/SI antes de virar
 * padrão (política da casa, item 4). A tag de build é o interruptor.
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
