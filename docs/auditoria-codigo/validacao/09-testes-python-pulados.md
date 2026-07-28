# Classificação dos testes Python pulados

## Execução observada

Comando:

```bash
python3 -m unittest discover -s services/ai-service-python/tests \
  -t services/ai-service-python -v
```

Resultado: 237 testes descobertos, **144 aprovados**, 0 falhas, 0 erros e
**93 pulados**, em aproximadamente 1,57 s.

Isso corrige a contagem do resumo da primeira etapa, que descrevia “237
aprovados e 93 pulados”. A saída objetiva do `unittest` nesta etapa foi
`Ran 237 tests` e `OK (skipped=93)`: os 93 fazem parte dos 237.

## Classificação obrigatória

| Motivo | Quantidade |
|---|---:|
| dependência ausente | **93** |
| hardware ausente | 0 |
| modelo ausente | 0 |
| serviço externo ausente | 0 |
| variável de ambiente | 0 |
| plataforma | 0 |
| teste explicitamente desativado | 0 |
| implementação incompleta | 0 |
| motivo desconhecido | 0 |

Todos os skips foram disparados por guards de import da stack local ausente:
OpenCV (`cv2`), `supervision` e, nos módulos de stream, dependências carregadas
junto de `stream_processor`. Nenhum dos 93 precisa de câmera, GPU, OpenVINO
real, modelo baixado ou serviço externo para executar: os testes usam arrays,
frames, mocks e inferência sintética.

## Contagem por mensagem de skip

| Mensagem declarada pelo teste | Quantidade |
|---|---:|
| `exige cv2 → roda no container` | 8 |
| `requer cv2 (MotionDetector) — container de teste` | 2 |
| `requer opencv (cv2) — roda no container do 0.3` | 27 |
| `requer cv2 + supervision (stack ML) — roda no container drac-ai-test-ml` | 6 |
| `requer cv2 + supervision (stack ML) — container drac-ai-test-ml` | 2 |
| `requer cv2 + supervision (stack ML)` | 19 |
| `requer cv2 + requests (importa stream_processor) — container ML` | 27 |
| `requer cv2 + requests — container ML` | 2 |
| **Total** | **93** |

## Cobertura por módulo

| Módulo | Pulados | Fluxo de produção coberto | Executável em CI sem hardware/modelo |
|---|---:|---|---|
| `test_detector_runtime_registry` | 2 | compatibilidade da factory do detector de movimento | sim |
| `test_motion_contrast_fastpath` | 8 | percentis/LUT do pré-processamento de movimento | sim |
| `test_motion_detector` | 27 | MOG2, warmup, zonas, caixas, mudança global, plano Y | sim |
| `test_object_detector` | 15 | filtros, tracking, pool, preprocess e resolução de modelo | sim, inferência fake |
| `test_object_detector_regions` | 12 | regiões pequenas, objetos estacionários, cache e sweep | sim |
| `test_stream_inference_state` | 10 | health/warmup/degradação da inferência | sim |
| `test_stream_logging` | 5 | redaction de RTSP e logging do stream | sim |
| `test_stream_motion_boxes` | 4 | overlay e confirmação semântica | sim |
| `test_stream_object_regions` | 10 | transformação de caixas e wiring do detector avançado | sim |
| **Total** | **93** | todos são fluxos ativos de produção | **sim** |

## CI e falso-verde

O workflow `.github/workflows/ci.yml:23-57` instala versões pinadas de
`opencv-python-headless`, `numpy`, `requests`, `onnxruntime` e `supervision`,
faz um import gate e executa a mesma suíte. Portanto, os 93 testes **devem
executar no CI atual**, sem mocks adicionais e sem hardware.

O workflow não verifica explicitamente que o número de skips é zero. O import
gate reduz muito o risco, mas um novo `skipUnless` por outro motivo ainda
poderia produzir verde. Recomenda-se um runner que falhe se houver skip não
incluído em allowlist vazia.

`Dockerfile.test.ml` e `run-ml-tests.sh` também fornecem o ambiente correto.
Eles não foram usados nesta etapa porque construir imagem instala
dependências/altera o estado Docker, vedado pela restrição.

## Prioridade dos grupos

1. **Alta:** `stream_logging` — inclui redaction de credenciais RTSP.
2. **Alta:** `stream_inference_state` — evita health falso e inferência
   silenciosamente travada.
3. **Alta:** `motion_detector` — governa eventos e gravação por movimento.
4. **Alta:** `object_detector` e `object_detector_regions` — tracking,
   classificação e uso de recursos.
5. **Média:** fastpath, registry e adapters de caixas, que protegem
   equivalência e regressões de performance/wiring.

Não há justificativa para tratar os 93 como cobertura opcional: todos alcançam
código de produção.
