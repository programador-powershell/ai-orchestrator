// Medição do desmascaramento de frame — o único trecho do transporte que toca
// CADA byte que entra no gateway.
//
// Dois tamanhos porque a resposta é diferente em cada um: em 8 KiB (a resposta
// típica de um modelo, 4–12 KB) o custo some no ruído do resto do turno; em
// 1 MiB (o anexo, o arquivo colado, o diff grande) ele é trabalho de verdade e
// aparece no relógio. Otimizar o caso pequeno é enfeite; o grande é o que paga.
package transport

import (
	"math/rand"
	"testing"
)

// benchMask é fixa de propósito: máscara aleatória a cada iteração mediria
// também o gerador, e o que está em jogo aqui é o laço.
var benchMask = [4]byte{0xA3, 0x1F, 0x7C, 0x59}

// benchPayload devolve bytes pseudoaleatórios com semente fixa — mesmo dado em
// toda execução, para que duas medições sejam comparáveis.
func benchPayload(size int) []byte {
	source := rand.New(rand.NewSource(20260814))
	payload := make([]byte, size)
	for i := range payload {
		payload[i] = byte(source.Intn(256))
	}
	return payload
}

// As quatro medições chamam a função DIRETO, sem passá-la como valor. Um
// parâmetro func aqui seria mais curto e mediria errado: a chamada indireta
// impede a inlinização e paga um salto que não existe no caminho real, e o
// laço ingênuo (que é quase só corpo) sente isso muito mais que o laço em
// palavras. A repetição é o preço de comparar as duas nas mesmas condições.
func BenchmarkUnmask8KiB(b *testing.B) {
	payload := benchPayload(8 << 10)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		unmask(payload, benchMask)
	}
}

func BenchmarkUnmask1MiB(b *testing.B) {
	payload := benchPayload(1 << 20)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		unmask(payload, benchMask)
	}
}

// As duas medições abaixo são da forma INGÊNUA (byte a byte, com módulo). Elas
// ficam no repositório de propósito: são o "antes" desta otimização, medido na
// mesma execução e na mesma máquina que o "depois".
//
// Comparar contra um número anotado no commit de meses atrás compara também o
// laptop, o térmico e a versão do Go; comparar contra um benchmark irmão que
// roda no mesmo minuto compara só o código. É por isso que a versão antiga
// sobrevive como oráculo em vez de ser apagada.
// Todas reaplicam a máscara sobre o MESMO buffer a cada iteração. Como XOR é
// involutivo, o buffer volta ao estado original a cada duas iterações e nada
// precisa ser realocado — a medição fica só no laço, sem o custo de copiar o
// payload entrando na conta.
func BenchmarkUnmaskReference8KiB(b *testing.B) {
	payload := benchPayload(8 << 10)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		unmaskReference(payload, benchMask)
	}
}

func BenchmarkUnmaskReference1MiB(b *testing.B) {
	payload := benchPayload(1 << 20)
	b.SetBytes(int64(len(payload)))
	b.ReportAllocs()
	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		unmaskReference(payload, benchMask)
	}
}

/* ------------------------------ correção -------------------------------- */

// unmaskReference é a forma ingênua, byte a byte com módulo. Fica no teste como
// oráculo: qualquer versão esperta de unmask tem de concordar com ela em todo
// tamanho, principalmente nos que não são múltiplos de 4 nem de 8, que é onde
// um laço em palavras erra o alinhamento da cauda.
func unmaskReference(payload []byte, mask [4]byte) {
	for i := range payload {
		payload[i] ^= mask[i%4]
	}
}

func TestUnmaskMatchesReference(t *testing.T) {
	// Tamanhos escolhidos em volta das fronteiras: zero, menores que uma
	// palavra, exatamente uma, e restos de 1..7 bytes depois de várias.
	sizes := []int{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 15, 16, 17, 31, 32, 33, 63, 127, 1023, 4096, 8193}
	for _, size := range sizes {
		original := benchPayload(size)

		got := make([]byte, size)
		copy(got, original)
		unmask(got, benchMask)

		want := make([]byte, size)
		copy(want, original)
		unmaskReference(want, benchMask)

		for i := range want {
			if got[i] != want[i] {
				t.Fatalf("unmask com %d bytes: divergiu do oráculo no índice %d (0x%02X, esperado 0x%02X)",
					size, i, got[i], want[i])
			}
		}
	}
}

// A máscara é involutiva: aplicá-la duas vezes devolve o texto original. É essa
// propriedade que o benchmark usa para reaproveitar o buffer, e é ela que o
// protocolo usa para o cliente mascarar e o servidor desmascarar.
func TestUnmaskIsInvolutive(t *testing.T) {
	original := benchPayload(4097)
	buffer := make([]byte, len(original))
	copy(buffer, original)

	unmask(buffer, benchMask)
	unmask(buffer, benchMask)

	for i := range original {
		if buffer[i] != original[i] {
			t.Fatalf("unmask aplicada duas vezes deveria devolver o original; divergiu no índice %d", i)
		}
	}
}
