import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import {
  DEFAULT_CLOCK_TICKS_PER_SECOND,
  ProcessUsageSampler,
  computeCpuPercent,
  estimateCameraCapacity,
  parseCgroupCpuMax,
  parseCgroupCpuV1,
  parseProcStat,
  parseVmRssBytes,
} from '../src/observability/proc-sampler';

// ─────────────────────────────────────────────────────────────────────────────
// Amostragem de CPU/RSS por PROCESSO lendo /proc.
//
// NADA aqui usa formato inventado. O molde dos testes é uma linha REAL de
// /proc/<pid>/stat de um FFmpeg de GRAVAÇÃO deste host (capturada 2026-07-27) e,
// quando o teste roda em Linux, a linha REAL de /proc/self/stat do próprio
// processo de teste é conferida contra o parser. Um parser de /proc validado
// contra formato imaginado seria um teste que mente: os campos 14/15/22 só
// existem depois do `comm`, que é o pedaço que quebra o split ingênuo.
// ─────────────────────────────────────────────────────────────────────────────

/** REAL: `cat /proc/<pid>/stat` de um ffmpeg de gravação (host de produção). */
const REAL_FFMPEG_STAT =
  '2498938 (ffmpeg) S 488110 2498938 488009 0 -1 4194304 927646 173 39 0 47348 4515 0 0 20 0 27 0 '
  + '433305821 205955072 3138 18446744073709551615 1 1 0 0 0 0 0 4096 8404994 0 0 0 17 9 0 0 0 0 0 0 0 0 0 0 0 0 0';

/** REAL: trecho de /proc/<pid>/status do mesmo processo. */
const REAL_FFMPEG_STATUS = [
  'Name:\tffmpeg',
  'Umask:\t0022',
  'State:\tS (sleeping)',
  'Tgid:\t2498938',
  'Pid:\t2498938',
  'PPid:\t488110',
  'VmPeak:\t  212456 kB',
  'VmSize:\t  201128 kB',
  'VmLck:\t       0 kB',
  'VmPin:\t       0 kB',
  'VmHWM:\t   13120 kB',
  'VmRSS:\t   12012 kB',
  'RssAnon:\t    8600 kB',
  'Threads:\t27',
  '',
].join('\n');

const HAS_PROC = existsSync('/proc/self/stat');
const skipNoProc = HAS_PROC ? false : 'sem /proc (não é Linux) — a amostragem simplesmente não existe aqui';

/**
 * Monta uma linha de stat FIEL: parte da linha REAL e troca só os campos que o
 * teste precisa mexer (utime=14, stime=15, starttime=22). Todo o resto continua
 * sendo o que o kernel escreveu de verdade.
 */
function statLine(opts: { pid?: number; comm?: string; utime?: number; stime?: number; starttime?: number }): string {
  const close = REAL_FFMPEG_STAT.lastIndexOf(')');
  const fields = REAL_FFMPEG_STAT.slice(close + 2).split(' ');
  if (opts.utime != null) fields[11] = String(opts.utime);
  if (opts.stime != null) fields[12] = String(opts.stime);
  if (opts.starttime != null) fields[19] = String(opts.starttime);
  const pid = opts.pid ?? 2498938;
  const comm = opts.comm ?? 'ffmpeg';
  return `${pid} (${comm}) ${fields.join(' ')}\n`;
}

function statusBlock(rssKb: number): string {
  return REAL_FFMPEG_STATUS.replace(/VmRSS:\t\s*\d+ kB/, `VmRSS:\t${String(rssKb).padStart(8)} kB`);
}

/** Leitor falso de /proc: mapa caminho → conteúdo ou erro. */
function fakeProc(files: Map<string, string | NodeJS.ErrnoException>) {
  return (path: string): string => {
    const found = files.get(path);
    if (found === undefined) {
      const err: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${path}'`);
      err.code = 'ENOENT';
      throw err;
    }
    if (typeof found !== 'string') throw found;
    return found;
  };
}

function enoent(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('ENOENT');
  err.code = 'ENOENT';
  return err;
}

