//! Régua de desempenho dos caminhos quentes — só existe em teste.
//!
//! # Por que uma régua nossa, e não o `criterion`
//!
//! Toda dependência deste projeto passa por homologação de TI/SI, uma a uma
//! (ver o cabeçalho do `Cargo.toml`). Trazer um framework de benchmark inteiro
//! — com a árvore de crates que ele arrasta — para medir quatro funções seria
//! superfície nova a aprovar em troca de estatística que não vamos usar. O que
//! precisamos é bem menor: rodar o mesmo cenário N vezes e olhar a MEDIANA.
//!
//! # Por que MEDIANA e não média
//!
//! A máquina de quem mede é a mesma que compila, indexa e roda antivírus. Uma
//! pausa de 40 ms no meio de uma rodada contamina a média para sempre e some
//! na mediana. Média aqui mediria o Windows, não o código.
//!
//! # Por que aquecer
//!
//! A primeira rodada paga o que as seguintes não pagam: páginas de memória que
//! o alocador ainda não tocou, cache de instrução frio, o corpus recém-montado
//! ainda longe do L2. Medi-la junto compara "a primeira vez" com "as outras", e
//! a conclusão sai errada nos dois sentidos.
//!
//! # Por que os benchmarks ficam no repositório
//!
//! Regressão que ninguém mede volta. Eles são `#[ignore]` para não pesarem na
//! suíte normal — o portão de todo dia é `cargo test --lib`, que continua em
//! segundos. A medição é sob demanda:
//!
//! ```text
//! cargo test --release -- --ignored --nocapture
//! ```
//!
//! **`--release` não é detalhe.** Em debug, o `opt-level=0` mede o compilador
//! sem otimização, não o produto que a pessoa instala: os números saem de 10 a
//! 50 vezes piores e, pior, na proporção ERRADA entre as funções — o que faz a
//! medição apontar para o lugar errado.

use std::time::{Duration, Instant};

/// Rodadas medidas de cada cenário. Ímpar de propósito: com número ímpar a
/// mediana é um valor observado de verdade, não a média dos dois do meio.
pub const ROUNDS: usize = 9;

/// Roda `cenario` uma vez para aquecer e `ROUNDS` vezes medindo; devolve a
/// mediana.
///
/// O retorno do cenário é devolvido junto (o último) para quem chama poder
/// afirmar algo sobre o resultado — um benchmark cujo resultado não é
/// observado é um benchmark que o otimizador tem o direito de apagar inteiro.
pub fn median<T>(mut cenario: impl FnMut() -> T) -> (Duration, T) {
    let _aquecimento = cenario();
    let mut tempos = Vec::with_capacity(ROUNDS);
    let mut ultimo = None;
    for _ in 0..ROUNDS {
        let comecou = Instant::now();
        let saida = cenario();
        tempos.push(comecou.elapsed());
        ultimo = Some(saida);
    }
    tempos.sort_unstable();
    (
        tempos[ROUNDS / 2],
        ultimo.expect("ROUNDS é constante maior que zero"),
    )
}

/// Imprime o resultado no formato que a gente compara entre commits.
pub fn report(nome: &str, carga: &str, tempo: Duration, unidades: f64, unidade: &str) {
    let ms = tempo.as_secs_f64() * 1000.0;
    let taxa = if ms > 0.0 {
        unidades / (ms / 1000.0)
    } else {
        f64::INFINITY
    };
    println!("[bench] {nome:<28} {carga:<28} mediana {ms:>9.3} ms  ({taxa:>12.1} {unidade}/s)");
}
