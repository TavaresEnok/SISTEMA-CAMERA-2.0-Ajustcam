import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// SENTINELA — o teste que impede o defeito de VOLTAR.
//
// `Number(process.env.X ?? 90)` devolve NaN para "90%", "90 ", "noventa" ou
// vírgula decimal. NaN não explode: desarma comparações em silêncio.
//   · guarda de disco: `uso > NaN` é sempre false → o disco enche a 100% e TODAS
//     as câmeras param de gravar, sem um único erro no log;
//   · `setInterval(fn, Math.max(10_000, NaN))` dispara em rajada (~1ms).
// Já aconteceu nesta base. Corrigir os call sites resolve HOJE; o que impede a
// reincidência é este arquivo.
//
// Como este teste funciona: as áreas críticas têm um ORÇAMENTO de ocorrências
// cruas, medido no dia da conversão. Converter para `envNumber` BAIXA o número
// (e continua passando). Reintroduzir sobe e QUEBRA.
//
// ➜ Quando este teste falhar, a correção é CONVERTER o call site novo com
//   `envNumber(nome, default, { min, max, integer, onInvalid })` — não aumentar
//   o orçamento. O orçamento só desce.
// ─────────────────────────────────────────────────────────────────────────────

const API_ROOT = join(__dirname, '..');
const CRU = /(Number|parseInt|parseFloat)\(\s*process\.env/g;
const CRU_BOOLEANO = /String\(\s*process\.env/g;

function arquivosTs(dir: string): string[] {
  const saida: string[] = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) saida.push(...arquivosTs(caminho));
    else if (entrada.name.endsWith('.ts')) saida.push(caminho);
  }
  return saida;
}

/**
 * Conta ocorrências fora de comentário — a documentação do próprio helper cita
 * o padrão proibido, e um sentinela que reclama de comentário vira ruído.
 */
function contarCruas(conteudo: string, padrao: RegExp) {
  const ocorrencias: Array<{ linha: number; texto: string }> = [];
  const linhas = conteudo.split('\n');
  for (let i = 0; i < linhas.length; i += 1) {
    const limpa = linhas[i].trim();
    if (limpa.startsWith('//') || limpa.startsWith('*') || limpa.startsWith('/*')) continue;
    const achados = linhas[i].match(new RegExp(padrao.source, 'g'));
    if (achados) ocorrencias.push({ linha: i + 1, texto: linhas[i].trim() });
  }
  return ocorrencias;
}

function varrer(dirRelativo: string, padrao: RegExp) {
  const ocorrencias: string[] = [];
  for (const arquivo of arquivosTs(join(API_ROOT, dirRelativo))) {
    for (const item of contarCruas(readFileSync(arquivo, 'utf8'), padrao)) {
      ocorrencias.push(`${arquivo.slice(API_ROOT.length + 1)}:${item.linha}  ${item.texto}`);
    }
  }
  return ocorrencias;
}

/**
 * ORÇAMENTO por área crítica — medido em 2026-07-27, quando o esquema de
 * configuração foi criado. Este número NUNCA sobe.
 */
const ORCAMENTO: Record<string, number> = {
  // Gravação: o processo que segura os ffmpeg. Baixou de 35 para 5 na conversão
  // em massa de 2026-07-27. Os 5 que restam usam formas que o conversor não
  // trata com segurança (chave dinâmica, piso por expressão, constante em vez de
  // literal) e foram revisados um a um.
  'src/recordings': 0,
  // Streaming ao vivo: 100% limpo — o orçamento é ZERO e é para ficar.
  'src/camera-stream': 0,
  // Jobs/processors: baixou de 16 para 1 (cooldowns, janelas de saúde, limites
  // por rodada — todos os limiares que decidem REINICIAR câmera foram convertidos;
  // `Math.max(15, NaN)` = NaN desarmava a checagem em silêncio).
  'src/jobs': 1,
  // IA e observabilidade entraram no sentinela depois da conversão em massa.
  'src/ai': 5,
  'src/observability': 2,
  'src/cameras': 1,
};

/** Áreas onde a conversão está COMPLETA: qualquer leitura crua é regressão. */
const TOLERANCIA_ZERO = ['src/config', 'src/common'];

test('sentinela: nenhuma leitura numérica CRUA de process.env é reintroduzida nas áreas críticas', () => {
  for (const [area, teto] of Object.entries(ORCAMENTO)) {
    const ocorrencias = varrer(area, CRU);
    assert.ok(
      ocorrencias.length <= teto,
      `${area}: ${ocorrencias.length} leituras cruas de process.env (orçamento ${teto}).\n`
      + 'NaN aqui desarma guarda/timer EM SILÊNCIO. Converta o ponto novo com envNumber('
      + 'nome, default, { min, max, integer, onInvalid }) — NÃO aumente o orçamento.\n'
      + ocorrencias.join('\n'),
    );
  }
});

test('sentinela: o esquema de configuração e os helpers ficam em ZERO', () => {
  for (const area of TOLERANCIA_ZERO) {
    const numericas = varrer(area, CRU);
    assert.deepEqual(numericas, [], `${area} deve ler número de ambiente SÓ por envNumber`);
    const booleanas = varrer(area, CRU_BOOLEANO);
    assert.deepEqual(booleanas, [], `${area} deve ler flag de ambiente SÓ por envBool`);
  }
});

test('sentinela: os call sites que já sangraram continuam convertidos', () => {
  const retencao = readFileSync(join(API_ROOT, 'src/recordings/retention.service.ts'), 'utf8');
  assert.deepEqual(
    contarCruas(retencao, CRU).map((o) => `${o.linha}: ${o.texto}`),
    [],
    'retention.service apaga gravação: nenhum número dele pode vir de Number(process.env)',
  );
  assert.match(retencao, /envNumber\('RECORDING_RETENTION_DAYS'/, 'dias 0/NaN apagaria o acervo inteiro');
  assert.match(retencao, /envNumber\('RETENTION_DISK_TRIGGER_PERCENT'/, 'NaN desarma o guardião de disco');
  assert.match(retencao, /envNumber\('CAMERA_EVENT_RETENTION_DAYS'/, 'NaN aqui derruba a passagem inteira (Date inválida)');
  assert.match(retencao, /envBool\('RETENTION_TWO_TIER_ENABLED'/, 'flag que apaga gravação não aceita lixo em silêncio');

  const esquema = readFileSync(join(API_ROOT, 'src/config/env.config.ts'), 'utf8');
  assert.match(esquema, /envNumber\(name, fallback/, 'todo número do esquema passa pelo helper');
  assert.match(esquema, /envBool\(name, fallback/, 'toda flag do esquema passa pelo helper');

  const gravacao = readFileSync(join(API_ROOT, 'src/recordings/recording-process-manager.service.ts'), 'utf8');
  assert.match(gravacao, /envNumber\('RECORDING_DISK_GUARD_MAX_USED_PERCENT'/);
  assert.match(gravacao, /envNumber\('RECORDING_DISK_GUARD_INTERVAL_MS'/);
});

test('sentinela: o helper existe e continua sendo a única porta de entrada', () => {
  const helper = readFileSync(join(API_ROOT, 'src/common/config/env-number.helper.ts'), 'utf8');
  assert.match(helper, /export function envNumber/);
  assert.match(helper, /export function envBool/);
  assert.match(helper, /export function parseFiniteNumber/);
  assert.match(helper, /export function parseBooleanish/);
});
