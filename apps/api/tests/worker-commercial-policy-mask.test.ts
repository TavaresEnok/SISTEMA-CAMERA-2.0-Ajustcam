import test from 'node:test';
import assert from 'node:assert/strict';
import { CamerasController } from '../src/cameras/cameras.controller';

// ─────────────────────────────────────────────────────────────────────────────
// BLOQUEIO COMERCIAL PRECISA ALCANÇAR O WORKER LEGADO.
//
// O worker tem dois motores de gravação: comandos via Redis e um laço próprio de
// 60s que grava toda câmera com `recordingEnabled=true` lendo
// `/cameras/internal/*`. O caminho de comando já era barrado
// (`start()` chama `assertFeature('localRecording')` antes de publicar), mas o
// laço autônomo não passava por nada que soubesse da política — instalação
// inadimplente seguia gravando.
//
// Por que a máscara e não um "stop" publicado: o laço RELÊ este endpoint e
// reiniciaria a gravação no ciclo seguinte, desfazendo o comando em até 60s.
// Só mudar o que o worker LÊ é durável.
//
// Por que na resposta e não no banco: zerar `recordingEnabled` no Postgres
// destruiria a intenção do operador — ao voltar o pagamento, ninguém saberia
// quais câmeras deviam gravar. Como overlay, a restrição some sozinha.
// ─────────────────────────────────────────────────────────────────────────────

const CAMERAS = [
  { id: 'cam-1', name: 'Portaria', recordingEnabled: true, enabled: true },
  { id: 'cam-2', name: 'Estoque', recordingEnabled: false, enabled: true },
];

function makeController(localRecordingAllowed: boolean) {
  const camerasService = {
    findAllInternal: async () => CAMERAS.map((c) => ({ ...c })),
    findOneInternal: async (id: string) => {
      const found = CAMERAS.find((c) => c.id === id);
      return found ? { ...found } : null;
    },
  };
  const commercialPolicy = {
    isAllowed: async (feature: string) => {
      assert.equal(feature, 'localRecording', 'a máscara consulta a feature de gravação local');
      return localRecordingAllowed;
    },
  };
  return new CamerasController(
    camerasService as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    commercialPolicy as never,
  );
}

test('sem restrição: a lista passa intacta', async () => {
  const lista = await makeController(true).internalList();
  assert.equal(lista.find((c) => c.id === 'cam-1')?.recordingEnabled, true);
  assert.equal(lista.find((c) => c.id === 'cam-2')?.recordingEnabled, false);
});

test('com restrição comercial: recordingEnabled é mascarado para false', async () => {
  const lista = await makeController(false).internalList();
  assert.ok(
    lista.every((c) => c.recordingEnabled === false),
    'o laço do worker precisa enxergar TODAS como não-graváveis',
  );
});

test('a máscara NÃO altera o dado de origem (intenção do operador preservada)', async () => {
  await makeController(false).internalList();
  assert.equal(
    CAMERAS.find((c) => c.id === 'cam-1')?.recordingEnabled,
    true,
    'quando o cliente voltar a pagar, a configuração original tem que estar lá',
  );
});

test('camera única: mesma máscara do endpoint de lista', async () => {
  const semRestricao = await makeController(true).internalOne('cam-1');
  assert.equal(semRestricao.recordingEnabled, true);

  const comRestricao = await makeController(false).internalOne('cam-1');
  assert.equal(
    comRestricao.recordingEnabled,
    false,
    'os dois caminhos que o worker usa precisam concordar — senão o laço para e o comando religa',
  );
});

test('camera única inexistente vira 404, não null silencioso', async () => {
  await assert.rejects(
    () => makeController(true).internalOne('nao-existe'),
    /não encontrada/i,
  );
});

test('outros campos não são tocados pela máscara', async () => {
  const lista = await makeController(false).internalList();
  const cam = lista.find((c) => c.id === 'cam-1');
  assert.equal(cam?.name, 'Portaria');
  assert.equal(cam?.enabled, true, 'a máscara é só de gravação — não desativa a câmera');
});
