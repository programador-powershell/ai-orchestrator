//! Cofre de credenciais do SISTEMA OPERACIONAL.
//!
//! No Windows isto é o Gerenciador de Credenciais: o segredo fica selado pela
//! conta do usuário, sob a proteção da DPAPI, e não em um arquivo do app.
//!
//! # A regra que este módulo existe para sustentar
//!
//! **Segredo NUNCA cruza para o webview.**
//!
//! O JS manda apenas um IDENTIFICADOR — o `account`, uma referência de segredo,
//! o nome de um conector. A leitura do valor acontece deste lado, e o valor sai
//! daqui direto para quem vai usá-lo (o cabeçalho da requisição, o processo
//! filho), nunca de volta para a tela.
//!
//! O motivo não é cerimônia. Um segredo que chega ao webview passa a existir no
//! heap do WebView2, e a partir daí ele está ao alcance de qualquer script que
//! execute na página, do devtools, do estado de um componente React que alguém
//! serializou "só para depurar" e do próximo relatório de erro que capture esse
//! estado. Nada disso precisa de um atacante para dar errado — basta um
//! `console.log` esquecido.
//!
//! Por isso NÃO existe aqui um `credential_read`. Se um dia alguém precisar do
//! valor, o certo é uma função nativa que USE o segredo e devolva o resultado,
//! não uma que o entregue.

use keyring::{Entry, Error as KeyringError};

/// Nome do serviço no cofre do SO.
///
/// É a primeira metade da chave (a outra é o `account`) e é o que agrupa tudo o
/// que o AI-BOT guardou. Mudar esta string não migra nada: as credenciais
/// antigas continuam no cofre, sob o nome antigo, invisíveis para o app — a
/// pessoa reabre o programa e todas as chaves "sumiram".
const SERVICE: &str = "AI-BOT";

/// Abre a entrada do cofre, recusando conta vazia.
///
/// A checagem existe porque `Entry::new(SERVICE, "")` é aceito por algumas
/// implementações e cria uma credencial anônima que ninguém consegue localizar
/// depois — um segredo gravado num lugar que o app não sabe mais ler. Falhar
/// na entrada é mais barato do que descobrir isso semanas depois.
fn entry(account: &str) -> Result<Entry, String> {
    let account = account.trim();
    if account.is_empty() {
        return Err("o cofre precisa de um identificador de conta".to_string());
    }
    Entry::new(SERVICE, account)
        .map_err(|error| format!("o cofre do sistema não respondeu para \"{account}\": {error}"))
}

/// Guarda (ou substitui) o segredo de uma conta.
#[tauri::command]
pub fn credential_store(account: String, token: String) -> Result<(), String> {
    if token.is_empty() {
        // Gravar vazio tem o efeito prático de apagar, mas com a interface
        // confirmando "salvo" — e o erro só aparece depois, como uma
        // autenticação que falha sem motivo aparente. Quem quer remover tem
        // `credential_delete`, que diz o que faz.
        return Err("segredo vazio: use a remoção para apagar a credencial".to_string());
    }
    entry(&account)?
        .set_password(&token)
        .map_err(|error| format!("não foi possível guardar a credencial no cofre: {error}"))
}

/// Diz se a conta TEM uma credencial guardada — e só isso.
///
/// # Por que o retorno é `bool` e não o segredo
///
/// A tela precisa responder uma pergunta de interface: mostro "configurar" ou
/// mostro "configurado, trocar"? Para isso, existir basta. Devolver o valor
/// resolveria a mesma pergunta e, de quebra, colocaria o segredo no webview
/// para sempre — ver o cabeçalho do módulo. `bool` é o menor dado que responde
/// à pergunta, e um `bool` vazado não é vazamento.
///
/// O valor lido do cofre é DESCARTADO na própria linha do `match`: ele nunca é
/// vinculado a um nome, nunca entra numa struct e nunca chega à serialização de
/// resposta do comando.
#[tauri::command]
pub fn credential_exists(account: String) -> Result<bool, String> {
    match entry(&account)?.get_password() {
        Ok(_) => Ok(true),
        // "Não existe" é uma RESPOSTA, não uma falha: é o estado normal da
        // primeira execução.
        Err(KeyringError::NoEntry) => Ok(false),
        // Já qualquer outro erro — cofre bloqueado, política de domínio
        // negando acesso, credencial ambígua — precisa subir como erro. Tratar
        // tudo como `false` (que é o atalho tentador aqui) faria a tela dizer
        // "configure sua chave" para quem já configurou, e a pessoa gravaria a
        // chave de novo, no mesmo cofre que continua sem responder.
        Err(error) => Err(format!("o cofre do sistema não pôde ser consultado: {error}")),
    }
}

/// Remove a credencial de uma conta.
#[tauri::command]
pub fn credential_delete(account: String) -> Result<(), String> {
    match entry(&account)?.delete_credential() {
        Ok(()) => Ok(()),
        // Remoção é IDEMPOTENTE: o estado desejado — "não há credencial para
        // esta conta" — já vale. Devolver erro faria o botão de remover
        // reclamar em voz alta justamente quando não há nada de errado, por
        // exemplo num segundo clique ou numa tela que ficou desatualizada.
        Err(KeyringError::NoEntry) => Ok(()),
        Err(error) => Err(format!("não foi possível remover a credencial do cofre: {error}")),
    }
}
