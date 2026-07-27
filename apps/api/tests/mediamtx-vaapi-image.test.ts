import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// ── A imagem que traz o que faltava (achado da análise do Frigate) ───────────
// bluenviron/mediamtx:1-ffmpeg tem h264_vaapi/h264_qsv COMPILADOS e nenhum
// driver VA instalado: o encoder aparece na lista e morre ao abrir o
// dispositivo. Esta imagem instala os drivers. Ela fica PRONTA e DESLIGADA.

const DOCKERFILE = '../../infra/mediamtx-vaapi.Dockerfile';
const COMPOSE_BASE = '../../infra/docker-compose.yml';

test('a imagem VAAPI parte da MESMA imagem (e digest) de produção', () => {
  const df = readFileSync(DOCKERFILE, 'utf8');
  const compose = readFileSync(COMPOSE_BASE, 'utf8');
  const digestProd = compose.match(/bluenviron\/mediamtx:1-ffmpeg@(sha256:[a-f0-9]{64})/)?.[1];
  assert.ok(digestProd, 'esperava a imagem do mediamtx fixada por digest no compose base');
  assert.ok(
    df.includes(digestProd),
    'a imagem VAAPI precisa derivar do MESMO digest de produção — senão troca o MediaMTX junto com o driver',
  );
});

test('instala driver VA E o vainfo (sem vainfo não há como VALIDAR o render node)', () => {
  const df = readFileSync(DOCKERFILE, 'utf8');
  assert.match(df, /\blibva\b/, 'runtime VA-API');
  assert.match(df, /libva-utils/, 'vainfo — é ele que separa "compilado" de "funciona"');
  assert.match(df, /intel-media-driver/, 'driver iHD (Intel Gen8+)');
  assert.match(df, /libva-intel-driver/, 'driver i965 (Intel antigo)');
  assert.match(df, /mesa-va-gallium/, 'driver radeonsi (AMD)');
});

test('QSV é best-effort e NÃO pode quebrar o build da imagem', () => {
  const df = readFileSync(DOCKERFILE, 'utf8');
  // A linha que INSTALA, não qualquer linha que cite o pacote: o cabeçalho de
  // documentação também menciona `libvpl`, e casar com ele fazia o teste falhar
  // com o Dockerfile correto (falso negativo).
  const linha = df
    .split('\n')
    .find((l) => l.includes('libvpl') && /^\s*RUN\b/.test(l));
  assert.ok(linha, 'esperava a tentativa de instalar o runtime oneVPL');
  assert.match(linha!, /\|\|/, 'a ausência do pacote não pode derrubar o build');
});

test('a imagem NÃO está ligada em nenhum compose (ligar é passo consciente)', () => {
  for (const arquivo of [
    '../../infra/docker-compose.yml',
    '../../infra/docker-compose.dev.yml',
    '../../infra/docker-compose.prod.yml',
    '../../infra/docker-compose.gpu.yml',
  ]) {
    const conteudo = readFileSync(arquivo, 'utf8');
    assert.ok(
      !conteudo.includes('mediamtx-vaapi'),
      `${arquivo} não pode referenciar a imagem VAAPI — produção está gravando agora`,
    );
  }
});

test('a atribuição MIT ao Frigate está preservada onde o conteúdo foi portado', () => {
  const df = readFileSync(DOCKERFILE, 'utf8');
  assert.match(df, /Frigate.*MIT.*Copyright \(c\) Frigate, Inc\./);
  assert.match(df, /install_deps\.sh:74-160/, 'aponte a origem exata do que foi portado');

  const helper = readFileSync('src/camera-stream/helpers/hwaccel-presets.helper.ts', 'utf8');
  assert.match(helper, /Derivado de Frigate \(MIT\) — Copyright \(c\) Frigate, Inc\./);
  assert.match(helper, /ffmpeg_presets\.py/);
});
