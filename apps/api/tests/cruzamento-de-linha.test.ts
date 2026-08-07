import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  avaliarTravessias,
  linhaValida,
  linhasDe,
  pontoDeReferencia,
  type LinhaVirtual,
} from '../src/cameras/helpers/cruzamento-de-linha.helper';

// ─────────────────────────────────────────────────────────────────────────────
// Geometria do tripwire. Estes testes existem porque o modo de falhar aqui é
// SILENCIOSO nos dois sentidos: ou dispara com alguém a metros do portão (a
// linha virou reta infinita), ou não dispara nunca e o perímetro fica cego —
// e ninguém descobre até precisar do vídeo.
// ─────────────────────────────────────────────────────────────────────────────

/** Linha vertical no meio do quadro: A em cima, B embaixo. */
const VERTICAL: LinhaVirtual = { id: 'l1', name: 'Portão', points: [[0.5, 0.2], [0.5, 0.8]] };
const P = (x: number, y: number) => ({ x, y });

test('atravessar a linha é detectado; andar do mesmo lado, não', () => {
  const cruzou = avaliarTravessias(P(0.3, 0.5), P(0.7, 0.5), [VERTICAL]);
  assert.equal(cruzou.length, 1);
  assert.equal(cruzou[0].linhaNome, 'Portão');

  const naoCruzou = avaliarTravessias(P(0.2, 0.5), P(0.4, 0.5), [VERTICAL]);
  assert.deepEqual(naoCruzou, [], 'andou paralelo e disparou');
});

test('A LINHA TEM FIM — passar além dos extremos não conta', () => {
  // O erro clássico: tratar a linha como reta infinita. A linha vai de y=0.2 a
  // y=0.8; alguém cruzando o mesmo x mas em y=0.05 está passando POR CIMA do
  // portão, não por ele. Sem esta regra, uma linha no portão dispararia com
  // gente andando na calçada muito acima.
  const acima = avaliarTravessias(P(0.3, 0.05), P(0.7, 0.05), [VERTICAL]);
  assert.deepEqual(acima, [], 'disparou fora do trecho da linha');

  const abaixo = avaliarTravessias(P(0.3, 0.95), P(0.7, 0.95), [VERTICAL]);
  assert.deepEqual(abaixo, [], 'disparou fora do trecho da linha');
});

test('o sentido da travessia é reconhecido, e é oposto na volta', () => {
  const ida = avaliarTravessias(P(0.3, 0.5), P(0.7, 0.5), [VERTICAL]);
  const volta = avaliarTravessias(P(0.7, 0.5), P(0.3, 0.5), [VERTICAL]);
  assert.equal(ida.length, 1);
  assert.equal(volta.length, 1);
  assert.notEqual(ida[0].sentido, volta[0].sentido, 'entrar e sair viraram a mesma coisa');
});

test('com sentido configurado, só a direção proibida marca `proibido`', () => {
  // "Não passar para dentro" — sair pode.
  const ida = avaliarTravessias(P(0.3, 0.5), P(0.7, 0.5), [VERTICAL]);
  const sentidoProibido = ida[0].sentido;
  const linha = { ...VERTICAL, sentido: sentidoProibido };

  const entrando = avaliarTravessias(P(0.3, 0.5), P(0.7, 0.5), [linha]);
  assert.equal(entrando[0].proibido, true, 'o sentido proibido não foi marcado');

  const saindo = avaliarTravessias(P(0.7, 0.5), P(0.3, 0.5), [linha]);
  assert.equal(saindo.length, 1, 'a travessia ainda deve ser RELATADA');
  assert.equal(saindo[0].proibido, false, 'sair virou infração');
});

test('sem sentido configurado, qualquer travessia é proibida', () => {
  const ida = avaliarTravessias(P(0.3, 0.5), P(0.7, 0.5), [VERTICAL]);
  const volta = avaliarTravessias(P(0.7, 0.5), P(0.3, 0.5), [VERTICAL]);
  assert.equal(ida[0].proibido, true);
  assert.equal(volta[0].proibido, true);
});

test('objeto parado não cruza nada, mesmo em cima da linha', () => {
  // Sem esta guarda, o tremor de um pixel de um objeto encostado na linha
  // viraria enxurrada de travessias no mesmo lugar.
  assert.deepEqual(avaliarTravessias(P(0.5, 0.5), P(0.5, 0.5), [VERTICAL]), []);
});

test('trajeto colinear com a linha não conta como travessia', () => {
  // Andar EM CIMA da linha (do portão aberto, por exemplo) não é atravessá-la.
  assert.deepEqual(avaliarTravessias(P(0.5, 0.3), P(0.5, 0.7), [VERTICAL]), []);
});

