/*
 * ABI do AI-BOT para o roteador local.
 *
 * Esta é a NOSSA fronteira, não a do Needle. Ela existe por um motivo prático:
 * a API C de uma biblioteca de terceiro muda entre versões, e se o cgo do Go
 * chamasse os símbolos dela direto, cada atualização quebraria o Go, o build e
 * o teste ao mesmo tempo. Aqui o Go fala com seis funções que não mudam, e
 * needle_shim.c é o ÚNICO arquivo que sabe o nome das funções de lá.
 *
 * Trocar de versão do Needle (ou trocar o Needle por outro modelo pequeno) é
 * reescrever needle_shim.c. Nada mais.
 *
 * Convenções:
 *   - toda função devolve 0 em sucesso e um código negativo em falha;
 *   - string devolvida ao Go é alocada com malloc e liberada com
 *     aibot_needle_free — liberar com free() do Go seria misturar dois
 *     alocadores, que no Windows é falha de verdade e não teoria;
 *   - aibot_needle_last_error() devolve ponteiro para buffer estático por
 *     thread, válido até a próxima chamada na mesma thread.
 */

#ifndef AIBOT_NEEDLE_SHIM_H
#define AIBOT_NEEDLE_SHIM_H

#ifdef __cplusplus
extern "C" {
#endif

typedef void *aibot_needle_handle;

#define AIBOT_NEEDLE_OK 0
#define AIBOT_NEEDLE_ERR_ARGS -1
#define AIBOT_NEEDLE_ERR_LOAD -2
#define AIBOT_NEEDLE_ERR_CALL -3
#define AIBOT_NEEDLE_ERR_MEMORY -4

/* Abre a sessão. `model_path` é o arquivo de pesos; `threads` e `max_tokens`
 * aceitam 0 para "decida você". */
int aibot_needle_open(const char *model_path, int threads, int max_tokens,
                      aibot_needle_handle *out);

/* Uma classificação. `tools_json` é o array de ferramentas no formato
 * function-calling; `out_json` recebe a resposta do modelo (malloc). */
int aibot_needle_call(aibot_needle_handle handle, const char *prompt,
                      const char *tools_json, char **out_json);

/* Libera string devolvida por aibot_needle_call. */
void aibot_needle_free(char *pointer);

/* Fecha a sessão. Seguro com handle nulo. */
void aibot_needle_close(aibot_needle_handle handle);

/* Última mensagem de erro desta thread. Nunca nulo. */
const char *aibot_needle_last_error(void);

/* Versão da biblioteca subjacente, para o log de subida dizer com o que está
 * falando. Nunca nulo. */
const char *aibot_needle_version(void);

#ifdef __cplusplus
}
#endif

#endif /* AIBOT_NEEDLE_SHIM_H */
