'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── A PORTA DA FONTE DE ARTEFATOS TEM DE BATER COM A DO NGINX DO WEB ────────
//
// Sintoma que isto evita: clicar em baixar o APK/AAB na Central e receber
//
//     { "error": "artifact_source_unavailable",
//       "message": "Servidor de arquivos temporariamente indisponível." }
//
// A mensagem sugere falha passageira. Não era: `APK_SOURCE_BASE=http://web`
// aponta para a porta 80, e o nginx do container web escuta em 8080 (roda como
// usuário sem privilégio). Dava ECONNREFUSED em toda tentativa.
//
// As duas coisas foram escritas no MESMO commit (79f68ba, 28/07) e já nasceram
// divergentes — o download esteve quebrado 8 dias sem ninguém notar, porque a
// mensagem convidava a "tentar de novo em instantes".
//
// Um teste de integração não pegaria isto sem subir os dois containers. Este
// confere a única coisa que importa: os dois arquivos concordam sobre a porta.

const RAIZ = path.join(__dirname, '..', '..', '..');
const NGINX_WEB = fs.readFileSync(path.join(RAIZ, 'apps', 'web', 'nginx.conf'), 'utf8');
const COMPOSE = fs.readFileSync(path.join(RAIZ, 'infra', 'docker-compose.yml'), 'utf8');

/** A porta em que o nginx do container `web` realmente escuta. */
function portaDoNginxWeb() {
  const m = /^\s*listen\s+(\d+)\s*;/m.exec(NGINX_WEB);
  assert.ok(m, 'não achei a diretiva listen em apps/web/nginx.conf');
  return m[1];
}

/** O destino que a Central usa para buscar APK/AAB/kit. */
function fonteDeArtefatos() {
  const m = /APK_SOURCE_BASE=(\S+)/.exec(COMPOSE);
  assert.ok(m, 'APK_SOURCE_BASE sumiu do docker-compose');
  return m[1];
}

test('APK_SOURCE_BASE aponta para a porta em que o web ESCUTA', () => {
  const porta = portaDoNginxWeb();
  const base = fonteDeArtefatos();
  const m = /^http:\/\/[^/:]+(?::(\d+))?$/.exec(base);
  assert.ok(m, `APK_SOURCE_BASE em formato inesperado: ${base}`);
  const portaUsada = m[1] || '80';
  assert.equal(
    portaUsada,
    porta,
    `a Central busca artefatos na porta ${portaUsada}, mas o nginx do web escuta na ${porta} — `
      + 'toda tentativa de baixar APK/AAB vai dar ECONNREFUSED e virar '
      + '"Servidor de arquivos temporariamente indisponível"',
  );
});

test('a porta é DECLARADA na URL, não deixada implícita', () => {
  // Depender do 80 implícito é o que criou o problema: mudar o nginx de porta
  // (por hardening, por exemplo) quebra o download em silêncio.
  const base = fonteDeArtefatos();
  assert.match(base, /:\d+$/, 'escreva a porta na URL para a divergência ficar visível na leitura');
});
