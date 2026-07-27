import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── MINA DESARMADA (achado da análise do Frigate, verificado em produção) ────
// `useNvenc = gpuAccel` dependia SÓ da configuração, sem saber o fabricante. Um
// admin clicando "Ativar GPU" num host INTEL (o hardware mais comum aqui) fazia o
// publisher emitir `-c:v h264_nvenc` num ffmpeg SEM NVENC. Com
// runOnDemandRestart=false, o publisher morre sem retry e sem fallback: cai a
// live de TODAS as câmeras H.265/com áudio da instalação.

test('NVENC só é emitido quando o pipeline de transcode DECLARA ter NVENC', () => {
  const src = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  assert.match(src, /const useNvenc = gpuAccel && this\.transcodePipelineHasNvenc\(\)/,
    'a flag de configuração sozinha não pode escolher NVENC');
  assert.match(src, /private transcodePipelineHasNvenc\(\)/);
});

test('a guarda é fail-safe: sem sinal explícito, assume CPU', () => {
  const src = readFileSync('src/camera-stream/mediamtx-proxy.service.ts', 'utf8');
  const i = src.indexOf('private transcodePipelineHasNvenc()');
  const corpo = src.slice(i, i + 400);
  // Só o literal "true" liga. Falso negativo custa desempenho; falso positivo
  // custa a LIVE — então o default tem de ser CPU.
  assert.match(corpo, /=== 'true'/, 'apenas "true" explícito habilita NVENC');
  assert.match(corpo, /\?\?\s*''/, 'ausência da variável deve virar string vazia (= CPU)');
});

test('a imagem de GPU acompanha a versão do MediaMTX de produção', () => {
  const dockerfile = readFileSync('../../infra/mediamtx-nvenc.Dockerfile', 'utf8');
  const m = dockerfile.match(/ARG MEDIAMTX_VERSION=v([\d.]+)/);
  assert.ok(m, 'a versão precisa estar fixada');
  const [maj, min] = m[1].split('.').map(Number);
  // A v1.9.3 que estava aqui REJEITA o mediamtx.yml de produção (hlsAllowOrigins),
  // então o container subia e morria. Qualquer coisa abaixo de 1.18 é a mina.
  assert.ok(maj > 1 || min >= 18, `MediaMTX ${m[1]} é antigo demais para o mediamtx.yml atual`);
});

test('o yml de produção realmente usa a chave que a versão antiga rejeitava', () => {
  const yml = readFileSync('../../infra/mediamtx.yml', 'utf8');
  assert.match(yml, /hlsAllowOrigins/, 'se esta chave sumir, o teste acima perde o sentido — revise');
});
