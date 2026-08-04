import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CacheDeDiagnostico } from '../src/recordings/helpers/diagnostics-cache.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O CACHE QUE CONGELAVA A API
//
// Sintoma medido em produção: a API parava de responder por ~11 segundos, a
// tela do operador esvaziava e voltava sozinha minutos depois.
//
// Causa: o resumo de saúde percorre até 1.200 gravações e, para CADA uma,
// relia o arquivo do disco e fazia `JSON.parse` do conteúdo TODO. Com 3.776
// entradas o arquivo tem 1,6 MB e cada leitura custa 8,5ms — 1.200 × 8,5ms =
// 10,2s calculados contra 11,4s medidos na ponta.
//
// O que estes testes travam é a parte que dá errado silenciosamente: um cache
// que responde o valor ERRADO é pior que um cache lento, porque some com
// diagnósticos e o ffprobe refaz tudo — trocando 11 segundos de congelamento
// por minutos de CPU.
// ─────────────────────────────────────────────────────────────────────────────

type Entrada = { checkedAt: string };

function bancada() {
  const dir = mkdtempSync(join(tmpdir(), 'cache-diag-'));
  const arquivo = join(dir, 'recording-health.json');
  const falhas: string[] = [];
  const cache = new CacheDeDiagnostico<Entrada>(
    () => arquivo,
    (m) => falhas.push(m),
  );
  return { dir, arquivo, cache, falhas, limpar: () => rmSync(dir, { recursive: true, force: true }) };
}

test('ler duas vezes NÃO toca o disco de novo — é a correção inteira', () => {
  const b = bancada();
  try {
    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: 'x' } }), 'utf-8');
    const primeira = b.cache.ler();
    const segunda = b.cache.ler();
    // Mesma referência de objeto prova que não houve novo `JSON.parse`. Comparar
    // por conteúdo passaria mesmo se cada chamada relesse o arquivo — e reler é
    // exatamente o defeito de 11 segundos.
    assert.equal(primeira, segunda, 'releu e reinterpretou o arquivo: o congelamento volta');
  } finally {
    b.limpar();
  }
});

test('arquivo trocado por fora é percebido', () => {
  const b = bancada();
  try {
    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: 'antigo' } }), 'utf-8');
    assert.equal(b.cache.ler().a.checkedAt, 'antigo');

    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: 'novo' }, b: { checkedAt: 'novo' } }), 'utf-8');
    // Tamanho mudou, então o memo cai mesmo que o relógio do sistema tenha
    // resolução grossa demais para o mtime diferir.
    assert.equal(b.cache.ler().a.checkedAt, 'novo', 'apagar o arquivo para forçar recontagem tem de funcionar');
  } finally {
    b.limpar();
  }
});

test('mesmo tamanho mas mtime novo também invalida', () => {
  const b = bancada();
  try {
    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: '1111' } }), 'utf-8');
    assert.equal(b.cache.ler().a.checkedAt, '1111');

    // Conteúdo de tamanho idêntico: só o mtime denuncia a troca.
    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: '2222' } }), 'utf-8');
    const depois = statSync(b.arquivo);
    utimesSync(b.arquivo, depois.atime, new Date(depois.mtimeMs + 5000));
    assert.equal(b.cache.ler().a.checkedAt, '2222');
  } finally {
    b.limpar();
  }
});

test('o que foi gravado vale IMEDIATAMENTE, antes de ir ao disco', () => {
  const b = bancada();
  try {
    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: 'velho' } }), 'utf-8');
    b.cache.ler();
    b.cache.gravar({ a: { checkedAt: 'recem-feito' } });
    // Sem isto, a volta seguinte do laço releria o estado anterior e mandaria o
    // ffprobe refazer o trabalho que acabou de ser feito.
    assert.equal(b.cache.ler().a.checkedAt, 'recem-feito');
  } finally {
    b.limpar();
  }
});

test('só grava no disco quando há novidade', () => {
  const b = bancada();
  try {
    assert.equal(b.cache.descarregar(), false, 'gravar 1,6 MB sem motivo é o desperdício que se quer evitar');
    b.cache.gravar({ a: { checkedAt: 'x' } });
    assert.equal(b.cache.descarregar(), true);
    assert.equal(b.cache.descarregar(), false, 'a segunda descarga seguida não tem o que gravar');
  } finally {
    b.limpar();
  }
});

test('o que foi descarregado é lido de volta igual', () => {
  const b = bancada();
  try {
    b.cache.gravar({ a: { checkedAt: 'gravado' } });
    b.cache.descarregar();
    const doDisco = JSON.parse(readFileSync(b.arquivo, 'utf-8'));
    assert.deepEqual(doDisco, { a: { checkedAt: 'gravado' } });
  } finally {
    b.limpar();
  }
});

test('a descarga não deixa arquivo temporário para trás', () => {
  const b = bancada();
  try {
    b.cache.gravar({ a: { checkedAt: 'x' } });
    b.cache.descarregar();
    // O `.tmp` existe para que uma queda no meio da escrita não deixe um JSON
    // pela metade — mas ele tem de virar o arquivo final, não acumular lixo.
    assert.throws(() => statSync(`${b.arquivo}.tmp`));
  } finally {
    b.limpar();
  }
});

test('arquivo corrompido vira vazio, não exceção', () => {
  const b = bancada();
  try {
    writeFileSync(b.arquivo, '{isso não é json', 'utf-8');
    assert.deepEqual(b.cache.ler(), {}, 'um cache ilegível não pode derrubar a listagem de gravações');
    assert.deepEqual(b.cache.ler(), {});
  } finally {
    b.limpar();
  }
});

test('JSON válido que não é objeto também vira vazio', () => {
  const b = bancada();
  try {
    // `JSON.parse("null")` devolve null; usar isso como dicionário estoura no
    // primeiro acesso a chave.
    writeFileSync(b.arquivo, 'null', 'utf-8');
    assert.deepEqual(b.cache.ler(), {});
  } finally {
    b.limpar();
  }
});

test('arquivo ausente não descarta o que está em memória', () => {
  const b = bancada();
  try {
    b.cache.gravar({ a: { checkedAt: 'em-memoria' } });
    // Ninguém escreveu no disco ainda. Devolver vazio aqui jogaria fora
    // diagnósticos e obrigaria o ffprobe a refazê-los.
    assert.equal(b.cache.ler().a.checkedAt, 'em-memoria');
  } finally {
    b.limpar();
  }
});

test('apagar o arquivo depois de ler mantém a memória', () => {
  const b = bancada();
  try {
    writeFileSync(b.arquivo, JSON.stringify({ a: { checkedAt: 'x' } }), 'utf-8');
    b.cache.ler();
    rmSync(b.arquivo);
    assert.equal(b.cache.ler().a.checkedAt, 'x');
  } finally {
    b.limpar();
  }
});

test('falha ao gravar é avisada, não lançada', () => {
  const b = bancada();
  try {
    b.cache.gravar({ a: { checkedAt: 'x' } });
    b.limpar(); // some com o diretório inteiro: a escrita vai falhar
    assert.equal(b.cache.descarregar(), false);
    assert.equal(b.falhas.length, 1);
    assert.match(b.falhas[0], /cache de diagnóstico/i);
    // Continua sujo: a próxima descarga tenta de novo em vez de dar o dado
    // como salvo.
    assert.equal(b.cache.precisaGravar(), true);
  } finally {
    b.limpar();
  }
});
