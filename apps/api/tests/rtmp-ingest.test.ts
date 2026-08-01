import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPublishTarget,
  generateIngestKey,
  hashIngestKey,
  ingestHashMatches,
  ingestKeyFromPathName,
  ingestPathName,
  isPushSourced,
  isValidIngestKey,
  RTMP_INGEST_APP,
  SOURCE_MODE_PUSH,
} from '../src/cameras/helpers/rtmp-ingest.helper';

// ─────────────────────────────────────────────────────────────────────────────
// A CHAVE DE INGESTÃO É UM CREDENCIAL, NÃO UM IDENTIFICADOR
//
// Na maioria das câmeras a interface de RTMP tem dois campos — servidor e chave
// — e nenhum campo de senha. Então a chave PRECISA autenticar sozinha, e o que
// a protege é: entropia suficiente, comparação em tempo constante, e um padrão
// de path estrito que impeça um publicador de tentar assumir um path de câmera.
//
// Estes testes existem para que uma "simplificação" futura não afrouxe nenhuma
// das três coisas sem que alguém perceba.
// ─────────────────────────────────────────────────────────────────────────────

test('a chave gerada tem o formato esperado e não se repete', () => {
  const chaves = new Set<string>();
  for (let i = 0; i < 200; i += 1) {
    const chave = generateIngestKey();
    assert.match(chave, /^[0-9a-f]{32}$/, 'chave fora do formato de 32 hexadecimais');
    assert.ok(isValidIngestKey(chave));
    chaves.add(chave);
  }
  assert.equal(chaves.size, 200, 'houve colisão em 200 chaves — a fonte de aleatoriedade está errada');
});

test('chave malformada é recusada antes de qualquer consulta', () => {
  const invalidas = [
    '',
    'abc',
    'A'.repeat(32),                      // maiúscula: normalizamos para minúscula
    '0123456789abcdef0123456789abcdeg',  // 'g' não é hexadecimal
    '0123456789abcdef0123456789abcde',   // curta
    '0123456789abcdef0123456789abcdef0', // longa
    null,
    undefined,
    123,
    {},
  ];
  for (const v of invalidas) {
    assert.equal(isValidIngestKey(v as unknown), false, `${JSON.stringify(v)} não deveria passar`);
  }
});

test('o hash é estável e diferente para chaves diferentes', () => {
  const a = generateIngestKey();
  const b = generateIngestKey();
  assert.equal(hashIngestKey(a), hashIngestKey(a), 'o mesmo insumo deve dar o mesmo hash');
  assert.notEqual(hashIngestKey(a), hashIngestKey(b));
  assert.match(hashIngestKey(a), /^[0-9a-f]{64}$/);
});

test('a chave em claro nunca é igual ao que guardamos', () => {
  // Se algum dia alguém trocar o hash por armazenamento direto, este teste cai.
  const chave = generateIngestKey();
  assert.notEqual(hashIngestKey(chave), chave);
});

test('a comparação de hash aceita o correto e recusa o resto', () => {
  const chave = generateIngestKey();
  const hash = hashIngestKey(chave);
  assert.equal(ingestHashMatches(hash, hashIngestKey(chave)), true);
  assert.equal(ingestHashMatches(hash, hashIngestKey(generateIngestKey())), false);
  assert.equal(ingestHashMatches(hash, null), false);
  assert.equal(ingestHashMatches(null, hash), false);
  assert.equal(ingestHashMatches(hash, ''), false);
  assert.equal(ingestHashMatches(hash, hash.slice(0, 32)), false, 'prefixo correto não pode passar');
});

// ── O PADRÃO DO PATH É A FRONTEIRA DE SEGURANÇA ─────────────────────────────

test('o path de ingestão devolve a chave', () => {
  const chave = generateIngestKey();
  assert.equal(ingestKeyFromPathName(ingestPathName(chave)), chave);
  assert.equal(ingestPathName(chave), `${RTMP_INGEST_APP}/${chave}`);
});

test('publicador NÃO consegue mirar um path de câmera', () => {
  // Esta é a garantia central: nenhum nome de path de câmera casa com o padrão
  // de ingestão, então validar o path já barra a tentativa de assumir um stream.
  const alvos = [
    'cam_5b55e86c16cd4976bc23a08e699aa5f3',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_grid',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_orig',
    'cam_5b55e86c16cd4976bc23a08e699aa5f3_source',
  ];
  for (const alvo of alvos) {
    assert.equal(ingestKeyFromPathName(alvo), null, `${alvo} jamais pode ser lido como ingestão`);
  }
});

test('travessia, subcaminho e query são recusados', () => {
  const chave = generateIngestKey();
  const ataques = [
    `${RTMP_INGEST_APP}/${chave}/extra`,
    `${RTMP_INGEST_APP}/${chave}?user=admin`,
    `${RTMP_INGEST_APP}/../${chave}`,
    `outro/${chave}`,
    `${RTMP_INGEST_APP}/${chave} `,
    ` ${RTMP_INGEST_APP}/${chave}`,
    `${RTMP_INGEST_APP}/${chave.toUpperCase()}`,
    RTMP_INGEST_APP,
    `${RTMP_INGEST_APP}/`,
    '',
    null,
    undefined,
    42,
  ];
  for (const a of ataques) {
    assert.equal(ingestKeyFromPathName(a as unknown), null, `${JSON.stringify(a)} não deveria ser aceito`);
  }
});

// ── O que o instalador digita na câmera ─────────────────────────────────────

test('a URL de publicação sai pronta nos dois formatos de interface', () => {
  const alvo = buildPublishTarget({ host: '203.0.113.10', port: 1935, key: 'a'.repeat(32) });
  assert.equal(alvo.serverUrl, 'rtmp://203.0.113.10:1935/drac');
  assert.equal(alvo.streamKey, 'a'.repeat(32));
  assert.equal(alvo.fullUrl, `rtmp://203.0.113.10:1935/drac/${'a'.repeat(32)}`);
  // Câmera com um campo só recebe a concatenação exata que o path espera.
  assert.equal(ingestKeyFromPathName(alvo.fullUrl.split(':1935/')[1]), 'a'.repeat(32));
});

test('RTMPS muda só o esquema', () => {
  const alvo = buildPublishTarget({ host: 'drac.exemplo.com', port: 1936, key: 'b'.repeat(32), scheme: 'rtmps' });
  assert.equal(alvo.serverUrl, 'rtmps://drac.exemplo.com:1936/drac');
});

// ── O modo de origem erra para o lado seguro ────────────────────────────────

test('só o valor exato liga o modo push — o resto segue como hoje', () => {
  assert.equal(isPushSourced({ sourceMode: SOURCE_MODE_PUSH }), true);
  assert.equal(isPushSourced({ sourceMode: '  RTMP_PUSH  ' }), true, 'espaço e maiúscula não deveriam atrapalhar');
  for (const valor of ['rtsp_pull', '', '   ', 'rtmp', 'push', 'lixo', null, undefined]) {
    assert.equal(
      isPushSourced({ sourceMode: valor as string | null }),
      false,
      `"${valor}" deveria manter a câmera no caminho de hoje`,
    );
  }
  assert.equal(isPushSourced(null), false);
  assert.equal(isPushSourced(undefined), false);
  assert.equal(isPushSourced({}), false, 'câmera sem o campo é uma instalação antiga — segue em pull');
});
