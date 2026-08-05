import test from 'node:test';
import assert from 'node:assert/strict';
import {
  planejarVarredura,
  emLotes,
  contagemZerada,
  somarGravacao,
  avaliarAtencao,
  type EntradaDeCache,
} from '../src/recordings/helpers/health-summary-scan.helper';

// ── O RESUMO DE SAÚDE NÃO PODE VIRAR TEMPESTADE DE ffprobe ──────────────────
//
// O endpoint que congelou a API por 11s foi corrigido (o cache de 1,6 MB
// deixou de ser relido 1.200 vezes), mas o MESMO laço continuava com três
// bombas armadas, que estes testes desarmam:
//
//  1. cache frio → uma consulta ao banco e um ffprobe POR GRAVAÇÃO, em série;
//  2. o corte em 1.200 era mudo — num dia de 8.500 gravações o resumo cobria
//     14% e se apresentava como o dia inteiro;
//  3. o que não fosse medido entrava como DEFEITO (fileExists undefined),
//     inventando alarme.

const TTL = 900_000;
const AGORA = 1_000_000_000;

function cacheCom(entradas: Record<string, { idadeMs: number; diagnostics?: unknown }>): Record<string, EntradaDeCache> {
  const cache: Record<string, EntradaDeCache> = {};
  for (const [id, { idadeMs, diagnostics }] of Object.entries(entradas)) {
    cache[id] = {
      checkedAt: new Date(AGORA - idadeMs).toISOString(),
      diagnostics: diagnostics ?? { recordingId: id, fileExists: true },
    };
  }
  return cache;
}

const reg = (id: string) => ({ id });

test('quem tem diagnóstico fresco no cache não custa NADA', () => {
  const plano = planejarVarredura(
    [reg('a'), reg('b')],
    cacheCom({ a: { idadeMs: 1000 }, b: { idadeMs: 1000 } }),
    (r) => r.id,
    TTL,
    AGORA,
    24,
  );
  assert.equal(plano.cacheados.length, 2);
  assert.deepEqual(plano.aMedir, [], 'medir o que o cache já responde é o gasto que não pode existir');
  assert.deepEqual(plano.adiados, []);
});

test('diagnóstico VENCIDO volta para a fila de medição', () => {
  const plano = planejarVarredura(
    [reg('a')],
    cacheCom({ a: { idadeMs: TTL + 1 } }),
    (r) => r.id,
    TTL,
    AGORA,
    24,
  );
  assert.equal(plano.cacheados.length, 0);
  assert.deepEqual(plano.aMedir.map((r) => r.id), ['a']);
});

test('entrada sem diagnóstico não conta como cacheada', () => {
  // `checkedAt` presente e `diagnostics` ausente acontece de verdade: o mesmo
  // registro guarda `integrity` (gravado pela varredura de integridade).
  const cache: Record<string, EntradaDeCache> = { a: { checkedAt: new Date(AGORA).toISOString() } };
  const plano = planejarVarredura([reg('a')], cache, (r) => r.id, TTL, AGORA, 24);
  assert.deepEqual(plano.aMedir.map((r) => r.id), ['a']);
});

test('ORÇAMENTO: cache frio de 1.200 gravações não dispara 1.200 medições', () => {
  // O defeito: uma requisição podia disparar até 1.200 consultas ao banco e
  // 1.200 subprocessos ffprobe EM SÉRIE — minutos de CPU, a cada troca de aba.
  const registros = Array.from({ length: 1200 }, (_, i) => reg(`r${i}`));
  const plano = planejarVarredura(registros, {}, (r) => r.id, TTL, AGORA, 24);
  assert.equal(plano.aMedir.length, 24, 'o teto de medições caras é o que impede a tempestade');
  assert.equal(plano.adiados.length, 1176);
  assert.equal(plano.cacheados.length, 0);
  // Nada se perde: o que sobra é reportado como pendente e medido aos poucos.
  assert.equal(plano.aMedir.length + plano.adiados.length, registros.length);
});

test('orçamento zero mede nada — e não quebra', () => {
  const plano = planejarVarredura([reg('a'), reg('b')], {}, (r) => r.id, TTL, AGORA, 0);
  assert.deepEqual(plano.aMedir, []);
  assert.equal(plano.adiados.length, 2);
});