function eacces(): NodeJS.ErrnoException {
  const err: NodeJS.ErrnoException = new Error('EACCES');
  err.code = 'EACCES';
  return err;
}

/** /proc mínimo válido para o sampler se considerar disponível. */
function procWith(entries: Array<[string, string | NodeJS.ErrnoException]>) {
  return new Map<string, string | NodeJS.ErrnoException>([
    ['/proc/self/stat', REAL_FFMPEG_STAT],
    ...entries,
  ]);
}

// ── parser de /proc/<pid>/stat ───────────────────────────────────────────────

test('parseProcStat: amostra REAL de ffmpeg — utime/stime/starttime saem dos campos 14/15/22', () => {
  const parsed = parseProcStat(REAL_FFMPEG_STAT);
  assert.ok(parsed, 'a linha real do kernel tem de ser aceita');
  assert.equal(parsed.pid, 2498938);
  assert.equal(parsed.utimeTicks, 47348);
  assert.equal(parsed.stimeTicks, 4515);
  assert.equal(parsed.startTimeTicks, 433305821);
});

test('parseProcStat: /proc/self/stat REAL do processo de teste bate com o process.pid', { skip: skipNoProc }, () => {
  const parsed = parseProcStat(readFileSync('/proc/self/stat', 'utf8'));
  assert.ok(parsed, 'o /proc/self/stat deste kernel tem de ser aceito');
  assert.equal(parsed.pid, process.pid, 'o campo 1 é o PID');
  assert.ok(parsed.utimeTicks >= 0 && Number.isInteger(parsed.utimeTicks));
  assert.ok(parsed.stimeTicks >= 0 && Number.isInteger(parsed.stimeTicks));
  assert.ok(parsed.startTimeTicks > 0, 'starttime desde o boot é sempre positivo');
});

test('parseProcStat: `comm` com ESPAÇO e PARÊNTESES não desloca os campos', () => {
  // Real: o kernel não escapa o comm. Processos com nome composto existem
  // ("(sd-pam)", "Web Content") e o FFmpeg pode ser renomeado por wrapper.
  // Split por espaço a partir do início desloca TODOS os campos — CPU e RSS
  // passariam a ler lixo (número de threads, prioridade…) e a métrica que
  // decide quantas câmeras cabem no host viraria ficção.
  const parsed = parseProcStat(statLine({ comm: 'ff mpeg (rec)', utime: 100, stime: 20, starttime: 555 }));
  assert.ok(parsed);
  assert.equal(parsed.utimeTicks, 100);
  assert.equal(parsed.stimeTicks, 20);
  assert.equal(parsed.startTimeTicks, 555);
});

test('parseProcStat: lixo/truncado devolve null (não lança, não inventa)', () => {
  assert.equal(parseProcStat(''), null);
  assert.equal(parseProcStat('sem parenteses aqui'), null);
  assert.equal(parseProcStat('123 (ffmpeg) S 1 2 3'), null, 'linha curta demais não tem os campos 14/15/22');
  assert.equal(parseProcStat('123 (ffmpeg) S ' + 'x '.repeat(30), ), null, 'campos não numéricos');
});

// ── parser de /proc/<pid>/status (RSS) ───────────────────────────────────────

test('parseVmRssBytes: VmRSS REAL em kB vira bytes', () => {
  assert.equal(parseVmRssBytes(REAL_FFMPEG_STATUS), 12012 * 1024);
});

test('parseVmRssBytes: /proc/self/status REAL do processo de teste é plausível', { skip: skipNoProc }, () => {
  const rss = parseVmRssBytes(readFileSync('/proc/self/status', 'utf8'));
  assert.ok(rss != null && rss > 1024 * 1024, `RSS do próprio node devia passar de 1MB, veio ${rss}`);
  assert.ok(rss < 64 * 1024 * 1024 * 1024, 'RSS absurdo indica unidade errada');
});

test('parseVmRssBytes: sem VmRSS (processo zumbi) devolve null', () => {
  assert.equal(parseVmRssBytes('Name:\tffmpeg\nState:\tZ (zombie)\n'), null);
  assert.equal(parseVmRssBytes(''), null);
});

