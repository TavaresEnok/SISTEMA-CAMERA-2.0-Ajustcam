import { test } from 'node:test';
import assert from 'node:assert/strict';
import { escolherGrupoDoCliente, type VinculoDeGrupo } from '../src/cameras/helpers/grupo-do-cliente.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O GRUPO DO CLIENTE, E A COTA QUE DEPENDE DELE
//
// Defeito real em produção: o operador configurou "3 câmeras privadas
// permitidas" no grupo, viu o 3 salvo na tela — e o app do cliente continuou
// dizendo "Cadastro de câmeras não habilitado para sua conta".
//
// A busca pelo grupo exigia nível ADMIN. O vínculo real do cliente era CONTROL.
// Nada era encontrado, o grupo virava nulo, a cota caía para 0 e as duas telas
// discordavam em silêncio — sem erro, sem log, sem pista.
//
// O que estes testes travam é a conta que decide se o cliente pode cadastrar a
// câmera da casa dele, e DENTRO DE QUAL grupo ela nasce. Errar o grupo não é um
// detalhe de cadastro: o grupo governa retenção e acesso, então a câmera cairia
// sob as regras — e à vista — de outro cliente.
// ─────────────────────────────────────────────────────────────────────────────

const em = (dia: number) => new Date(`2026-0${dia}-01T00:00:00Z`);
const v = (groupId: string | null, level: VinculoDeGrupo['level'], dia = 1): VinculoDeGrupo =>
  ({ groupId, level, createdAt: em(dia) });

test('CONTROL identifica o grupo — era exatamente o caso que falhava', () => {
  // O cliente tinha CONTROL no grupo dele. Exigir ADMIN devolvia null, a cota
  // ia a zero e o app bloqueava com o grupo configurado corretamente.
  assert.equal(escolherGrupoDoCliente([v('grupo-flash', 'CONTROL')]), 'grupo-flash');
});

test('qualquer nível serve para IDENTIFICAR o grupo', () => {
  // Quem decide se pode cadastrar é a cota do grupo (0 = não pode), que é o
  // freio explícito de quem opera. O nível da permissão diz o que a pessoa faz
  // com as câmeras, não a qual cliente ela pertence.
  for (const nivel of ['VIEW', 'CONTROL', 'RECORD', 'ADMIN'] as const) {
    assert.equal(escolherGrupoDoCliente([v('g1', nivel)]), 'g1', nivel);
  }
});

test('sem vínculo nenhum devolve null', () => {
  // null não é "pode tudo": quem chama trata como limite 0.
  assert.equal(escolherGrupoDoCliente([]), null);
});

test('vínculo sem grupo é ignorado', () => {
  // Permissão por CÂMERA (groupId nulo) não diz nada sobre a qual grupo a
  // pessoa pertence.
  assert.equal(escolherGrupoDoCliente([v(null, 'ADMIN'), v('g2', 'VIEW')]), 'g2');
});

test('com vários grupos, o nível MAIS ALTO vence', () => {
  // Se alguém é VIEW no grupo de um cliente e ADMIN no próprio, a câmera
  // privada tem de nascer no dele. Errar aqui coloca a câmera da casa de uma
  // pessoa sob a retenção e o acesso de OUTRO cliente.
  const escolha = escolherGrupoDoCliente([
    v('cliente-alheio', 'VIEW', 1),
    v('meu-grupo', 'ADMIN', 5),
    v('outro-alheio', 'CONTROL', 2),
  ]);
  assert.equal(escolha, 'meu-grupo');
});

test('empate no nível: vence o vínculo mais ANTIGO', () => {
  // Estabilidade importa: a cota não pode mudar de grupo porque a pessoa ganhou
  // acesso a outro cliente ontem. Uma cota que se move sozinha é impossível de
  // explicar para quem opera.
  const escolha = escolherGrupoDoCliente([
    v('recente', 'CONTROL', 6),
    v('antigo', 'CONTROL', 2),
  ]);
  assert.equal(escolha, 'antigo');
});

test('a ordem em que o banco devolve não altera a resposta', () => {
  // `findMany` sem `orderBy` não garante ordem. Se a resposta dependesse disso,
  // o mesmo cliente teria cotas diferentes em requisições diferentes.
  const vinculos = [v('a', 'CONTROL', 3), v('b', 'ADMIN', 7), v('c', 'VIEW', 1)];
  const esperado = escolherGrupoDoCliente(vinculos);
  assert.equal(esperado, 'b');
  assert.equal(escolherGrupoDoCliente([...vinculos].reverse()), esperado);
  assert.equal(escolherGrupoDoCliente([vinculos[2], vinculos[0], vinculos[1]]), esperado);
});

test('nível desconhecido não ganha de um conhecido', () => {
  // Um nível novo no schema não pode, por acidente, sequestrar a escolha do
  // grupo — e não pode derrubar a função.
  const estranho = { groupId: 'novo', level: 'SUPER' as never, createdAt: em(1) };
  assert.equal(escolherGrupoDoCliente([estranho, v('conhecido', 'VIEW', 2)]), 'conhecido');
});
