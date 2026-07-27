import assert from 'node:assert/strict';
import test from 'node:test';
import {
  STALE_SEGMENT_SECONDS,
  buildCameraHealthRows,
  classifyCameraHealth,
  compareCameraHealthRows,
  formatSinceLastSegment,
  parseCameraHealthPayload,
  parseStaleThreshold,
  summarizeCameraHealth,
  type CameraHealthEntry,
} from '../src/lib/camera-health.ts';

// Tabela de saúde POR CÂMERA da tela de Desempenho. O que está sob teste é a
// decisão "isso é problema?" — se ela errar, o cliente acha que está gravando e
// não está. Os casos abaixo espelham o contrato de GET /observability/cameras.

function entry(over: Partial<CameraHealthEntry> & { cameraId: string }): CameraHealthEntry {
  const rec = over.recording ?? {};
  return {
    name: over.cameraId,
    enabled: true,
    status: 'ONLINE',
    ...over,
    cameraId: over.cameraId,
    recording: {
      desired: 'continuous',
      active: true,
      lastSegmentAt: '2026-07-27T12:00:00.000Z',
      secondsSinceLastSegment: 12,
      segmentsLastHour: 60,
      restartsLastHour: 0,
      stalled: false,
      ...rec,
    },
    stream: { recoveriesLastHour: 0, lastRecoveryAt: null, ...(over.stream ?? {}) },
  };
}

test('classificação: crítico quando estagnada ou quando deveria gravar e não grava', () => {
  // stalled é veredito do backend: crítico mesmo com tudo o mais saudável.
  assert.equal(classifyCameraHealth(entry({ cameraId: 'a', recording: { stalled: true } as any })), 'critico');
  // gravação contínua desejada, pipeline morto → o caso que dói.
  assert.equal(
    classifyCameraHealth(entry({ cameraId: 'b', recording: { desired: 'continuous', active: false } as any })),
    'critico',
  );
  // motion também mantém pipeline de pé.
  assert.equal(
    classifyCameraHealth(entry({ cameraId: 'c', recording: { desired: 'motion', active: false } as any })),
    'critico',
  );
});

test('classificação: atenção para offline e para contínua sem segmento recente', () => {
  assert.equal(classifyCameraHealth(entry({ cameraId: 'd', status: 'OFFLINE' })), 'atencao');
  assert.equal(
    classifyCameraHealth(
      entry({ cameraId: 'e', recording: { secondsSinceLastSegment: STALE_SEGMENT_SECONDS + 1 } as any }),
    ),
    'atencao',
  );
  // nunca fechou segmento (null) numa contínua ativa também é atenção.
  assert.equal(
    classifyCameraHealth(entry({ cameraId: 'f', recording: { secondsSinceLastSegment: null } as any })),
    'atencao',
  );
  // exatamente no limite ainda é ok (o corte é ESTRITAMENTE maior).
  assert.equal(
    classifyCameraHealth(
      entry({ cameraId: 'g', recording: { secondsSinceLastSegment: STALE_SEGMENT_SECONDS } as any }),
    ),
    'ok',
  );
});

test('classificação: ok para saudável, para manual parada e para câmera desativada', () => {
  assert.equal(classifyCameraHealth(entry({ cameraId: 'h' })), 'ok');
  // manual só grava sob comando: inativa NÃO é falha.
  assert.equal(
    classifyCameraHealth(
      entry({ cameraId: 'i', recording: { desired: 'manual', active: false, secondsSinceLastSegment: 99999 } as any }),
    ),
    'ok',
  );
  // motion sem movimento há horas NÃO é atenção (senão vira falso positivo em série).
  assert.equal(
    classifyCameraHealth(
      entry({ cameraId: 'j', recording: { desired: 'motion', active: true, secondsSinceLastSegment: 7200 } as any }),
    ),
    'ok',
  );
  // desativada de propósito não pode ocupar o topo da tabela.
  assert.equal(
    classifyCameraHealth(
      entry({ cameraId: 'k', enabled: false, status: 'OFFLINE', recording: { active: false, stalled: true } as any }),
    ),
    'ok',
  );
});

