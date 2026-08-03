import { test } from 'node:test';
import assert from 'node:assert/strict';

// ─────────────────────────────────────────────────────────────────────────────
// O RETESTE ATIVO PRECISA SER PARALELO, COM TETO
//
// Medido na simulação de capacidade (2026-08-03): o laço era sequencial e cada
// reteste custa ~11 s de sonda RTSP+ONVIF. Com 25 câmeras, 10 entraram em
// reteste = 110 s de fila num ciclo que roda a cada 60 s. A fila não fechava.
//
// O efeito prático não é CPU — é DEMORA PARA PERCEBER CÂMERA CAÍDA. Extrapolado,
// ~7 minutos numa instalação de 200 câmeras. Num sistema de segurança é esse
// número que define a promessa comercial.
//
// Mas o oposto quebra igual: disparar N sondas de uma vez contra o mesmo DVR
// esgota as sessões RTSP do equipamento e derruba as câmeras que se queria
// testar (foi a tempestade de ffprobe de 30/07). Por isso TETO, não paralelismo
// livre.
//
// Estes testes fixam as duas metades do contrato no código-fonte, porque testar
// o processador de verdade exigiria BullMQ, Prisma e rede.
// ─────────────────────────────────────────────────────────────────────────────

const FONTE = require('fs').readFileSync(
  'src/jobs/processors/camera-health-check.processor.ts', 'utf8',
);

test('o reteste NÃO é mais um for...await sequencial', () => {
  // A assinatura do defeito antigo: laço direto com await do getStatus dentro.
  const trecho = FONTE.slice(FONTE.indexOf('sem heartbeat recente'), FONTE.indexOf('Todas as câmeras online'));
  assert.ok(
    !/for\s*\(const\s+cam\s+of\s+staleCameras\)/.test(trecho),
    'o laço sequencial voltou — a fila de reteste vai estourar o ciclo de novo',
  );
});

test('o reteste roda em lotes com teto configurável', () => {
  assert.ok(FONTE.includes("envNumber('HEALTH_RETEST_CONCURRENCY'"), 'o teto precisa ser ajustável por ambiente');
  assert.ok(/i \+= CONCURRENCY/.test(FONTE), 'os retestes precisam avançar em lotes do tamanho do teto');
});

test('o teto padrão é 4 — o mesmo de recoverStuckPaths', () => {
  const m = FONTE.match(/envNumber\('HEALTH_RETEST_CONCURRENCY',\s*(\d+)/);
  assert.ok(m, 'não encontrei o padrão do teto');
  assert.equal(Number(m[1]), 4, 'divergir do valor já usado no projeto pede justificativa explícita');
});

test('uma câmera que estoura não aborta o lote', () => {
  // Com `Promise.all`, uma rejeição inesperada cancelaria as irmãs do lote e elas
  // seriam marcadas offline no ciclo seguinte sem nunca terem sido testadas.
  assert.ok(
    FONTE.includes('Promise.allSettled'),
    'o lote precisa ser allSettled: uma falha isolada não pode derrubar as demais',
  );
});

test('o teto tem limite superior — paralelismo livre derruba o DVR', () => {
  const m = FONTE.match(/envNumber\('HEALTH_RETEST_CONCURRENCY',[^)]*max:\s*(\d+)/s);
  assert.ok(m, 'o teto precisa de um máximo');
  assert.ok(Number(m[1]) <= 16, 'teto alto demais reintroduz a tempestade de sondas contra o equipamento do cliente');
});
