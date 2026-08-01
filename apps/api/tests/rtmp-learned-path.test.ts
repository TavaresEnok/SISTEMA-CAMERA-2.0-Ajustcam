import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isAcceptableIngestPath, normalizeIngestPath } from '../src/cameras/helpers/rtmp-ingest.helper';
import { PendingIngestRegistry } from '../src/cameras/pending-ingest.registry';

// ─────────────────────────────────────────────────────────────────────────────
// EQUIPAMENTO QUE NÃO DEIXA ESCOLHER O CAMINHO
//
// Medido em campo (2026-08-01, Positivo CIP-B1312-M): a câmera pega só o
// ENDEREÇO da URL e monta o caminho do número de série —
// `live/liveStream_H3ZL2802830WB_0_0C` — ignorando o que se digita depois do
// host. O diálogo RTMP vai até o `publish` e só então é recusado.
//
// Exigir o nosso formato deixaria essa classe de equipamento de fora, então o
// sistema aprende. Mas aprender não é aceitar: a porta 1935 é pública, e sem a
// confirmação de um administrador qualquer um injetaria vídeo num sistema com
// valor probatório. Estes testes fixam essa fronteira.
// ─────────────────────────────────────────────────────────────────────────────

const CAMINHO_REAL = 'live/liveStream_H3ZL2802830WB_0_0C';

test('o caminho real medido em campo é aceitável', () => {
  assert.equal(isAcceptableIngestPath(CAMINHO_REAL), true);
});

test('formatos comuns de outros fabricantes passam', () => {
  for (const p of ['live/stream1', 'cam1', 'hls/ch01_main', 'a/b/c', 'stream-01.main']) {
    assert.equal(isAcceptableIngestPath(p), true, `${p} deveria ser aceito`);
  }
});

test('NENHUM caminho aprendido pode invadir o espaço de entrega', () => {
  // A garantia central: paths cam_* são onde a live entrega. Um publicador
  // jamais pode reivindicá-los, por mais que o "aprendizado" seja permissivo.
  for (const p of [
    'cam_5b55e86c16cd4976bc23a08e699aa5f3',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_grid',
    'CAM_5b55e86c16cd4976bc23a08e699aa5f3',
    'cam_qualquercoisa',
  ]) {
    assert.equal(isAcceptableIngestPath(p), false, `${p} jamais pode ser aprendido`);
  }
});

test('travessia e forma inválida são recusadas', () => {
  for (const p of [
    '../etc/passwd', 'live/../cam_x', '/live/stream', 'live/stream/',
    'live//stream', 'live/stream?x=1', 'live stream', '', '   ',
    'a'.repeat(200), null, undefined, 42, {},
  ]) {
    assert.equal(isAcceptableIngestPath(p as unknown), false, `${JSON.stringify(p)} não deveria passar`);
  }
});

test('espaço em volta não muda a identidade do caminho', () => {
  assert.equal(normalizeIngestPath(`  ${CAMINHO_REAL}  `), CAMINHO_REAL);
});

// ── O registro de tentativas ────────────────────────────────────────────────

test('tentativa recusada vira linha na lista, com contagem', () => {
  const reg = new PendingIngestRegistry();
  reg.record(CAMINHO_REAL, '179.124.141.169');
  reg.record(CAMINHO_REAL, '179.124.141.169');
  reg.record(CAMINHO_REAL, '179.124.141.169');
  const [item] = reg.list();
  assert.equal(item.path, CAMINHO_REAL);
  assert.equal(item.attempts, 3, 'a câmera re-tenta a cada 60s; a contagem prova que é insistente');
  assert.equal(item.remoteAddr, '179.124.141.169');
});

test('lixo não entra na lista', () => {
  const reg = new PendingIngestRegistry();
  reg.record('../etc/passwd', '1.2.3.4');
  reg.record('cam_5b55e86c16cd4976bc23a08e699aa5f3', '1.2.3.4');
  reg.record('', '1.2.3.4');
  assert.deepEqual(reg.list(), []);
});

test('vincular remove da lista de pendentes', () => {
  const reg = new PendingIngestRegistry();
  reg.record(CAMINHO_REAL, '1.2.3.4');
  assert.equal(reg.list().length, 1);
  reg.clear(CAMINHO_REAL);
  assert.deepEqual(reg.list(), []);
});

test('varredura de porta não expulsa a câmera de verdade', () => {
  // Quem insiste sobrevive ao teto; quem bateu uma vez, não. Sem isso, uma
  // varredura empurraria o equipamento real para fora da lista justamente
  // quando o operador fosse procurá-lo.
  process.env.RTMP_PENDING_MAX = '5';
  const reg = new PendingIngestRegistry();
  for (let i = 0; i < 4; i += 1) reg.record(`scan/tentativa${i}`, '9.9.9.9');
  reg.record(CAMINHO_REAL, '179.124.141.169');
  for (let i = 0; i < 30; i += 1) reg.record(CAMINHO_REAL, '179.124.141.169');
  for (let i = 100; i < 120; i += 1) reg.record(`scan/tentativa${i}`, '9.9.9.9');
  assert.ok(
    reg.list().some((p) => p.path === CAMINHO_REAL),
    'o equipamento insistente tem de sobreviver à varredura',
  );
  delete process.env.RTMP_PENDING_MAX;
});

// ── A LISTA PRECISA SER A MESMA DOS DOIS LADOS ──────────────────────────────
//
// Defeito real, encontrado em campo: o registro foi declarado como provider em
// DOIS módulos (cameras e camera-stream). O Nest cria uma instância por módulo,
// então o handler de autenticação gravava as tentativas numa e a tela lia da
// outra — sempre vazia. Tudo "funcionava"; a lista nunca aparecia.
//
// Nenhum teste unitário pegaria isso, porque cada teste instancia o seu. O que
// pega é conferir a DECLARAÇÃO: o provider tem de existir em um módulo só.

test('o registro de tentativas é declarado em UM módulo só', () => {
  const fs = require('fs');
  const modulos = [
    'src/cameras/cameras.module.ts',
    'src/camera-stream/camera-stream.module.ts',
  ];
  const declaram = modulos.filter((m) => {
    const texto = fs.readFileSync(m, 'utf8');
    // Conta só a declaração em `providers:`, não o import nem o export.
    const bloco = texto.match(/providers:\s*\[[^\]]*\]/s)?.[0] ?? '';
    return bloco.includes('PendingIngestRegistry');
  });
  assert.deepEqual(
    declaram,
    ['src/cameras/cameras.module.ts'],
    'duas declarações = duas instâncias = a tela lê uma lista que ninguém preenche',
  );
});
