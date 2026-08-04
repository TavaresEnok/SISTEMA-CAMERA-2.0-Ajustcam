import { test } from 'node:test';
import assert from 'node:assert/strict';
import { maiorPausa, marcandoTrabalho, type PerfilCpu } from '../src/common/observability/event-loop-lag.service';

// ─────────────────────────────────────────────────────────────────────────────
// ACHAR O CULPADO DA TRAVADA
//
// A API para de responder por ~11 segundos e a tela do operador esvazia. Medir
// QUE travou já estava feito; o que faltava era o NOME da função.
//
// A leitura do perfil se apoia numa assinatura: enquanto a thread está presa, o
// amostrador do V8 não consegue disparar, então aparece um intervalo gigante
// entre duas amostras. Errar QUAL amostra corresponde a esse buraco aponta o
// dedo para a função inocente que rodou DEPOIS — e um diagnóstico que acusa o
// inocente é pior que nenhum, porque manda consertar o lugar errado.
// ─────────────────────────────────────────────────────────────────────────────

const quadro = (id: number, nome: string, filhos?: number[]) => ({
  id,
  callFrame: { functionName: nome, url: `file:///app/src/mod/${nome}.ts`, lineNumber: 41 },
  children: filhos,
});

/** raiz → suspeito → vítima, com a travada acontecendo dentro de `suspeito`. */
const perfilComTravada: PerfilCpu = {
  nodes: [quadro(1, 'raiz', [2, 4]), quadro(2, 'suspeito', [3]), quadro(3, 'folha'), quadro(4, 'inocente')],
  //         raiz  suspeito  inocente   folha
  samples: [1, 2, 4, 3],
  // 11 segundos passaram ENTRE a amostra de `suspeito` e a de `inocente`.
  timeDeltas: [1_000, 2_000, 11_000_000, 1_500],
};

test('a travada é atribuída a quem estava rodando ANTES do buraco', () => {
  const r = maiorPausa(perfilComTravada);
  assert.ok(r);
  assert.equal(Math.round(r.ms), 11_000);
  assert.match(r.pilha[0], /^suspeito /, `acusou "${r.pilha[0]}" — o buraco é do quadro anterior, não do seguinte`);
});

test('a pilha sobe até a raiz, para dizer de ONDE veio a chamada', () => {
  // Só o nome da função não basta: a mesma função pode ser chamada de uma rota
  // e de uma tarefa de fundo, e o conserto é diferente em cada caso.
  const r = maiorPausa(perfilComTravada);
  assert.deepEqual(
    r?.pilha.map((q) => q.split(' ')[0]),
    ['suspeito', 'raiz'],
  );
});

test('o quadro traz arquivo e linha, não só o nome', () => {
  const r = maiorPausa(perfilComTravada);
  // Sem isto, "processar" num projeto com 400 arquivos não localiza nada.
  assert.match(r!.pilha[0], /mod\/suspeito\.ts:42/, 'linha do V8 começa em zero; tem de virar a do editor');
});

test('função anônima não vira quadro vazio no log', () => {
  const r = maiorPausa({
    nodes: [{ id: 1, callFrame: { functionName: '', url: 'file:///app/src/a/b.ts', lineNumber: 0 } }],
    samples: [1, 1],
    timeDeltas: [10, 9_000_000],
  });
  assert.match(r!.pilha[0], /\(anônimo\) \(a\/b\.ts:1\)/);
});

test('perfil sem amostras não inventa travada', () => {
  // Um minuto ocioso é comum. Devolver um culpado aqui produziria acusação
  // falsa toda vez que a API ficasse parada.
  assert.equal(maiorPausa(null), null);
  assert.equal(maiorPausa(undefined), null);
  assert.equal(maiorPausa({ nodes: [quadro(1, 'raiz')], samples: [], timeDeltas: [] }), null);
  assert.equal(maiorPausa({ nodes: [quadro(1, 'raiz')] }), null);
});

test('amostra órfã não quebra a leitura do perfil', () => {
  // Perfil truncado no meio: o id da amostra não existe na lista de nós.
  const r = maiorPausa({ nodes: [quadro(1, 'raiz')], samples: [99, 99], timeDeltas: [5, 9_000_000] });
  assert.ok(r);
  assert.deepEqual(r.pilha, [], 'sem nó conhecido, a pilha sai vazia — mas o tempo continua sendo reportado');
});

test('a primeira amostra também pode ser a travada', () => {
  // Travar já na primeira amostra do ciclo é o caso comum quando a travada
  // começou antes do perfil abrir. Não pode ficar sem culpado.
  const r = maiorPausa({ nodes: [quadro(1, 'unico')], samples: [1], timeDeltas: [9_000_000] });
  assert.match(r!.pilha[0], /^unico /);
});

// ── MARCAÇÃO DE TRABALHO PESADO ─────────────────────────────────────────────

test('a marcação some mesmo quando a operação falha', () => {
  // Se um erro deixasse a marca presa, todo relatório seguinte acusaria um
  // trabalho que terminou há horas — e a acusação errada gruda.
  return marcandoTrabalho('envio', async () => {
    throw new Error('bum');
  }).then(
    () => assert.fail('deveria propagar o erro'),
    async (e) => {
      assert.equal((e as Error).message, 'bum');
      // A prova de que a marca saiu: uma segunda passagem que observa o estado.
      let visto = 'nunca rodou';
      await marcandoTrabalho('outro', async () => {
        visto = 'rodou';
      });
      assert.equal(visto, 'rodou');
    },
  );
});

test('a marcação devolve o valor da operação sem alterá-lo', async () => {
  const r = await marcandoTrabalho('envio', async () => ({ enviados: 7 }));
  assert.deepEqual(r, { enviados: 7 });
});
