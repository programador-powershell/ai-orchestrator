# Comparação: Needle 2 baseline × Router Pro Small

Benchmark `router-bench-v1`, dataset `router-pro-v1`. Os números são medições
locais neste host, não metas declaradas.

| Métrica | Needle 2 baseline | Router Pro Small (perfil candidato) |
|---|---:|---:|
| Specialty accuracy | 15,0% | 91,7% |
| Capability accuracy | 10,0% | 66,7% |
| Hard-test specialty accuracy | não separado no baseline | 100,0% |
| High-confidence wrong route | não calculável por split | 0,0% |
| P50 / P95 | 1.883,4 / 2.384,5 ms | ainda não medido no engine |
| Pico de RAM | 44,2 MB | ainda não medido no engine |
| Artefato de pesos novo | não | não |

## Decisão

Nenhum modelo é promovido a `PRODUCTION`. O perfil Router Pro Small vence a
busca de 36 simulações e supera o baseline neste holdout, mas continua
`CANDIDATE`: não atingiu as metas de capability, calibration e fallback, e o
perfil ainda precisa ser executado no engine para medir latência/RAM reais.
Criar pesos LoRA agora eliminaria a confidence do Needle 2.0.5; isso violaria o
gate calibrado da especificação. A próxima iteração correta é ampliar dados
curados PT/EN, treinar Small/Large fora do runtime e calibrar um head externo
antes de repetir o mesmo benchmark versionado.
