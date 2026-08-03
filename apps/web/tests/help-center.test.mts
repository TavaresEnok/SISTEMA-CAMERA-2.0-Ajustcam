import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

type HelpArticle = {
  id: string;
  title: string;
  body: string;
  related?: string[];
};

type HelpCategory = {
  id: string;
  articles: HelpArticle[];
};

type HelpContent = {
  categories: HelpCategory[];
};

const testDirectory = dirname(fileURLToPath(import.meta.url));
const publicDirectory = resolve(testDirectory, '../public');
const contentSource = readFileSync(resolve(publicDirectory, 'ajuda/content.js'), 'utf8');
const sandbox: { window: { AJUSTCAM_HELP?: HelpContent } } = { window: {} };
vm.runInNewContext(contentSource, sandbox);

const help = sandbox.window.AJUSTCAM_HELP;
assert.ok(help, 'content.js precisa publicar o conteúdo da Central de Ajuda');

const articles = help.categories.flatMap((category) => category.articles);
const articleIds = articles.map((article) => article.id);
const knownIds = new Set(articleIds);

test('a ajuda cobre todas as páginas operacionais do AjustCam', () => {
  const requiredArticles = [
    'entrar-e-recuperar-acesso',
    'ao-vivo',
    'reproducao',
    'revisao',
    'ptz',
    'modo-mural',
    'minha-conta',
    'cameras',
    'alertas',
    'mapa',
    'investigacoes',
    'armazenamento',
    'usuarios',
    'configuracoes',
    'grupos',
    'funcoes',
  ];

  assert.deepEqual(requiredArticles.filter((id) => !knownIds.has(id)), []);
});

test('identificadores e referências internas da ajuda são válidos', () => {
  assert.equal(knownIds.size, articleIds.length, 'não pode haver identificadores repetidos');

  const missingRelated = articles.flatMap((article) =>
    (article.related ?? [])
      .filter((id) => !knownIds.has(id))
      .map((id) => `${article.id} -> ${id}`),
  );
  const internalLinks = articles.flatMap((article) =>
    [...article.body.matchAll(/href="#([^"]+)"/g)].map((match) => match[1]),
  );

  assert.equal(missingRelated.length, 0, missingRelated.join(', '));
  const missingInternalLinks = internalLinks.filter((id) => !knownIds.has(id));
  assert.equal(missingInternalLinks.length, 0, missingInternalLinks.join(', '));
});

test('a ajuda da instalação não incorpora o produto DRAC Central', () => {
  assert.doesNotMatch(contentSource, /DRAC Central/i);
  assert.doesNotMatch(contentSource, /app-builder/i);
});

test('arquivos públicos e integração com o guia de armazenamento estão presentes', () => {
  const index = readFileSync(resolve(publicDirectory, 'ajuda/index.html'), 'utf8');
  const storageGuide = readFileSync(resolve(publicDirectory, 'armazenamento/index.html'), 'utf8');

  assert.match(index, /\.\/styles\.css/);
  assert.match(index, /\.\/content\.js/);
  assert.match(index, /\.\/app\.js/);
  assert.match(storageGuide, /href="\/ajuda\/"/);
  assert.match(storageGuide, /href="\/ajuda\/#armazenamento"/);
});
