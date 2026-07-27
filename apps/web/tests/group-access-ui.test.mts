import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── Tela de bloqueio comercial do grupo (aba Grupos da instalação) ──────────
// É por aqui que o dono da instalação corta um CLIENTE FINAL em atraso. A tela
// mexe em acesso a conteúdo, então errar em silêncio é caro: o admin precisa
// saber exatamente o que cada opção faz ANTES de clicar em salvar.

const PAGE = readFileSync(new URL('../src/pages/GroupsPage.tsx', import.meta.url), 'utf8');

test('os três estados comerciais existem, com o texto do impacto real', () => {
  assert.match(PAGE, /ACCESS_OPTIONS/);
  for (const estado of ['ACTIVE', 'RESTRICTED', 'SUSPENDED']) {
    assert.ok(PAGE.includes(`'${estado}'`), `estado ${estado} ausente`);
  }
  // O rótulo tem de dizer a CONSEQUÊNCIA, não só o nome do estado.
  assert.match(PAGE, /perde playback, gravações e exportação/i, 'restrito precisa explicar o que se perde');
  assert.match(PAGE, /Não vê nada/i, 'suspenso precisa explicar que corta tudo');
  assert.match(PAGE, /inadimplente/i, 'o uso comercial precisa estar explícito');
});

test('bloquear pede MOTIVO, que o cliente final vê', () => {
  assert.match(PAGE, /editAccessMessage/);
  assert.match(PAGE, /editAccessStatus !== 'ACTIVE' &&/, 'o motivo só aparece quando há bloqueio');
  assert.match(PAGE, /\(o cliente vê\)/, 'precisa deixar claro que o texto é exibido ao cliente');
  assert.match(PAGE, /maxLength=\{300\}/, 'o limite tem de casar com o do backend');
});

test('avisa a consequência imediata antes de salvar', () => {
  assert.match(PAGE, /deixam de ver as câmeras imediatamente/i);
  assert.match(PAGE, /mantêm o ao vivo, mas perdem playback/i);
});

test('o PATCH envia os campos novos junto dos existentes', () => {
  const i = PAGE.indexOf('const updateGroup');
  const corpo = PAGE.slice(i, i + 900);
  assert.match(corpo, /accessStatus: editAccessStatus/);
  assert.match(corpo, /accessMessage: editAccessMessage\.trim\(\) \|\| null/);
  assert.match(corpo, /maxPrivateCameras/, 'não pode ter perdido o campo que já existia');
  assert.match(corpo, /name: editName\.trim\(\)/);
});

test('o modal ABRE com o estado atual do grupo (não com o default)', () => {
  const i = PAGE.indexOf('const openEditGroup');
  const corpo = PAGE.slice(i, i + 500);
  assert.match(corpo, /setEditAccessStatus\(selGroup\?\.accessStatus \?\? 'ACTIVE'\)/,
    'abrir sem carregar o estado atual faria o admin salvar ACTIVE sem querer');
  assert.match(corpo, /setEditAccessMessage/);
});

test('a lista mostra selo de SUSPENSO/RESTRITO (visível sem abrir o grupo)', () => {
  assert.match(PAGE, /SUSPENSO/);
  assert.match(PAGE, /RESTRITO/);
  assert.match(PAGE, /g\.accessStatus === 'SUSPENDED'/);
  assert.match(PAGE, /g\.accessStatus === 'RESTRICTED'/);
});
