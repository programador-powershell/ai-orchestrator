package store

import (
	"fmt"
	"strings"
)

// ChildSession devolve a conversa DAQUELE bot pendurada nesta conversa,
// criando-a se ainda não existir.
//
// É o que transforma delegação em conversa de verdade. Antes, o Código chamado
// pelo Conversa respondia dentro da conversa do Conversa e sumia: não sobrava
// nada com que falar depois. Agora o trabalho dele mora numa conversa própria,
// que a barra lateral mostra aninhada sob a que a criou — e continuar ali fala
// com ele, sem passar pelo dono.
//
// Busca-ou-cria, e não cria-sempre: um bot chamado dez vezes na mesma conversa
// tem UMA conversa com dez trechos, e não dez conversas de um trecho. A chave é
// o par (pai, bot).
//
// O id é derivado do par de propósito: ele é estável, então duas chamadas
// simultâneas do mesmo bot convergem para a mesma pasta em vez de criarem duas.
func (s *Store) ChildSession(parentID, botID, title string) (SessionMeta, error) {
	parentID = strings.TrimSpace(parentID)
	botID = strings.TrimSpace(botID)
	if parentID == "" {
		return SessionMeta{}, fmt.Errorf("conversa filha sem conversa de origem")
	}
	if botID == "" {
		return SessionMeta{}, fmt.Errorf("conversa filha sem bot dono")
	}

	id := ChildSessionID(parentID, botID)
	if meta, err := s.GetSession(id); err == nil {
		return meta, nil
	}

	if strings.TrimSpace(title) == "" {
		title = botID
	}
	// O dono da conversa filha é o bot, e `Specialist` nasce igual: assim, quem
	// abrir e escrever continua falando com ELE — o roteamento por conversa já
	// respeita o último especialista, e aqui o último é o único.
	return s.CreateSession(SessionMeta{
		ID:         id,
		Title:      title,
		BotID:      botID,
		ParentID:   parentID,
		Specialist: botID,
	})
}

// ChildSessionID é a chave estável de (pai, bot).
//
// Exportado porque o cliente também precisa saber falar dela — abrir a conversa
// do Código de uma conversa é pedir este id.
//
// O separador é o hífen porque `safeID` o preserva: qualquer outro caractere
// viraria `_` no nome da pasta, e o id na tela deixaria de bater com o id em
// disco — divergência que só aparece no dia em que alguém for procurar o
// arquivo à mão.
func ChildSessionID(parentID, botID string) string {
	return parentID + "-" + botID
}