test('formatSinceLastSegment cobre segundos, minutos, horas, dias e ausência', () => {
  assert.equal(formatSinceLastSegment(0), '0s');
  assert.equal(formatSinceLastSegment(42), '42s');
  assert.equal(formatSinceLastSegment(59.9), '59s');
  assert.equal(formatSinceLastSegment(60), '1min');
  assert.equal(formatSinceLastSegment(330), '5min');
  assert.equal(formatSinceLastSegment(3600), '1h');
  assert.equal(formatSinceLastSegment(7200), '2h');
  assert.equal(formatSinceLastSegment(86400 * 3), '3d');
  assert.equal(formatSinceLastSegment(null), '—');
  assert.equal(formatSinceLastSegment(undefined), '—');
  assert.equal(formatSinceLastSegment(Number.NaN), '—');
  assert.equal(formatSinceLastSegment(-5), '—');
});

test('ordenação: problemas primeiro e alfabético dentro do grupo', () => {
  const rows = buildCameraHealthRows([
    entry({ cameraId: '4', name: 'Zebra ok' }),
    entry({ cameraId: '3', name: 'Alfa ok' }),
    entry({ cameraId: '2', name: 'Zulu crítica', recording: { stalled: true } as any }),
    entry({ cameraId: '1', name: 'Ávila crítica', recording: { active: false } as any }),
    entry({ cameraId: '5', name: 'Meio atenção', status: 'OFFLINE' }),
  ]);

  assert.deepEqual(
    rows.map((r) => r.displayName),
    ['Ávila crítica', 'Zulu crítica', 'Meio atenção', 'Alfa ok', 'Zebra ok'],
  );
  assert.deepEqual(rows.map((r) => r.state), ['critico', 'critico', 'atencao', 'ok', 'ok']);
  // crítico SEMPRE antes de ok, na comparação direta.
  assert.ok(compareCameraHealthRows(rows[0], rows[4]) < 0);
  assert.ok(compareCameraHealthRows(rows[4], rows[0]) > 0);
});

test('linhas: rótulo de tempo e nome caindo para o id quando name vem nulo/vazio', () => {
  const rows = buildCameraHealthRows([
    entry({ cameraId: 'cam-uuid', name: null, recording: { secondsSinceLastSegment: 330 } as any }),
    entry({ cameraId: 'cam-vazio', name: '   ' }),
  ]);
  const byId = new Map(rows.map((r) => [r.cameraId, r]));
  assert.equal(byId.get('cam-uuid')!.displayName, 'cam-uuid');
  assert.equal(byId.get('cam-uuid')!.sinceLabel, '5min');
  assert.equal(byId.get('cam-vazio')!.displayName, 'cam-vazio');
});

test('resumo conta por estado, gravando e offline', () => {
  const rows = buildCameraHealthRows([
    entry({ cameraId: 'a', name: 'A' }),
    entry({ cameraId: 'b', name: 'B', recording: { stalled: true, active: true } as any }),
    entry({ cameraId: 'c', name: 'C', status: 'OFFLINE', recording: { active: false, desired: 'manual' } as any }),
    entry({ cameraId: 'd', name: 'D', recording: { desired: 'motion', active: false } as any }),
  ]);
  assert.deepEqual(summarizeCameraHealth(rows), {
    total: 4,
    critico: 2,
    atencao: 1,
    ok: 1,
    recordingActive: 2,
    offline: 1,
  });
});

