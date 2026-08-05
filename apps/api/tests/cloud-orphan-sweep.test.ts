import test from 'node:test';
import assert from 'node:assert/strict';
import { RetentionService } from '../src/recordings/retention.service';
import { CameraHealthCheckProcessor } from '../src/jobs/processors/camera-health-check.processor';

// ── A VARREDURA DE ÓRFÃOS NÃO PODE DESTRUIR ACERVO QUE NÃO RECONHECE ────────
//
// A varredura recolhe do bucket objetos sem dono no banco. Estava duplamente
// quebrada: usava `listObjects` (chave COM prefixo, sem paginação) e comparava
// contra `Recording.cloudKey` (gravado SEM prefixo) — nada casava, TODO objeto
// parecia órfão, e os deletes iam para `prefixo/prefixo/...` (inexistente).
// Ou seja: mentia no log e não limpava nada; corrigida a chave SEM a trava de
// segurança, apagaria o acervo vivo inteiro. E o mesmo laço, num bucket
// compartilhado por duas instalações sem prefixo, apagaria o acervo probatório
// da OUTRA instalação.
//
// Regras travadas aqui: chave relativa paginada; página inteira sem NENHUM
// dono num storage que o banco diz ter gravações = ABORTA e grita, não apaga.

type Pagina = { objects: Array<{ key: string }>; nextToken: string | null };

function montarSweep(opcoes: {
  paginas: Pagina[];
  donos: string[];
  donosNoBanco?: number;
}) {
  const deletadas: string[] = [];
  const erros: string[] = [];
  let paginaIndex = 0;

  const svc: any = Object.create(RetentionService.prototype);
  svc.logger = { log: () => {}, warn: () => {}, error: (m: string) => erros.push(m) };
  svc.storageResolver = {
    todosOsStorages: async () => [{ id: 'st-1', name: 'Bucket Teste' }],
    clienteDe: () => ({
      listObjectsPage: async (_prefix: string, _token: string | null) => {
        const pagina = opcoes.paginas[Math.min(paginaIndex, opcoes.paginas.length - 1)];
        paginaIndex += 1;
        return pagina;
      },
      deleteObject: async (key: string) => { deletadas.push(key); },
    }),
  };
  svc.prisma = {
    recording: {
      findMany: async ({ where }: any) => {
        const pedidas: string[] = where.cloudKey.in;
        return opcoes.donos.filter((d) => pedidas.includes(d)).map((cloudKey) => ({ cloudKey }));
      },
      count: async () => opcoes.donosNoBanco ?? opcoes.donos.length,
    },
  };
  return { svc, deletadas, erros };
}

test('apaga só o órfão, com a chave RELATIVA — o dono fica', async () => {
  const { svc, deletadas } = montarSweep({
    paginas: [{
      objects: [{ key: 'recordings/cam-1/viva.mp4' }, { key: 'recordings/cam-1/orfa.mp4' }],
      nextToken: null,
    }],
    donos: ['recordings/cam-1/viva.mp4'],
  });
  const removidos = await svc.cleanupOrphanCloudObjects();

  assert.deepEqual(deletadas, ['recordings/cam-1/orfa.mp4'], 'a chave deletada tem de ser a MESMA listada (relativa), sem prefixo duplo');
  assert.equal(removidos, 1);
});

test('página inteira sem NENHUM dono, banco com gravações: ABORTA e grita, não apaga', async () => {
  // O modo de falha que a trava impede: descompasso de chave/prefixo ou bucket
  // compartilhado com outra instalação. "Não reconheço nada" nunca vira
  // "apaga tudo" num sistema probatório.
  const { svc, deletadas, erros } = montarSweep({
    paginas: [{
      objects: [{ key: 'recordings/da-outra-instalacao/a.mp4' }, { key: 'recordings/da-outra-instalacao/b.mp4' }],
      nextToken: 'tem-mais',
    }],
    donos: [],
    donosNoBanco: 5000,
  });
  const removidos = await svc.cleanupOrphanCloudObjects();

  assert.deepEqual(deletadas, [], 'apagar aqui destruiria o acervo da outra instalação');
  assert.equal(removidos, 0);
  const erro = erros.find((m) => m.includes('ABORTADA'));
  assert.ok(erro, 'o aborto tem de sair como ERROR com a causa');
  assert.match(erro!, /descompasso|compartilhado/);
});