// ── CPU% entre duas amostras ─────────────────────────────────────────────────

test('computeCpuPercent: 0,5s de CPU em 1s de relógio = 50% (meio núcleo)', () => {
  const pct = computeCpuPercent(
    { cpuTicks: 1000, atMs: 0 },
    { cpuTicks: 1050, atMs: 1000 },
    DEFAULT_CLOCK_TICKS_PER_SECOND,
  );
  assert.equal(pct, 50);
});

test('computeCpuPercent: NORMALIZA pelo tempo decorrido — 50 ticks em 10s = 5%', () => {
  // Sem dividir pelo relógio, o valor dependeria do intervalo de amostragem:
  // trocar o intervalo de 10s para 5s dobraria o "uso de CPU" de toda a frota.
  const pct = computeCpuPercent({ cpuTicks: 0, atMs: 0 }, { cpuTicks: 50, atMs: 10_000 }, 100);
  assert.equal(pct, 5);
});

test('computeCpuPercent: mais de um núcleo passa de 100% (transcode multi-thread)', () => {
  const pct = computeCpuPercent({ cpuTicks: 0, atMs: 0 }, { cpuTicks: 250, atMs: 1000 }, 100);
  assert.equal(pct, 250);
});

test('computeCpuPercent: relógio parado ou andando para trás devolve null', () => {
  assert.equal(computeCpuPercent({ cpuTicks: 0, atMs: 1000 }, { cpuTicks: 10, atMs: 1000 }, 100), null);
  assert.equal(computeCpuPercent({ cpuTicks: 0, atMs: 2000 }, { cpuTicks: 10, atMs: 1000 }, 100), null);
});

test('computeCpuPercent: contador que REGRIDE (PID reciclado) devolve null, não negativo', () => {
  assert.equal(computeCpuPercent({ cpuTicks: 500, atMs: 0 }, { cpuTicks: 3, atMs: 1000 }, 100), null);
});

// ── sampler ──────────────────────────────────────────────────────────────────

test('sampler: 1ª amostra NÃO tem CPU% (sem linha de base não existe derivada); a 2ª tem', () => {
  let now = 1_000_000;
  const files = procWith([
    ['/proc/4242/stat', statLine({ pid: 4242, utime: 1000, stime: 200 })],
    ['/proc/4242/status', statusBlock(12012)],
  ]);
  const sampler = new ProcessUsageSampler({
    readFile: fakeProc(files),
    clock: () => now,
    ticksPerSecond: 100,
  });

  const first = sampler.sample([4242]);
  assert.equal(first.deadPids.length, 0);
  assert.equal(first.readings.length, 1);
  assert.equal(first.readings[0].cpuPercent, null, 'inventar 0% na primeira leitura mentiria sobre uma câmera pesada');
  assert.equal(first.readings[0].rssBytes, 12012 * 1024, 'RSS já é absoluto: vale desde a primeira leitura');

  now += 10_000;
  files.set('/proc/4242/stat', statLine({ pid: 4242, utime: 1600, stime: 400 })); // +800 ticks em 10s
  const second = sampler.sample([4242]);
  assert.equal(second.readings[0].cpuPercent, 80, '800 ticks / 100 Hz = 8s de CPU em 10s = 80%');
});

test('sampler: PID que SUMIU (ENOENT) some da amostragem e é reportado morto — sem erro', () => {
  const files = procWith([
    ['/proc/10/stat', statLine({ pid: 10 })],
    ['/proc/10/status', statusBlock(1000)],
    ['/proc/11/stat', enoent()],
  ]);
  const sampler = new ProcessUsageSampler({ readFile: fakeProc(files), clock: () => 1000, ticksPerSecond: 100 });

  const result = sampler.sample([10, 11, 12]); // 12 nem existe no mapa
  assert.deepEqual(result.readings.map((r) => r.pid), [10], 'só o processo vivo é amostrado');
  assert.deepEqual(result.deadPids.sort((a, b) => a - b), [11, 12], 'os que sumiram viram baixa, não exceção');
});

