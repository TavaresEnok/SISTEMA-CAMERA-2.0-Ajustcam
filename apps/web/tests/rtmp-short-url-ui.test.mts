import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const addDialogPath = fileURLToPath(new URL('../src/components/AddPushCameraDialog.tsx', import.meta.url));
const editSheetPath = fileURLToPath(new URL('../src/components/CameraEditSheet.tsx', import.meta.url));

test('cadastro RTMP recomenda URL compacta e nunca orienta recortar a chave', async () => {
  const source = await readFile(addDialogPath, 'utf8');

  assert.match(source, /fullUrlFitsSingleField/);
  assert.match(source, /usaEnderecoCompacto/);
  assert.match(source, /Compatível com campos curtos/);
  assert.match(source, /Nunca a recorte/);
  assert.match(source, /Servidor RTMP/);
  assert.match(source, /Chave do stream/);
});

test('edição RTMP bloqueia a falsa recomendação quando a URL excede o equipamento', async () => {
  const source = await readFile(editSheetPath, 'utf8');

  assert.match(source, /fullUrlFitsSingleField/);
  assert.match(source, /Endereço compacto selecionado/);
  assert.match(source, /URL maior que o campo da câmera/);
  assert.match(source, /Não recorte a chave/);
  assert.match(source, /Servidor e chave separados/);
});
