import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarAtualizacao, baseDoApk, urlDoBuildInfo } from '../src/utils/atualizacao';

// Sem loja, o APK é distribuído por link e nada avisava o usuário de versão
// nova. A infra já publica o build-info.json ao lado do APK.

const INFO = {
  versionName: '1.4.0',
  versionCode: 12,
  artifacts: { apk: { file: 'drac-default.apk' } },
};

test('versão mais nova é anunciada com a URL do APK', () => {
  const r = avaliarAtualizacao(INFO, 11, 'http://host/apk/');
  assert.equal(r?.versionName, '1.4.0');
  assert.equal(r?.url, 'http://host/apk/drac-default.apk', 'barra final duplicada quebraria o download');
});

test('mesma versão ou mais antiga NÃO avisa', () => {
  assert.equal(avaliarAtualizacao(INFO, 12, 'http://host/apk'), null);
  assert.equal(avaliarAtualizacao(INFO, 13, 'http://host/apk'), null, 'build de teste mais novo que o publicado não é downgrade');
});

test('compara versionCode, não o texto da versão', () => {
  // "1.10" < "1.9" em comparação de string: por isso a ordem vem do inteiro.
  const antigo = { versionName: '1.9.0', versionCode: 9, artifacts: { apk: { file: 'a.apk' } } };
  assert.equal(avaliarAtualizacao(antigo, 10, 'http://h'), null);
});

test('manifesto ilegível ou incompleto é SILENCIOSO', () => {
  // Aviso de atualização que aparece por engano é pior que aviso nenhum.
  assert.equal(avaliarAtualizacao(null, 1, 'http://h'), null);
  assert.equal(avaliarAtualizacao({}, 1, 'http://h'), null);
  assert.equal(avaliarAtualizacao({ versionCode: 5 }, 1, 'http://h'), null, 'sem nome de arquivo não há o que baixar');
  assert.equal(avaliarAtualizacao(INFO, null, 'http://h'), null, 'sem saber a versão local não dá para comparar');
});

test('o manifesto fica ao lado do APK, por cliente', () => {
  assert.equal(urlDoBuildInfo('http://host/apk/', 'grupoflash'), 'http://host/apk/drac-grupoflash-build-info.json');
});

test('a base do APK sai da URL da API sem inventar host', () => {
  // O nginx serve os artefatos em /apk na RAIZ; a API vive em /api.
  assert.equal(baseDoApk('https://ajustcam.exemplo.com.br/api'), 'https://ajustcam.exemplo.com.br/apk');
  assert.equal(baseDoApk('http://10.0.0.5:3000'), 'http://10.0.0.5:3000/apk');
  assert.equal(baseDoApk('https://host/base/api/'), 'https://host/base/apk');
  assert.equal(baseDoApk('não é url'), null);
  assert.equal(baseDoApk(null), null);
});
