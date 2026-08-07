import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('marca visível usa AjustCam e não exibe versão fictícia', () => {
  assert.match(read('index.html'), /<title>AjustCam<\/title>/);
  assert.doesNotMatch(read('src/pages/LoginPage.tsx'), /v2\.4\s*·\s*Local/);
  assert.match(read('src/lib/product-brand.ts'), /PRODUCT_NAME = 'AjustCam'/);
});

test('páginas incompletas não aparecem na navegação nem na paleta de comandos', () => {
  // O MAPA SAIU DA LISTA (2026-08-07): responsividade, acesso por teclado,
  // alvo de toque e rótulos em português foram corrigidos — ele mostra dados
  // reais e agora está no menu.
  //
  // Os que permanecem continuam sendo CASCA, e é isso que este teste protege:
  //   /wall          — não renderiza vídeo nenhum (retângulos pretos);
  //   /investigation — player e régua são maquete com valores fixos;
  //   /events        — "Reconhecer" não chama API (some ao recarregar);
  //   /reports       — a exportação PDF/CSV não existe.
  // Todos estão roteados e alcançáveis por URL; o que não se faz é oferecê-los
  // ao operador como se estivessem prontos.
  const palette = read('src/components/CommandPalette.tsx');
  const sidebar = read('src/components/Sidebar.tsx');
  for (const path of ['/wall', '/investigation', '/events', '/reports']) {
    assert.doesNotMatch(palette, new RegExp(`path:\\s*['\"]${path}['\"]`), path);
    assert.doesNotMatch(sidebar, new RegExp(`path:\\s*['\"]${path}['\"]`), path);
  }
});

test('interfaces de câmera não oferecem agenda sem executor', () => {
  assert.doesNotMatch(read('src/components/CameraEditSheet.tsx'), /label:\s*'Agendada'/);
  assert.doesNotMatch(read('src/pages/CamerasPage.tsx'), /<SelectItem value="schedule"/);
  assert.match(read('src/pages/CameraDetailPage.tsx'), /Agenda \(indisponível\)/);
});

test('PTZ limita a seleção a câmeras ativas e orienta quando não há compatível', () => {
  const ptz = read('src/pages/PTZPage.tsx');
  assert.match(ptz, /camera\.enabled && camera\.ptzCapable/);
  assert.match(ptz, /Nenhuma câmera compatível com PTZ/);
  assert.match(ptz, /Câmera compatível/);
});
