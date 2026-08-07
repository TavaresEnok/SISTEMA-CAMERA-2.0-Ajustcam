import test from 'node:test';
import assert from 'node:assert/strict';
import { planejarRotacao, type CandidataARotacao } from '../src/recordings/helpers/rotacao-por-camera.helper';

// Medido em produção: o guardião rodava de HORA em hora e apagava a mais antiga
// do sistema inteiro, enquanto a guarda PARAVA a gravação a 92%. Resultado: 100
// paradas em 2 horas, com zero câmeras gravando. A regra correta é o anel por
// câmera — a gravação nova sobrescreve a mais antiga DELA MESMA.

const MB = 1024 * 1024;
function rec(id: string, cameraId: string, minuto: number, mb = 10): CandidataARotacao {
  return { id, cameraId, startedAt: new Date(2026, 0, 1, 0, minuto), sizeBytes: mb * MB };
}

test('apaga a MAIS ANTIGA de cada câmera, nunca a de outra', () => {
  const plano = planejarRotacao(
    [rec('a1', 'A', 0), rec('a2', 'A', 30), rec('b1', 'B', 5), rec('b2', 'B', 35)],
    15 * MB,
    ['A', 'B'],
  );
  const ids = plano.aApagar.map((r) => r.id);
  assert.ok(ids.includes('a1'), 'a mais antiga de A');
  assert.ok(ids.includes('b1'), 'a mais antiga de B');
  assert.ok(!ids.includes('a2') && !ids.includes('b2'), 'as recentes ficam');
});

test('distribui a perda POR RODADA — uma câmera não paga a conta sozinha', () => {
  // A tem muito histórico, B tem pouco: sem alternância, A perderia tudo antes
  // de B perder o primeiro (foi assim que a câmera movimentada comia o
  // histórico da vizinha).
  const candidatas = [
    ...Array.from({ length: 10 }, (_, i) => rec(`a${i}`, 'A', i)),
    ...Array.from({ length: 10 }, (_, i) => rec(`b${i}`, 'B', i)),
  ];
  const plano = planejarRotacao(candidatas, 40 * MB, ['A', 'B']);
  const deA = plano.aApagar.filter((r) => r.cameraId === 'A').length;
  const deB = plano.aApagar.filter((r) => r.cameraId === 'B').length;
  assert.ok(Math.abs(deA - deB) <= 1, `perda equilibrada: A=${deA} B=${deB}`);
});

test('câmera GRAVANDO agora é servida primeiro — é o disco dela que acaba', () => {
  const plano = planejarRotacao([rec('parada', 'P', 0), rec('ativa', 'V', 1)], 5 * MB, ['V']);
  assert.equal(plano.aApagar[0].cameraId, 'V');
});

test('gravação protegida (investigação/legal hold) NUNCA entra na rotação', () => {
  const plano = planejarRotacao(
    [{ ...rec('protegida', 'A', 0), protegida: true }, rec('comum', 'A', 10)],
    5 * MB,
    ['A'],
  );
  assert.deepEqual(plano.aApagar.map((r) => r.id), ['comum']);
});

test('para assim que junta o necessário — não apaga além da conta', () => {
  const plano = planejarRotacao(
    Array.from({ length: 20 }, (_, i) => rec(`a${i}`, 'A', i, 10)),
    25 * MB,
    ['A'],
  );
  assert.equal(plano.aApagar.length, 3, '3 × 10MB cobre 25MB');
  assert.ok(plano.bytesEstimados >= 25 * MB);
});

test('câmera ativa SEM histórico próprio é reportada (é o único caso de suspender)', () => {
  const plano = planejarRotacao([rec('a1', 'A', 0)], 5 * MB, ['A', 'NOVA']);
  assert.deepEqual(plano.camerasSemFolga, ['NOVA']);
});

test('nada a fazer quando não falta espaço', () => {
  const plano = planejarRotacao([rec('a1', 'A', 0)], 0, ['A']);
  assert.deepEqual(plano.aApagar, []);
});

test('tamanho ausente ou inválido não trava o laço', () => {
  // Sem isto, gravação com sizeBytes null somaria 0 para sempre e o while
  // rodaria até esvaziar todas as filas.
  const plano = planejarRotacao(
    [{ id: 'x', cameraId: 'A', startedAt: new Date(), sizeBytes: null },
     { id: 'y', cameraId: 'A', startedAt: new Date(), sizeBytes: '0' }],
    5 * MB, ['A'],
  );
  assert.equal(plano.aApagar.length, 2, 'esvazia a fila e para, sem laço infinito');
});