test('a fila de medição respeita a ordem recebida (mais antigo primeiro)', () => {
  const registros = [reg('a'), reg('b'), reg('c')];
  const plano = planejarVarredura(registros, {}, (r) => r.id, TTL, AGORA, 2);
  assert.deepEqual(plano.aMedir.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(plano.adiados.map((r) => r.id), ['c']);
});

// ── emLotes: nem em série, nem tudo de uma vez ──────────────────────────────

test('nunca passam mais que o limite de medições ao mesmo tempo', async () => {
  let emVoo = 0;
  let pico = 0;
  const itens = Array.from({ length: 20 }, (_, i) => i);
  const saida = await emLotes(itens, 4, async (item) => {
    emVoo += 1;
    pico = Math.max(pico, emVoo);
    await new Promise((r) => setTimeout(r, 1));
    emVoo -= 1;
    return item * 2;
  });
  // Em série somaria segundos de espera; todas juntas roubariam a CPU da
  // GRAVAÇÃO, que é o que não pode furar.
  assert.equal(pico, 4, `pico de ${pico} medições simultâneas — o limite existe para poupar CPU da gravação`);
  assert.deepEqual(saida, itens.map((i) => i * 2), 'a ordem do resultado tem de acompanhar a da entrada');
});

test('emLotes com lista vazia não trava', async () => {
  assert.deepEqual(await emLotes([], 4, async () => 1), []);
});

test('emLotes com menos itens que o limite roda todos', async () => {
  assert.deepEqual(await emLotes([1, 2], 8, async (i) => i + 1), [2, 3]);
});

// ── Contagem: indeterminado NÃO é defeito ───────────────────────────────────

const bom = { fileExists: true, fileSizeBytes: 5_000_000, compatibleRecommended: false, hasAudioStream: true };
const sumido = { fileExists: false, reason: 'file_missing' };
const vazio = { fileExists: true, fileSizeBytes: 0, reason: 'empty_file' };

test('gravação sem diagnóstico entra como PENDENTE, nunca como quebrada', () => {
  // Era o pior efeito colateral possível: o que faltasse medir chegava com
  // `fileExists: undefined` e virava "quebrada" — alarme inventado sobre uma
  // câmera que podia estar perfeita.
  const c = contagemZerada('cam-1');
  somarGravacao(c, null, 128 * 1024);
  assert.equal(c.pending, 1);
  assert.equal(c.broken, 0, 'contar o não medido como defeito inventa alarme');
  assert.equal(c.total, 1);
});

test('arquivo ausente e arquivo vazio continuam contando como quebrados', () => {
  const c = contagemZerada('cam-1');
  somarGravacao(c, sumido, 128 * 1024);
  somarGravacao(c, vazio, 128 * 1024);
  assert.equal(c.broken, 2, 'defeito de verdade não pode ser suavizado pela mudança');
});

test('arquivo menor que o mínimo é contado como pequeno demais', () => {
  const c = contagemZerada('cam-1');
  somarGravacao(c, { fileExists: true, fileSizeBytes: 1024, compatibleRecommended: false }, 128 * 1024);
  assert.equal(c.tooSmall, 1);
  assert.equal(c.directLikely, 1);
});

test('áudio e recomendação de transcode são somados', () => {
  const c = contagemZerada('cam-1');
  somarGravacao(c, bom, 128 * 1024);
  somarGravacao(c, { ...bom, compatibleRecommended: true }, 128 * 1024);
  assert.equal(c.withAudio, 2);
  assert.equal(c.compatibleRecommended, 1);
  assert.equal(c.directLikely, 1);
});

// ── Atenção: a proporção usa o que foi MEDIDO ───────────────────────────────

test('a taxa de degradação ignora o que não foi medido', () => {
  // 4 medidas, 2 ruins = 50%: precisa alarmar. Se o cálculo dividisse pelo
  // total (4 + 96 pendentes), a taxa cairia para 2% e a câmera quebrada
  // passaria despercebida justamente no dia em que o cache estava frio.
  const c = contagemZerada('cam-1');
  for (let i = 0; i < 2; i += 1) somarGravacao(c, sumido, 128 * 1024);
  for (let i = 0; i < 2; i += 1) somarGravacao(c, bom, 128 * 1024);
  for (let i = 0; i < 96; i += 1) somarGravacao(c, null, 128 * 1024);
  const veredito = avaliarAtencao(c, 3, 128 * 1024);
  assert.equal(veredito.needsAttention, true);
  assert.equal(veredito.alertReason, 'alta taxa de segmentos degradados');
});

test('câmera 100% pendente NÃO vira alarme — não saber não é defeito', () => {
  const c = contagemZerada('cam-1');
  for (let i = 0; i < 50; i += 1) somarGravacao(c, null, 128 * 1024);
  c.lastRecordingAgeSeconds = 60;
  assert.equal(avaliarAtencao(c, 3, 128 * 1024).needsAttention, false);
});

test('o limiar de falhas continua alarmando com o motivo escrito', () => {
  const c = contagemZerada('cam-1');
  for (let i = 0; i < 3; i += 1) somarGravacao(c, sumido, 128 * 1024);
  const veredito = avaliarAtencao(c, 3, 128 * 1024);
  assert.equal(veredito.needsAttention, true);
  assert.equal(veredito.alertReason, 'falhas=3 (limiar=3)');
});

test('segmento atrasado alarma mesmo com tudo pendente', () => {
  // Este sinal não depende de medir arquivo: veio do banco. Cache frio não
  // pode calar o alarme de "a câmera parou de gravar".
  const c = contagemZerada('cam-1');
  somarGravacao(c, null, 128 * 1024);
  c.lastRecordingAgeSeconds = 45 * 60;
  const veredito = avaliarAtencao(c, 3, 128 * 1024);
  assert.equal(veredito.needsAttention, true);
  assert.match(veredito.alertReason ?? '', /atrasado/);
});

test('câmera saudável não alarma', () => {
  const c = contagemZerada('cam-1');
  for (let i = 0; i < 10; i += 1) somarGravacao(c, bom, 128 * 1024);
  c.lastRecordingAgeSeconds = 30;
  const veredito = avaliarAtencao(c, 3, 128 * 1024);
  assert.equal(veredito.needsAttention, false);
  assert.equal(veredito.alertReason, null);
});