test('sampler: erro de PERMISSÃO não declara o processo morto (ele está vivo)', () => {
  // Desregistrar um FFmpeg de gravação vivo por causa de um EACCES apagaria a
  // câmera do relatório de custo — e ela continua consumindo o host.
  const files = procWith([['/proc/20/stat', eacces()]]);
  const sampler = new ProcessUsageSampler({ readFile: fakeProc(files), clock: () => 1000, ticksPerSecond: 100 });
  const result = sampler.sample([20]);
  assert.deepEqual(result.readings, []);
  assert.deepEqual(result.deadPids, [], 'EACCES ≠ morto');
});

test('sampler: SEM /proc (outro SO) fica indisponível — nada é amostrado e NINGUÉM é dado como morto', () => {
  const sampler = new ProcessUsageSampler({
    readFile: fakeProc(new Map()), // nem /proc/self/stat existe
    clock: () => 1000,
  });
  assert.equal(sampler.available, false);
  const result = sampler.sample([1, 2, 3]);
  assert.deepEqual(result.readings, []);
  assert.deepEqual(result.deadPids, [], 'em SO sem /proc a métrica some; o registro de processos NÃO pode ser limpo');
});

test('sampler: PID RECICLADO (starttime diferente) reinicia a base em vez de reportar CPU absurda', () => {
  let now = 0;
  const files = procWith([
    ['/proc/77/stat', statLine({ pid: 77, utime: 900_000, stime: 100_000, starttime: 111 })],
    ['/proc/77/status', statusBlock(5000)],
  ]);
  const sampler = new ProcessUsageSampler({ readFile: fakeProc(files), clock: () => now, ticksPerSecond: 100 });
  sampler.sample([77]);

  now += 5000;
  // Mesmo PID, processo NOVO: contador zerado e starttime diferente.
  files.set('/proc/77/stat', statLine({ pid: 77, utime: 10, stime: 5, starttime: 999 }));
  const second = sampler.sample([77]);
  assert.equal(second.readings[0].cpuPercent, null, 'sem base válida não se publica número');

  now += 1000;
  files.set('/proc/77/stat', statLine({ pid: 77, utime: 60, stime: 5, starttime: 999 }));
  const third = sampler.sample([77]);
  assert.equal(third.readings[0].cpuPercent, 50, 'a partir da nova base a derivada volta a valer');
});

test('sampler: leitura de stat OK mas status ilegível → RSS null, processo continua vivo', () => {
  const files = procWith([
    ['/proc/33/stat', statLine({ pid: 33 })],
    ['/proc/33/status', eacces()],
  ]);
  const sampler = new ProcessUsageSampler({ readFile: fakeProc(files), clock: () => 1000, ticksPerSecond: 100 });
  const result = sampler.sample([33]);
  assert.equal(result.readings.length, 1);
  assert.equal(result.readings[0].rssBytes, null);
  assert.deepEqual(result.deadPids, []);
});

test('sampler: a linha de base NÃO cresce sem fim (PID que saiu do registro é esquecido)', () => {
  const files = procWith([
    ['/proc/50/stat', statLine({ pid: 50 })],
    ['/proc/50/status', statusBlock(1000)],
    ['/proc/51/stat', statLine({ pid: 51 })],
    ['/proc/51/status', statusBlock(1000)],
  ]);
  const sampler = new ProcessUsageSampler({ readFile: fakeProc(files), clock: () => 1000, ticksPerSecond: 100 });
  sampler.sample([50, 51]);
  assert.equal(sampler.baselineSize, 2);
  sampler.sample([50]);
  assert.equal(sampler.baselineSize, 1, 'a memória do sampler acompanha o registro, não o histórico');
});

