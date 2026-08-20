// A JAULA: o modelo de aprovação do turno em sandbox, decidido pelo dono.
//
// Com o sandbox universal, o turno de modelo trabalha numa CÓPIA (staging) e o
// proc.run de trabalho roda num container. Nesse turno, pedir aprovação a cada
// gesto virou teatro: a gravação acontece na cópia — o projeto da pessoa não
// muda — e o comando roda isolado do computador dela. O modelo acordado é:
//
//   - gesto DENTRO da jaula NÃO pergunta: efeito de arquivo na cópia e
//     execução no container viram ALLOW com um KindNotice curto ("no sandbox:
//     <gesto>") — o chip visível — e o log integral de sempre (tool.call e
//     tool.result continuam duráveis);
//   - a APROVAÇÃO ÚNICA é na ENTREGA: antes de promover staging→projeto com
//     mudança, um approval.request de entrega lista o que muda (ver
//     askEntrega em supervisor.go); recusa descarta a cópia e o turno fecha
//     honesto;
//   - SEM jaula (inplace — turno degradado, UI, staging desligado), vale o
//     modelo de hoje: aprovação por comando/gravação.
//
// # O que NUNCA relaxa, mesmo jaulado
//
// A lista fechada está em nuncaRelaxamNaJaula e é consultada ANTES do
// allowlist — defesa em profundidade: mesmo que uma dessas ferramentas seja
// adicionada por engano ao allowlist um dia, a proibição vence.
//
//   - secrets.scan (e qualquer uso de segredo): o cofre não é sandboxável —
//     o segredo lido dentro da jaula é o MESMO segredo de verdade;
//   - webhook.post, mcp.call, schedule.create: rede sensível — o que sai por
//     elas sai da jaula por definição;
//   - memory.write, schedule.remove: escrevem estado da PESSOA (memória,
//     agenda), fora da cópia;
//   - worktree.create, worktree.remove: agem no repositório REAL (o gerente de
//     worktrees é ancorado no projeto, não no root da execução);
//   - finetune.submit: manda dados ao provedor;
//   - diagnostics.run: executa na máquina da pessoa, não no container.
//
// Ferramenta que não está no allowlist também não relaxa — o mundo é fechado
// dos dois lados, e ferramenta nova nasce perguntando.
package supervisor

import (
	"context"
	"strings"
	"time"

	"aibot/gateway/internal/protocol"
	"aibot/gateway/internal/workspace"
)

// gestosConfinadosAJaula é o ALLOWLIST dos efeitos de ARQUIVO confinados ao
// root(ctx) da execução congelada — na jaula, esse root É a cópia. Cada
// entrada tem de escrever via root(ctx): as locais passam por resolveInside
// DENTRO deste processo, então o confinamento é fato, não promessa.
var gestosConfinadosAJaula = map[string]bool{
	// Locais do gateway, confinadas por resolveInside(root(ctx), …).
	"fs.write": true,
	"fs.patch": true,
	// git -C root(ctx): o efeito fica na cópia (cujo espelho nem carrega .git).
	"git.commit": true,
	// saveImage grava dentro de resolveInside(root(ctx), …).
	"image.generate": true,
}

// gestosDeHostConfinaveis são os efeitos de arquivo que rodam no APLICATIVO
// NATIVO com o root da execução injetado no despacho (comRootDaExecucao em
// tools.go — o conserto da varredura: elas escreviam na raiz da janela, fora
// da execução). Só relaxam quando Deps.HostHonraRoot declara que o host desta
// instalação OBEDECE o campo: o gateway injetar o root não confina nada se o
// outro lado o ignora — o efeito cairia no projeto real, sem cartão de gesto
// e fora do cartão de entrega, que é a definição da porta lateral. Enquanto o
// apps/desktop não lê o campo, estas continuam pedindo por comando, jauladas
// ou não.
var gestosDeHostConfinaveis = map[string]bool{
	"office.edit":   true,
	"office.export": true,
	"video.trim":    true,
	"video.concat":  true,
	"video.text":    true,
	"video.export":  true,
}

// nuncaRelaxamNaJaula é a lista do que continua PERGUNTANDO mesmo jaulado —
// ver o cabeçalho do arquivo para o porquê de cada uma. Consultada antes do
// allowlist, de propósito.
var nuncaRelaxamNaJaula = []string{
	"secrets.scan",
	"webhook.post",
	"mcp.call",
	"schedule.create",
	"memory.write",
	"schedule.remove",
	"worktree.create",
	"worktree.remove",
	"finetune.submit",
	"diagnostics.run",
}

// gestoNaJaula decide se ESTA chamada é um gesto dentro da jaula — e portanto
// não pergunta. Devolve o rótulo do chip quando relaxa.
//
// Jaulado = a execução do turno tem staging real (LocalStaging preenchido).
// Turno degradado para inplace NÃO é jaulado — a jaula não existiu, e o modelo
// por comando continua valendo, que é exatamente o rebaixamento combinado.
// A UI nunca chega aqui jaulada: OriginUI materializa inplace por decisão.
func (s *Supervisor) gestoNaJaula(ctx context.Context, sessionID string, call toolInvocation) (string, bool) {
	execution, ok := workspace.FromContext(ctx)
	if !ok || execution.LocalStaging == "" {
		return "", false
	}
	tool := strings.TrimSpace(call.Tool)
	for _, banida := range nuncaRelaxamNaJaula {
		if strings.EqualFold(banida, tool) {
			return "", false
		}
	}
	if gestosConfinadosAJaula[tool] {
		return "no sandbox: " + summarize(tool, call.Args), true
	}
	// Gesto de HOST só relaxa quando o host desta instalação honra o root
	// injetado — senão o confinamento seria uma promessa que o outro processo
	// não cumpre, e a jaula viraria porta lateral (ver o comentário do mapa).
	if gestosDeHostConfinaveis[tool] && s.deps.HostHonraRoot {
		return "no sandbox: " + summarize(tool, call.Args), true
	}
	// proc.run só relaxa quando o comando VAI para um container (EnvDocker).
	// A previsão é do Toolbox (a mesma decisão do despacho, sem executar);
	// sem previsor configurado, fecha — perguntar de novo é o lado seguro.
	if tool == "proc.run" && s.deps.ProcSandboxed != nil &&
		s.deps.ProcSandboxed(ctx, sessionID, call.Args) {
		return "no sandbox: " + summarize(tool, call.Args), true
	}
	return "", false
}

// avisoDeJaula publica o CHIP do gesto jaulado — o KindNotice efêmero que
// conta "isto rodou no sandbox" no lugar do cartão de aprovação. Efêmero como
// todo aviso: o registro durável do gesto são os tool.call/tool.result de
// sempre; reencenar o chip num replay descreveria um sandbox que já não existe.
func (s *Supervisor) avisoDeJaula(sessionID string, actor protocol.Actor, label string) {
	if s.deps.Bus == nil {
		return
	}
	s.deps.Bus.PublishEphemeral(sessionID, protocol.Envelope{
		V:       protocol.Version,
		TS:      time.Now().UTC(),
		Session: sessionID,
		Kind:    protocol.KindNotice,
		From:    actor,
		Payload: mustPayload(protocol.Notice{
			Icon:       "sandbox",
			Title:      label,
			Detail:     "executado no sandbox — o projeto só muda na entrega aprovada",
			Specialist: actor.Specialist,
		}),
	})
}
