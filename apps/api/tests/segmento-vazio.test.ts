import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RecordingProcessManagerService } from '../src/recordings/recording-process-manager.service';

// ─────────────────────────────────────────────────────────────────────────────
// SEGMENTO .ts DE 0 BYTE
//
// O ffmpeg cria o arquivo antes de escrever o primeiro byte. Se ele morre nessa
// fresta — reinício da API, câmera que cai ao iniciar — sobra um .ts vazio.
// MEDIDO: 4 de uma vez, mesmo minuto, 4 câmeras diferentes, num reinício.
//
// Antes, cada um gastava um ffprobe e um ffmpeg para descobrir o óbvio,
// imprimia "Invalid data found when processing input" no log como se fosse
// defeito de gravação, e queimava tentativas até a quarentena.
//
// Não existe remux que salve 0 byte. O arquivo sai na hora, com log calmo.
// ─────────────────────────────────────────────────────────────────────────────

function makeManager(over: Record<string, unknown> = {}) {
  const svc: any = Object.create(RecordingProcessManagerService.prototype);
  const registros: string[] = [];
  svc.logger = { log: (m: string) => registros.push(m), warn() {}, error() {} };
  svc.registros = registros;
  svc.probeLocalVideoCodec = async () => {
    throw new Error('ffprobe não pode ser chamado para um arquivo vazio');
  };
  svc.registerSegment = async () => {
    throw new Error('não pode registrar gravação de arquivo vazio');
  };
  Object.assign(svc, over);
  return svc;
}

test('segmento de 0 byte é apagado sem chamar ffmpeg nem registrar gravação', async (t) => {
  const raiz = await mkdtemp(join(tmpdir(), 'drac-seg-'));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  const vazio = join(raiz, 'vazio.ts');
  await writeFile(vazio, Buffer.alloc(0));

  const svc = makeManager();
  const r = await svc.remuxAndRegisterTsSegment('cam-1', vazio, 30);

  assert.equal(r, null, 'devolve null: não houve MP4 nenhum');
  await assert.rejects(() => stat(vazio), 'o arquivo vazio tem de sair do disco');
  assert.ok(
    svc.registros.some((m: string) => m.includes('Segmento vazio')),
    'o log tem de dizer o que aconteceu, em tom de rotina e não de erro',
  );
});

test('segmento COM conteúdo não é descartado pela guarda', async (t) => {
  const raiz = await mkdtemp(join(tmpdir(), 'drac-seg-'));
  t.after(() => rm(raiz, { recursive: true, force: true }));
  const cheio = join(raiz, 'cheio.ts');
  await writeFile(cheio, Buffer.alloc(4096, 7));

  // A guarda não pode virar um filtro que engole segmento bom: aqui ela precisa
  // deixar o fluxo seguir, e o fluxo chama o ffprobe — que este teste faz
  // explodir de propósito para provar que chegou lá.
  const svc = makeManager();
  await assert.rejects(
    () => svc.remuxAndRegisterTsSegment('cam-1', cheio, 30),
    /ffprobe não pode ser chamado/,
    'arquivo com bytes segue para o remux normal',
  );
  const info = await stat(cheio);
  assert.equal(info.size, 4096, 'e continua no disco, intacto');
});