test('sampler: leitura REAL do próprio processo produz números plausíveis', { skip: skipNoProc }, () => {
  const sampler = new ProcessUsageSampler();
  assert.equal(sampler.available, true, 'em Linux o /proc tem de estar disponível');
  const first = sampler.sample([process.pid]);
  assert.equal(first.readings.length, 1);
  assert.equal(first.readings[0].pid, process.pid);
  assert.ok((first.readings[0].rssBytes ?? 0) > 1024 * 1024, 'RSS real do node > 1MB');

  // Queima CPU de verdade para a segunda amostra ter delta observável.
  const spinUntil = Date.now() + 120;
  let acc = 0;
  while (Date.now() < spinUntil) acc += Math.sqrt(acc + 1);
  assert.ok(acc >= 0);

  const second = sampler.sample([process.pid]);
  const cpu = second.readings[0].cpuPercent;
  assert.ok(cpu != null, 'com base estabelecida o CPU% tem de existir');
  assert.ok(cpu >= 0 && cpu <= 100 * 64, `CPU% fora de faixa plausível: ${cpu}`);
});

test('sampler: PID inválido é ignorado sem virar leitura nem baixa', () => {
  const sampler = new ProcessUsageSampler({ readFile: fakeProc(procWith([])), clock: () => 1, ticksPerSecond: 100 });
  const result = sampler.sample([0, -1, 1.5, Number.NaN as unknown as number]);
  assert.deepEqual(result.readings, []);
  assert.deepEqual(result.deadPids, []);
});

// ── orçamento de CPU do host (denominador do "cabe mais câmera?") ────────────

test('parseCgroupCpuMax: cota do container v2 vale mais que o nº de núcleos do host', () => {
  assert.equal(parseCgroupCpuMax('400000 100000\n'), 4, 'quota/period = 4 núcleos');
  assert.equal(parseCgroupCpuMax('50000 100000\n'), 0.5);
  assert.equal(parseCgroupCpuMax('max 100000\n'), null, 'sem cota o denominador é o host');
  assert.equal(parseCgroupCpuMax('lixo'), null);
  assert.equal(parseCgroupCpuMax(''), null);
});

test('parseCgroupCpuV1: cfs_quota_us/-1 = sem limite', () => {
  assert.equal(parseCgroupCpuV1('200000', '100000'), 2);
  assert.equal(parseCgroupCpuV1('-1', '100000'), null);
  assert.equal(parseCgroupCpuV1('100000', '0'), null);
});

// ── a pergunta comercial: quantas câmeras cabem ──────────────────────────────

test('capacidade: 8 câmeras a 25% num host de 4 núcleos → sobra folga', () => {
  const capacity = estimateCameraCapacity({
    cpuPercentTotal: 200, // 8 × 25%
    cameras: 8,
    cpuBudgetCores: 4,
    headroomRatio: 0.2,
  });
  assert.equal(capacity.cpuPercentPerCamera, 25);
  assert.equal(capacity.cpuSaturation, 0.5, '200% de 400% disponíveis');
  assert.equal(capacity.estimatedCameraCapacity, 12, '400 × 0,8 = 320 → 320/25 = 12 câmeras');
});

test('capacidade: host JÁ estourado responde MENOS câmeras do que as instaladas (não mente)', () => {
  const capacity = estimateCameraCapacity({
    cpuPercentTotal: 380,
    cameras: 10,
    cpuBudgetCores: 4,
    headroomRatio: 0.2,
  });
  assert.equal(capacity.estimatedCameraCapacity, 8, 'a resposta honesta é "tira duas", não "cabe mais"');
  assert.ok((capacity.cpuSaturation ?? 0) > 0.9);
});

test('capacidade: sem câmera medida não há palpite (null, não zero)', () => {
  const capacity = estimateCameraCapacity({ cpuPercentTotal: 0, cameras: 0, cpuBudgetCores: 4 });
  assert.equal(capacity.cpuPercentPerCamera, null);
  assert.equal(capacity.estimatedCameraCapacity, null, 'chute com n=0 é o que vende hardware errado');
  assert.equal(capacity.cpuSaturation, 0);
});

test('capacidade: orçamento de CPU inválido não vira divisão por zero', () => {
  const capacity = estimateCameraCapacity({ cpuPercentTotal: 100, cameras: 2, cpuBudgetCores: 0 });
  assert.equal(capacity.cpuSaturation, null);
  assert.equal(capacity.estimatedCameraCapacity, null);
});
