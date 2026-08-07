import test from 'node:test';
import assert from 'node:assert/strict';

// O `beforeSend` é a parte crítica: um relatório de erro carrega, por padrão,
// URLs completas (com token na query, como o MediaMTX exige), cabeçalhos de
// autenticação e corpo de requisição. Sem filtro, ligar relatório de travamento
// significaria mandar credencial de sessão para fora do aparelho.
//
// Aqui testamos as funções de limpeza isoladas do SDK (que não roda em Node).

const CAMPOS_SENSIVEIS = /(token|senha|password|authorization|secret|key|cookie|credential)/i;

function limparUrl(valor: string): string {
  return valor
    .replace(/([?&](?:token|access_token|key|secret|password)=)[^&#\s]*/gi, '$1REDACTED')
    .replace(/\/\/[^/@\s]+:[^/@\s]+@/g, '//REDACTED@');
}

function limparProfundo(valor: unknown, profundidade = 0): unknown {
  if (profundidade > 6 || valor == null) return valor;
  if (typeof valor === 'string') return limparUrl(valor);
  if (Array.isArray(valor)) return valor.map((i) => limparProfundo(i, profundidade + 1));
  if (typeof valor === 'object') {
    const saida: Record<string, unknown> = {};
    for (const [chave, item] of Object.entries(valor as Record<string, unknown>)) {
      saida[chave] = CAMPOS_SENSIVEIS.test(chave) ? '[REDACTED]' : limparProfundo(item, profundidade + 1);
    }
    return saida;
  }
  return valor;
}

test('token da URL de reprodução é redigido, o resto sobrevive', () => {
  const url = 'https://api/recordings/abc/play?token=eyJhbGciOi.PAYLOAD.SIG&forceDirect=1';
  const limpo = limparUrl(url);
  assert.doesNotMatch(limpo, /eyJhbGciOi/, 'o token NÃO pode sair do aparelho');
  assert.match(limpo, /forceDirect=1/, 'o resto é justamente o que ajuda a diagnosticar');
  assert.match(limpo, /recordings\/abc\/play/);
});

test('credencial embutida no host (rtsp://user:senha@ip) é redigida', () => {
  assert.equal(limparUrl('rtsp://admin:s3nh4@10.0.0.5/live'), 'rtsp://REDACTED@10.0.0.5/live');
});

test('campo sensível some pelo NOME da chave, em qualquer profundidade', () => {
  const limpo = limparProfundo({
    nivel1: { headers: { Authorization: 'Bearer abc' }, refreshToken: 'xyz', camera: 'Portaria' },
  }) as any;
  assert.equal(limpo.nivel1.refreshToken, '[REDACTED]');
  // "headers" não é palavra sensível, então a estrutura é preservada — mas o
  // "Authorization" DENTRO dela é redigido. Preservar a forma ajuda a
  // diagnosticar (dá para ver QUE havia um cabeçalho) sem vazar o valor.
  assert.equal(limpo.nivel1.headers.Authorization, '[REDACTED]');
  assert.equal(limpo.nivel1.camera, 'Portaria', 'dado não sensível permanece — senão o relatório não serve');
});

test('a limpeza tem teto de profundidade (objeto cíclico não trava o envio)', () => {
  const raso: any = { a: { b: { c: { d: { e: { f: { g: 'fundo' } } } } } } };
  assert.doesNotThrow(() => limparProfundo(raso));
});

test('valores não-texto passam intactos', () => {
  const limpo = limparProfundo({ contagem: 42, ativo: true, nada: null }) as any;
  assert.equal(limpo.contagem, 42);
  assert.equal(limpo.ativo, true);
  assert.equal(limpo.nada, null);
});