test('storage sem NENHUMA gravação no banco pode ser limpo por inteiro', async () => {
  // Um bucket de storage descomissionado, já esvaziado no banco, é todo lixo
  // legítimo — a trava não pode congelar a limpeza dele.
  const { svc, deletadas } = montarSweep({
    paginas: [{ objects: [{ key: 'recordings/cam-1/sobra.mp4' }], nextToken: null }],
    donos: [],
    donosNoBanco: 0,
  });
  await svc.cleanupOrphanCloudObjects();
  assert.deepEqual(deletadas, ['recordings/cam-1/sobra.mp4']);
});

test('a varredura PAGINA até o fim — não enxerga só a primeira página para sempre', async () => {
  const { svc, deletadas } = montarSweep({
    paginas: [
      { objects: [{ key: 'a/orfa-1.mp4' }, { key: 'a/viva.mp4' }], nextToken: 'p2' },
      { objects: [{ key: 'b/orfa-2.mp4' }], nextToken: null },
    ],
    donos: ['a/viva.mp4'],
  });
  await svc.cleanupOrphanCloudObjects();
  assert.deepEqual(deletadas, ['a/orfa-1.mp4', 'b/orfa-2.mp4'], 'sem paginação, orfa-2 nunca seria alcançada');
});

// ── O HEALTH-CHECK NÃO PODE DESARMAR A GRAVAÇÃO PARA SEMPRE ─────────────────
//
// `stop()` grava `recordingEnabled: false`. Se o `start()` seguinte falhar
// (disco cheio: `assertMinimumStorageFree` lança), a câmera saía do filtro
// `where: { recordingEnabled: true }` do health-check e NUNCA mais era
// reavaliada — noite inteira sem imagem, mesmo com o espaço liberado uma hora
// depois. A auto-cura reabria o defeito que o gerenciador tinha corrigido.

function montarHealthCheck(opcoes: { startFalha: boolean }) {
  const eventos: string[] = [];
  const updates: any[] = [];
  const proc: any = Object.create(CameraHealthCheckProcessor.prototype);
  proc.logger = { warn: () => {}, log: () => {}, error: () => {} };
  proc.recordingManager = {
    stop: async () => { eventos.push('stop'); },
    start: async () => {
      eventos.push('start');
      if (opcoes.startFalha) throw new Error('Espaço em disco insuficiente');
    },
  };
  proc.prisma = {
    camera: {
      update: async (args: any) => { updates.push(args); },
    },
  };
  return { proc, eventos, updates };
}

test('start falhou depois do stop: a câmera VOLTA a ficar armada', async () => {
  const { proc, updates } = montarHealthCheck({ startFalha: true });
  await assert.rejects(
    () => proc.reiniciarGravacaoPreservandoArmada('cam-1', 300),
    /disco/i,
    'o erro continua subindo — o chamador registra o evento de falha',
  );
  assert.equal(updates.length, 1, 'sem restaurar, a câmera some do filtro do health-check para sempre');
  assert.equal(updates[0].data.recordingEnabled, true);
  assert.equal(updates[0].where.id, 'cam-1');
});

test('reinício bem-sucedido não mexe no estado desejado', async () => {
  const { proc, eventos, updates } = montarHealthCheck({ startFalha: false });
  await proc.reiniciarGravacaoPreservandoArmada('cam-1', 300);
  assert.deepEqual(eventos, ['stop', 'start']);
  assert.deepEqual(updates, [], 'no caminho feliz, stop+start já deixam o estado certo');
});
