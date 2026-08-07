import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// ── REDE DE PROTEÇÃO CONTRA REGRESSÃO ───────────────────────────────────────
//
// A auditoria de front-end encontrou três classes de defeito que voltam
// sozinhas em qualquer refatoração, porque não quebram build nem teste:
//   1. token/classe CSS que NÃO EXISTE — falha em silêncio (`background-color`
//      inválido computa para transparent; foi assim que o botão "Apagar
//      definitivamente" ficou branco sobre branco no tema claro);
//   2. caixa nativa do navegador (`confirm`/`alert`/`prompt`) no lugar do
//      diálogo do sistema — fora do tema, sem foco preso;
//   3. `toISOString()` para MOSTRAR hora — é UTC por definição e no Brasil
//      aparece 3h adiantado (custou um relógio errado sobre imagem de câmera
//      em duas telas, uma delas congelado por não ter setInterval).
//
// Leem o código-fonte e são grosseiros de propósito: falham cedo e sem
// depender de renderizar nada.

const RAIZ = new URL('../src/', import.meta.url).pathname;

function fontes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entrada) => {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) return fontes(caminho);
    return /\.(tsx|ts)$/.test(entrada.name) ? [caminho] : [];
  });
}

// O kit `components/ui/**` é código de terceiros (shadcn/Radix): usa variáveis
// definidas em tempo de execução pelo próprio Radix (`--radix-*`) e outras que
// ele mesmo injeta via `style`. A regra vale para o NOSSO código.
const ARQUIVOS = fontes(RAIZ).filter((caminho) => !caminho.includes('/components/ui/'));
const CSS = readFileSync(join(RAIZ, 'index.css'), 'utf8');

test('todo token --* usado nas telas existe no CSS', () => {
  const definidos = new Set([...CSS.matchAll(/(--[a-z0-9-]+)\s*:/gi)].map((m) => m[1]));
  const faltando: string[] = [];
  for (const arquivo of ARQUIVOS) {
    const codigo = readFileSync(arquivo, 'utf8');
    for (const uso of codigo.matchAll(/var\((--[a-z0-9-]+)/g)) {
      const token = uso[1];
      if (definidos.has(token)) continue;
      if (token.startsWith('--radix-')) continue;       // injetado pelo Radix
      if (codigo.includes(`'${token}'`) || codigo.includes(`"${token}"`)) continue; // definido inline no próprio arquivo
      faltando.push(`${arquivo.replace(RAIZ, '')} usa ${token}`);
    }
  }
  assert.deepEqual(faltando, [], `token inexistente vira transparent e some da tela:\n${faltando.join('\n')}`);
});

test('nenhuma caixa nativa do navegador em ação de usuário', () => {
  const achados: string[] = [];
  for (const arquivo of ARQUIVOS) {
    for (const uso of readFileSync(arquivo, 'utf8').matchAll(/window\.(confirm|alert|prompt)\s*\(/g)) {
      achados.push(`${arquivo.replace(RAIZ, '')}: window.${uso[1]}`);
    }
  }
  assert.deepEqual(achados, [], `use o diálogo do sistema (tema, foco preso, Esc):\n${achados.join('\n')}`);
});

test('nenhum toISOString() usado para mostrar hora ao usuário', () => {
  const achados: string[] = [];
  for (const arquivo of ARQUIVOS) {
    for (const linha of readFileSync(arquivo, 'utf8').split('\n')) {
      if (!linha.includes('toISOString()')) continue;
      // ISO em parâmetro de API ou em campo `type="date"` é LEGÍTIMO. O que
      // denuncia exibição é "humanizar" o ISO: trocar o T por espaço ou
      // recortar a parte da hora.
      const renderiza = /toISOString\(\)\s*\.\s*replace\(\s*['"]T['"]/.test(linha)
        || /toISOString\(\)\s*\.\s*substring\(\s*11/.test(linha);
      if (renderiza) achados.push(`${arquivo.replace(RAIZ, '')}: ${linha.trim().slice(0, 90)}`);
    }
  }
  assert.deepEqual(achados, [], `toISOString() é UTC — use format() local:\n${achados.join('\n')}`);
});
