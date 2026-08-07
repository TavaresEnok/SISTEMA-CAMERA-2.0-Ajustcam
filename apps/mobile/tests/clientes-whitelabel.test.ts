import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// ── UM PACOTE, UM APP ───────────────────────────────────────────────────────
//
// O cliente `redesign` nasceu com o MESMO `packageId` do app oficial. Como cada
// cliente é assinado com a própria keystore, o resultado é o pior dos dois
// mundos: não instala lado a lado (é "o mesmo app" para o Android) e não
// instala por cima (assinatura diferente). O sintoma aparece só no aparelho,
// depois de todo o build — daí o teste.

const RAIZ = new URL('../clients/', import.meta.url).pathname;

type Config = { appName?: string; packageId?: string; apiUrl?: string };

function clientes(): Array<{ slug: string; config: Config }> {
  return readdirSync(RAIZ, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => ({
      slug: e.name,
      config: JSON.parse(readFileSync(join(RAIZ, e.name, 'config.json'), 'utf8')) as Config,
    }));
}

test('cada cliente tem um packageId ÚNICO', () => {
  const porPacote = new Map<string, string[]>();
  for (const { slug, config } of clientes()) {
    const pacote = config.packageId ?? '(sem packageId)';
    porPacote.set(pacote, [...(porPacote.get(pacote) ?? []), slug]);
  }
  const colisoes = [...porPacote.entries()].filter(([, slugs]) => slugs.length > 1);
  assert.deepEqual(
    colisoes, [],
    `pacote repetido não instala lado a lado e recusa instalar por cima:\n${
      colisoes.map(([pacote, slugs]) => `  ${pacote} ← ${slugs.join(', ')}`).join('\n')}`,
  );
});

test('todo cliente declara packageId e nome', () => {
  for (const { slug, config } of clientes()) {
    assert.ok(config.packageId, `${slug}: sem packageId`);
    assert.match(config.packageId!, /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/, `${slug}: packageId inválido para Android`);
    assert.ok(config.appName, `${slug}: sem appName`);
  }
});
