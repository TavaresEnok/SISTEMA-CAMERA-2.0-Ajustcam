import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// TODA TABELA DO SCHEMA PRECISA NASCER DE UMA MIGRAÇÃO.
//
// Defeito real (D-GUARDIAN, 07/08/2026): `model RolePermission` existia no
// schema.prisma e a tabela existia no servidor de desenvolvimento — mas
// nenhuma migração a criava. Ela tinha chegado lá por `prisma db push`.
//
// O resultado é traiçoeiro: numa base NOVA, `prisma migrate deploy` aplica as
// 48 migrações, imprime "Database schema is up to date!" e a tabela continua
// ausente. A tela de Funções e Permissões respondia 500 em toda instalação de
// cliente, enquanto funcionava perfeitamente na máquina de quem desenvolveu.
//
// Este teste compara os dois lados e falha ANTES do cliente descobrir.
// ─────────────────────────────────────────────────────────────────────────────

// Caminho relativo ao diretório de execução (apps/api), como os demais testes
// deste repositório — `import.meta.dirname` não existe sob a transpilação CJS.
const RAIZ = '.';

function modelosDoSchema(): string[] {
  const schema = readFileSync(join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  return [...schema.matchAll(/^model\s+(\w+)\s*\{/gm)].map((m) => m[1]);
}

function sqlDasMigracoes(): string {
  const dir = join(RAIZ, 'prisma/migrations');
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      try {
        return readFileSync(join(dir, e.name, 'migration.sql'), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
}

/**
 * O nome da TABELA de um model. Prisma usa o nome do model, salvo `@@map`.
 */
function tabelaDoModel(schema: string, model: string): string {
  const bloco = schema.slice(schema.indexOf(`model ${model} {`));
  const corpo = bloco.slice(0, bloco.indexOf('\n}'));
  const map = corpo.match(/@@map\("([^"]+)"\)/);
  return map ? map[1] : model;
}

test('toda tabela do schema é criada por alguma migração', () => {
  const schema = readFileSync(join(RAIZ, 'prisma/schema.prisma'), 'utf8');
  const sql = sqlDasMigracoes();
  const faltando: string[] = [];

  for (const model of modelosDoSchema()) {
    const tabela = tabelaDoModel(schema, model);
    // Aceita CREATE TABLE com ou sem IF NOT EXISTS, aspas ou não.
    const cria = new RegExp(`CREATE\\s+TABLE\\s+(IF\\s+NOT\\s+EXISTS\\s+)?"?${tabela}"?`, 'i');
    if (!cria.test(sql)) faltando.push(`${model} (tabela "${tabela}")`);
  }

  assert.deepEqual(
    faltando,
    [],
    'Model(s) no schema.prisma sem migração que crie a tabela. Numa base NOVA, '
    + '`prisma migrate deploy` diria "up to date" e a tabela não existiria — '
    + 'quebrando só na instalação do cliente. Foi o caso de RolePermission.',
  );
});

test('nenhuma migração foi removida do repositório', () => {
  // Migração aplicada em produção e depois apagada do repo faz o Prisma
  // recusar-se a rodar ("migration found in database but not in folder").
  const dir = join(RAIZ, 'prisma/migrations');
  const pastas = readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);
  assert.ok(pastas.length >= 48, `esperava ao menos 48 migrações, achei ${pastas.length}`);
  for (const p of pastas) {
    assert.match(p, /^\d{14}_/, `pasta de migração com nome fora do padrão: ${p}`);
  }
});
