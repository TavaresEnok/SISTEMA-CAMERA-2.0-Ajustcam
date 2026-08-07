import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// ─────────────────────────────────────────────────────────────────────────────
// CADA INSTALAÇÃO RODA SOB A MARCA DO PRÓPRIO CLIENTE.
//
// Defeito real (D-GUARDIAN, 07/08/2026 — primeira instalação de cliente): a
// barra lateral mostrava "D-GUARDIAN" e, logo abaixo, "AjustCam". A tela de
// login, o rodapé de status, a paleta de comandos e o título da aba faziam o
// mesmo. Duas marcas na mesma tela, a nossa dentro do produto que ele comprou.
//
// A regra: `PRODUCT_NAME` é o valor de RESERVA para quem não tem marca própria
// (é o que `normalizeFacilityName` devolve) — nunca um texto pintado na tela ao
// lado do nome da instalação. Quem quer um rótulo fixo usa `PRODUCT_TAGLINE`,
// que é um descritor e não uma marca.
// ─────────────────────────────────────────────────────────────────────────────

const SRC = './src';

// Só estes definem/derivam o valor de reserva; a proibição não se aplica a eles.
const PODEM_USAR = new Set(['src/lib/product-brand.ts', 'src/store/brandingStore.ts']);

function arquivosDeInterface(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) saida.push(...arquivosDeInterface(caminho));
    else if (/\.tsx?$/.test(nome)) saida.push(caminho);
  }
  return saida;
}

test('nenhuma tela pinta a marca do fornecedor junto com a marca da instalação', () => {
  const infratores: string[] = [];

  for (const caminho of arquivosDeInterface(SRC)) {
    const rel = caminho.replace(/^\.\//, '');
    if (PODEM_USAR.has(rel)) continue;
    const texto = readFileSync(caminho, 'utf8');

    // `{PRODUCT_NAME}` dentro do JSX é literalmente a marca desenhada na tela.
    texto.split('\n').forEach((linha, i) => {
      if (/\{PRODUCT_NAME\}/.test(linha)) infratores.push(`${rel}:${i + 1}`);
    });
  }

  assert.deepEqual(
    infratores,
    [],
    'Marca do fornecedor renderizada na interface. Numa instalação de cliente ela '
    + 'aparece ao lado da marca dele. Use `facilityName` (a marca da instalação, que '
    + 'já cai em PRODUCT_NAME quando não há marca própria) ou `PRODUCT_TAGLINE` '
    + '(descritor). Locais: ',
  );
});

test('o título da aba não carrega a marca do fornecedor junto com a do cliente', async () => {
  const { productPageTitle, PRODUCT_NAME } = await import('../src/lib/product-brand.ts');

  // Cliente com marca própria: só a marca dele na aba do navegador.
  assert.equal(productPageTitle('D-GUARDIAN'), 'D-GUARDIAN');
  assert.ok(!productPageTitle('D-GUARDIAN').includes(PRODUCT_NAME));

  // Sem marca própria, o valor de reserva continua valendo.
  assert.equal(productPageTitle(''), PRODUCT_NAME);
  assert.equal(productPageTitle(null), PRODUCT_NAME);
  assert.equal(productPageTitle('DRAC VMS'), PRODUCT_NAME, 'marca legada não pode reaparecer');
});
