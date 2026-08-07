import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const read = (path: string) => readFileSync(path, 'utf8');

test('marca visível usa AjustCam e não exibe versão fictícia', () => {
  assert.match(read('index.html'), /<title>AjustCam<\/title>/);
  assert.doesNotMatch(read('src/pages/LoginPage.tsx'), /v2\.4\s*·\s*Local/);
  assert.match(read('src/lib/product-brand.ts'), /PRODUCT_NAME = 'AjustCam'/);
});

test('nenhuma tela oferecida ao operador finge ter conteúdo que não tem', () => {
  // Este teste começou como uma lista de páginas a esconder do menu, porque
  // eram casca. Todas foram corrigidas (2026-08-07):
  //   /wall          — a rota passou a ligar o modo mural REAL do /live, em vez
  //                    de desenhar 16 retângulos pretos sem player nenhum;
  //   /events        — "Reconhecer" passou a chamar POST /cameras/incidents/:id/ack
  //                    (antes só marcava num Set local e sumia ao recarregar);
  //   /investigation — os "players" (grade de fundo, relógio parado, barra fixa
  //                    em 72%) e a régua de blocos codificados viraram links
  //                    para a Reprodução no instante em análise e uma régua
  //                    desenhada com os eventos reais.
  //
  // Agora todas estão no menu, e o que o teste protege é a REGRA que as trouxe
  // até aqui: tela oferecida ao operador não simula conteúdo. Numa interface de
  // VMS, um quadro que parece vídeo ou uma régua que parece cobertura levam
  // alguém a concluir que reviu uma cena que nunca foi exibida.
  const simulacoes: Array<[string, RegExp, string]> = [
    ['src/pages/InvestigationPage.tsx', /width:\s*'72%'/, 'barra de progresso fixa'],
    ['src/pages/InvestigationPage.tsx', /left-\[\d+%\]\s+right-\[\d+%\]/, 'bloco de régua em posição codificada'],
    ['src/pages/EventsPage.tsx', /Visualização da câmera|Preview da câmera/, 'player simulado'],
    ['src/pages/WallModePage.tsx', /aspect-video|statusDot/, 'maquete de mural'],
  ];
  // Comentários citam os padrões antigos para explicar a correção — o que
  // importa é que não estejam mais no CÓDIGO.
  const semComentarios = (texto: string) => texto
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n');
  for (const [arquivo, padrao, oque] of simulacoes) {
    assert.doesNotMatch(semComentarios(read(arquivo)), padrao, `${arquivo}: ${oque}`);
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
  // Texto mudou junto com o modelo: a capacidade passou a ser SONDADA, e o
  // estado vazio agora distingue "sondada e não tem" de "ainda não deu para
  // perguntar" (câmera offline). A regra guardada é a mesma — a tela orienta
  // em vez de só dizer que está vazia.
  assert.match(ptz, /Nenhuma câmera com PTZ detectado/);
  assert.match(ptz, /ainda não puderam ser verificadas/);
  assert.match(ptz, /Câmera compatível/);
});

test('as quatro páginas removidas não voltam por engano', () => {
  // Removidas a pedido do dono (2026-08-07), com motivo cada uma:
  //   /map          — a planta nunca foi alimentada com posições reais;
  //   /evidence     — o download do vídeo já existe na Reprodução;
  //   /reports      — não havia módulo de relatórios, só exportação de CSV;
  //   /app-builder  — gerar APK é exclusividade da DRAC Central, não da
  //                   instalação (cada instalação gerando o próprio APK
  //                   quebra a assinatura única por cliente).
  //
  // Este teste existe porque as três primeiras já tinham sido "reintroduzidas"
  // uma vez: estavam sem rota, foram achadas numa auditoria e voltaram ao menu.
  // Sem guarda, o mesmo caminho se repete na próxima varredura de código morto.
  const rotasRemovidas = ['/map', '/evidence', '/reports', '/app-builder'];
  const arquivos = ['src/App.tsx', 'src/components/Sidebar.tsx', 'src/layouts/AppLayout.tsx'];
  for (const arquivo of arquivos) {
    const fonte = read(arquivo)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n').filter((linha) => !linha.trim().startsWith('//')).join('\n');
    for (const rota of rotasRemovidas) {
      assert.doesNotMatch(fonte, new RegExp(`['"\`]${rota}['"\`]`), `${arquivo} voltou a referenciar ${rota}`);
    }
  }
  for (const pagina of ['MapPage', 'EvidencePage', 'ReportsPage', 'AppBuilderPage']) {
    assert.throws(() => read(`src/pages/${pagina}.tsx`), `src/pages/${pagina}.tsx foi recriada`);
  }
});