test('parse: contrato válido vira entradas; corpo fora do contrato vira null (seção some)', () => {
  const parsed = parseCameraHealthPayload({
    generatedAt: '2026-07-27T12:00:00.000Z',
    cameras: [
      {
        cameraId: 'cam-1',
        name: 'Portaria',
        enabled: true,
        status: 'ONLINE',
        recording: {
          desired: 'continuous',
          active: true,
          lastSegmentAt: '2026-07-27T11:59:30.000Z',
          secondsSinceLastSegment: 30,
          segmentsLastHour: 60,
          restartsLastHour: 2,
          stalled: false,
        },
        stream: { recoveriesLastHour: 1, lastRecoveryAt: '2026-07-27T11:00:00.000Z' },
      },
    ],
    totals: { cameras: 1, recordingActive: 1, stalled: 0, offline: 0 },
  });
  assert.equal(parsed?.length, 1);
  assert.equal(parsed![0].recording.restartsLastHour, 2);
  assert.equal(parsed![0].stream.recoveriesLastHour, 1);

  // 404 / HTML de erro / payload sem o array → null, e a página segue igual a hoje.
  assert.equal(parseCameraHealthPayload(null), null);
  assert.equal(parseCameraHealthPayload('<!doctype html>'), null);
  assert.equal(parseCameraHealthPayload({ message: 'Not Found', statusCode: 404 }), null);
  // Array vazio é contrato VÁLIDO (só não rende linha).
  assert.deepEqual(parseCameraHealthPayload({ cameras: [] }), []);
});

test('parse: campos faltando caem em default conservador em vez de quebrar a tela', () => {
  const parsed = parseCameraHealthPayload({ cameras: [{ cameraId: 'cam-2' }, { name: 'sem id' }, 7] });
  assert.equal(parsed?.length, 1);
  const row = parsed![0];
  assert.equal(row.status, 'UNKNOWN');
  assert.equal(row.recording.desired, 'off');
  assert.equal(row.recording.active, false);
  assert.equal(row.recording.secondsSinceLastSegment, null);
  assert.equal(row.stream.recoveriesLastHour, 0);
  // off + inativa + UNKNOWN não é problema: nada configurado para gravar.
  assert.equal(classifyCameraHealth(row), 'ok');
});

// O limiar de estagnação depende de RECORDING_SEGMENT_SECONDS, que varia por
// instalação (produção usa 300s). Cravar constante no cliente marcava TODA câmera
// contínua como suspeita — o servidor passou a informar o valor real.
test('limiar vem do SERVIDOR: 200s sem segmento é ok com segmento de 300s', () => {
  const e = entry({ cameraId: 'x', recording: { desired: 'continuous', active: true, secondsSinceLastSegment: 200 } as any });
  // Com o limiar real do servidor (375s p/ segmento de 300s) → saudável.
  assert.equal(classifyCameraHealth(e, 375), 'ok');
  // Com um limiar apertado (120s, a suposição errada de 60s) → falso positivo.
  assert.equal(classifyCameraHealth(e, 120), 'atencao');
});

test('parseStaleThreshold: usa o do payload e cai no default quando ausente/inválido', () => {
  assert.equal(parseStaleThreshold({ staleThresholdSeconds: 375 }), 375);
  assert.equal(parseStaleThreshold({}), STALE_SEGMENT_SECONDS);
  assert.equal(parseStaleThreshold({ staleThresholdSeconds: 0 }), STALE_SEGMENT_SECONDS);
  assert.equal(parseStaleThreshold({ staleThresholdSeconds: 'abc' }), STALE_SEGMENT_SECONDS);
  assert.equal(parseStaleThreshold(null), STALE_SEGMENT_SECONDS);
});

test('buildCameraHealthRows propaga o limiar do servidor', () => {
  const entries = [entry({ cameraId: 'y', recording: { desired: 'continuous', active: true, secondsSinceLastSegment: 200 } as any })];
  assert.equal(buildCameraHealthRows(entries, 375)[0].state, 'ok');
  assert.equal(buildCameraHealthRows(entries, 120)[0].state, 'atencao');
});
