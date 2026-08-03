import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// VAZAMENTO DE SESSÃO WEBRTC — o bug que fazia "fps baixo e servidor travando".
//
// MEDIDO em produção: um único tile chegou a ter TRÊS sessões WebRTC vivas
// para a MESMA câmera (Cam-15, Cam-16, Cam-18 simultaneamente). Cada sessão
// baixa e decodifica o mesmo vídeo; elas competem, o MediaMTX registra
// "reader is too slow, discarding N frames" (44.105 quadros em 6 minutos) e o
// operador vê a grade travando — com o SERVIDOR OCIOSO (load 0,72 em 10
// núcleos). O gargalo estava no navegador, multiplicado por sessões órfãs.
//
// A causa: a URL da sessão WHEP ia direto para uma ref COMPARTILHADA entre
// tentativas. Uma tentativa já superada (timeout → retry criou outro `pc`)
// sobrescrevia a URL da tentativa nova; o `pc` velho ficava sem dono — nunca
// fechado, sessão nunca deletada, leitor eterno no servidor.
//
// Este arquivo é análise estática do componente: o comportamento real exige
// RTCPeerConnection e um servidor WHEP, que não existem no runner. O que dá
// para travar aqui — e é o que importa — são as duas barreiras que impedem
// um `pc` de existir sem dono.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = readFileSync(
  join(import.meta.dirname, '..', 'src', 'components', 'LiveStreamPlayer.tsx'),
  'utf8',
);

/** Corpo da negociação WHEP: do POST até o setRemoteDescription. */
function trechoNegociacao() {
  const i = SRC.indexOf('const response = await fetch(whepUrl');
  assert.ok(i > -1, 'negociação WHEP não encontrada');
  const f = SRC.indexOf('await pc.setRemoteDescription', i);
  assert.ok(f > i);
  return SRC.slice(i, f);
}

/**
 * O cabeçalho do bloco `{ … }` que ENVOLVE a posição dada.
 *
 * Anda para trás contando chaves até achar a abertura sem par: é essa que
 * delimita o bloco. Comparar texto ("a linha tem `if (sessionUrl)`?") não serve
 * — um `if` fechado logo antes passaria pelo mesmo teste sem envolver nada.
 */
function aberturaDoBlocoQueEnvolve(fonte: string, posicao: number): string {
  let profundidade = 0;
  for (let i = posicao; i >= 0; i -= 1) {
    if (fonte[i] === '}') profundidade += 1;
    else if (fonte[i] === '{') {
      if (profundidade === 0) return fonte.slice(Math.max(0, i - 80), i + 1).trim();
      profundidade -= 1;
    }
  }
  return '';
}

test('a URL da sessão é LOCAL da tentativa antes de virar a oficial', () => {
  const t = trechoNegociacao();
  const local = t.indexOf('const sessionUrl');
  const publica = t.indexOf('webrtcSessionUrlRef.current = sessionUrl');
  assert.ok(local > -1, 'a URL precisa ser capturada numa variável da tentativa');
  assert.ok(publica > local, 'e só depois publicada na ref compartilhada');
  // A publicação NÃO pode ser incondicional: é exatamente o que sobrescrevia
  // a sessão da tentativa vencedora. O que importa é a GUARDA, não a grafia —
  // a asserção antiga exigia o `if` de uma linha e passou a falhar quando ele
  // virou bloco (que além de guardar, apaga a sessão anterior no servidor).
  assert.match(
    aberturaDoBlocoQueEnvolve(t, publica),
    /if \(sessionUrl\)\s*\{$/,
    'a publicação precisa estar dentro de uma guarda `if (sessionUrl)`',
  );
});

test('tentativa SUPERADA fecha o pc e APAGA a própria sessão no servidor', () => {
  const t = trechoNegociacao();
  const guarda = t.indexOf('const superada');
  assert.ok(guarda > -1, 'a tentativa precisa saber se foi superada');
  const bloco = t.slice(guarda, t.length);
  assert.match(bloco, /pc\.close\(\)/, 'sem fechar o pc, a conexão fica viva no navegador');
  assert.match(bloco, /method: 'DELETE'/, 'sem DELETE, o leitor fica vivo no servidor');
  // Ordem: a limpeza tem que acontecer ANTES de lançar, senão o throw pula tudo.
  const fecha = bloco.indexOf('pc.close()');
  const lanca = bloco.indexOf('throw new Error');
  assert.ok(fecha < lanca, 'limpe antes de lançar — o throw aborta o resto');
});

test('um pc anterior é FECHADO antes de ser substituído na ref', () => {
  // Segunda barreira: qualquer caminho que chegue à criação de um novo
  // RTCPeerConnection não pode simplesmente perder a referência do anterior.
  const i = SRC.indexOf('const pc = new RTCPeerConnection(');
  assert.ok(i > -1);
  const antes = SRC.slice(Math.max(0, i - 500), i);
  assert.match(antes, /webrtcPcRef\.current\.close\(\)/, 'feche o pc anterior antes de sobrescrever a ref');
});

test('o DELETE da sessão continua existindo na limpeza normal', () => {
  // A correção acima trata a tentativa superada; o caminho normal (fechar o
  // tile, trocar de protocolo) tem que continuar apagando a sessão também.
  const i = SRC.indexOf('const cleanupWebrtc =');
  const f = SRC.indexOf('const waitForVisibleFrame', i);
  const corpo = SRC.slice(i, f);
  assert.match(corpo, /webrtcSessionUrlRef\.current/);
  assert.match(corpo, /method: 'DELETE'/);
  assert.match(corpo, /webrtcPcRef\.current\.close\(\)/);
});