test('várias linhas: relata todas as que foram cruzadas no mesmo trajeto', () => {
  const segunda: LinhaVirtual = { id: 'l2', name: 'Corredor', points: [[0.6, 0.2], [0.6, 0.8]] };
  const t = avaliarTravessias(P(0.3, 0.5), P(0.9, 0.5), [VERTICAL, segunda]);
  assert.equal(t.length, 2);
  assert.deepEqual(t.map((x) => x.linhaNome).sort(), ['Corredor', 'Portão']);
});

test('linha diagonal também funciona', () => {
  // Diagonal é a reta y = x. "Mesmo lado" aqui significa manter y < x nos dois
  // instantes — (0.3,0.2)→(0.2,0.3) PARECE curto e inofensivo, mas troca de
  // lado e cruza em (0.25, 0.25); foi assim que este teste me pegou.
  const diagonal: LinhaVirtual = { id: 'd', name: 'Diagonal', points: [[0.2, 0.2], [0.8, 0.8]] };
  assert.equal(avaliarTravessias(P(0.7, 0.3), P(0.3, 0.7), [diagonal]).length, 1);
  assert.deepEqual(avaliarTravessias(P(0.5, 0.2), P(0.7, 0.3), [diagonal]), [], 'ficou do mesmo lado (y < x nos dois)');
});

test('sem posição anterior não há travessia — o rastreamento é obrigatório', () => {
  // Sem identidade entre quadros não existe trajeto; só se saberia que "há
  // alguém de cada lado", que é outra pergunta.
  assert.deepEqual(avaliarTravessias(null, P(0.7, 0.5), [VERTICAL]), []);
  assert.deepEqual(avaliarTravessias(undefined, P(0.7, 0.5), [VERTICAL]), []);
});

test('linha inválida é ignorada em vez de derrubar a avaliação', () => {
  const ruins: any[] = [
    { id: 'a', name: 'sem pontos', points: [] },
    { id: 'b', name: 'um ponto só', points: [[0.5, 0.5]] },
    { id: 'c', name: 'pontos iguais', points: [[0.5, 0.5], [0.5, 0.5]] },
    { id: 'd', name: 'coordenada inválida', points: [[0.5, NaN], [0.5, 0.8]] },
  ];
  for (const ruim of ruins) assert.equal(linhaValida(ruim), false, ruim.name);
  assert.deepEqual(avaliarTravessias(P(0.3, 0.5), P(0.7, 0.5), ruins), []);
});

test('o ponto de referência é a BASE da caixa, não o centro', () => {
  // Uma pessoa é alta. Pelo centro, ela "cruza" a linha do chão com o tronco
  // enquanto os pés ainda estão fora — alarme adiantado e na posição errada.
  const pessoa = [0.4, 0.2, 0.6, 0.9]; // x1,y1,x2,y2
  const ref = pontoDeReferencia(pessoa);
  assert.deepEqual(ref, { x: 0.5, y: 0.9 }, 'não usou a base');
  assert.notEqual(ref!.y, 0.55, 'usou o centro');
});

test('caixa malformada não vira ponto', () => {
  assert.equal(pontoDeReferencia(null), null);
  assert.equal(pontoDeReferencia([0.1, 0.2]), null);
  assert.equal(pontoDeReferencia([0.1, 0.2, NaN, 0.4]), null);
});

test('linhasDe separa linhas de polígonos e normaliza o sentido', () => {
  const zonas = [
    { id: 'p1', name: 'Área', kind: 'exclude', points: [[0, 0], [1, 0], [1, 1]] },
    { id: 'l1', name: 'Portão', kind: 'line', points: [[0.5, 0.2], [0.5, 0.8]], sentido: 'ab' },
    { id: 'l2', name: 'Sem sentido', kind: 'line', points: [[0.1, 0.1], [0.9, 0.9]] },
    { id: 'l3', name: 'Sentido inválido', kind: 'line', points: [[0.1, 0.9], [0.9, 0.1]], sentido: 'diagonal' },
    { id: 'l4', name: 'Linha quebrada', kind: 'line', points: [[0.5, 0.5]] },
  ];
  const linhas = linhasDe(zonas);
  assert.equal(linhas.length, 3, 'polígono ou linha inválida entraram');
  assert.equal(linhas.find((l) => l.id === 'l1')!.sentido, 'ab');
  assert.equal(linhas.find((l) => l.id === 'l2')!.sentido, 'ambos', 'sem sentido deve virar ambos');
  assert.equal(linhas.find((l) => l.id === 'l3')!.sentido, 'ambos', 'sentido inválido deve cair no padrão');
});

test('lista vazia ou lixo não quebra', () => {
  assert.deepEqual(linhasDe(null), []);
  assert.deepEqual(linhasDe('nada'), []);
  assert.deepEqual(avaliarTravessias(P(0, 0), P(1, 1), []), []);
});
