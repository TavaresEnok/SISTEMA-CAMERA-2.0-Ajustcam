import test from 'node:test';
import assert from 'node:assert/strict';
import { avaliarConfirmacao, lerTrechoExato } from '../src/cloud-storage/helpers/upload-verification.helper';
import { CloudOffloadService } from '../src/cloud-storage/cloud-offload.service';
import { CloudStorageResolverService } from '../src/cloud-storage/cloud-storage-resolver.service';

// ── "SUBIU" SÓ VALE DEPOIS DE CONFERIDO DE VERDADE ──────────────────────────
//
// A confirmação do upload autoriza apagar a cópia local. Estes testes travam
// os furos que tornavam a autorização mentirosa: HEAD que só via existência
// (objeto truncado passava), leitura de parte que ignorava bytesRead (nós
// mesmos fabricávamos o truncado), e 403 no HEAD virando reenvio infinito.

test('objeto existente com o tamanho CERTO autoriza marcar', () => {
  const v = avaliarConfirmacao({ exists: true, contentLength: 1000, verificavel: true }, 1000);
  assert.equal(v.ok, true);
});

test('tamanho DIVERGENTE não autoriza — é prova corrompida esperando a poda', () => {
  const v = avaliarConfirmacao({ exists: true, contentLength: 999, verificavel: true }, 1000);
  assert.equal(v.ok, false);
  assert.equal((v as any).motivo, 'tamanho_divergente');
});

test('bucket sem content-length no HEAD: existência basta (não trava fornecedor exótico)', () => {
  const v = avaliarConfirmacao({ exists: true, contentLength: null, verificavel: true }, 1000);
  assert.equal(v.ok, true, 'sem o número não há como comparar — exigir aqui pararia o offload inteiro');
});

test('objeto ausente não autoriza', () => {
  const v = avaliarConfirmacao({ exists: false, contentLength: null, verificavel: true }, 1000);
  assert.equal(v.ok, false);
  assert.equal((v as any).motivo, 'objeto_ausente');
});

test('403 no HEAD é INVERIFICÁVEL, não "ausente"', () => {
  // Tratar como ausente mandava reenviar o MESMO arquivo a cada ciclo, para
  // sempre — upload pago em loop e fila que nunca drena.
  const v = avaliarConfirmacao({ exists: false, contentLength: null, verificavel: false }, 1000);
  assert.equal(v.ok, false);
  assert.equal((v as any).motivo, 'inverificavel');
});

// ── lerTrechoExato: a parte sobe COMPLETA ou não sobe ───────────────────────

function handleDeMentira(pedacos: number[]) {
  // Devolve os bytes em pedaços do tamanho pedido pela lista — simula o
  // fs.read legítimo que entrega menos que o pedido.
  let chamada = 0;
  return {
    read: async (buf: Buffer, bufOffset: number, length: number, position: number) => {
      const dar = Math.min(pedacos[Math.min(chamada, pedacos.length - 1)], length);
      chamada += 1;
      for (let i = 0; i < dar; i += 1) buf[bufOffset + i] = (position + i) % 256;
      return { bytesRead: dar, buffer: buf };
    },
  };
}

test('leitura curta é completada em novas chamadas — nunca cauda de zeros', async () => {
  const buf = await lerTrechoExato(handleDeMentira([4, 4, 8]) as any, 0, 16);
  assert.equal(buf.length, 16);
  // Cada byte tem o valor da posição: se a cauda fosse zeros, os últimos 12
  // bytes falhariam aqui.
  for (let i = 0; i < 16; i += 1) assert.equal(buf[i], i % 256, `byte ${i} veio errado — parte truncada fabricada`);
});

test('arquivo que ENCOLHE no meio do envio lança, não sobe truncado', async () => {
  await assert.rejects(
    () => lerTrechoExato(handleDeMentira([4, 0]) as any, 0, 16),
    /leitura curta/,
    'subir uma parte pela metade é pior que falhar o envio',
  );
});

// ── saudeDoEnvio: o número que faltou no dia do NoSuchBucket ────────────────

function montarOffload(opcoes: { enabled?: boolean; pendentes?: number; maisAntigaHaMin?: number } = {}) {
  const svc: any = Object.create(CloudOffloadService.prototype);
  svc.logger = { warn: () => {}, log: () => {}, error: () => {} };
  svc.getPolicy = async () => ({
    enabled: opcoes.enabled ?? true,
    triggerModes: { continuous: true, motion: true, manual: true },
  });
  svc.prisma = {
    recording: {
      count: async () => opcoes.pendentes ?? 0,
      findFirst: async () => (opcoes.maisAntigaHaMin != null
        ? { startedAt: new Date(Date.now() - opcoes.maisAntigaHaMin * 60_000) }
        : null),
    },
  };
  return svc;
}

test('com fila atrasada, a saúde reporta pendentes e a idade do mais antigo', async () => {
  const svc = montarOffload({ pendentes: 1200, maisAntigaHaMin: 90 });
  svc.ultimaFalhaEm = new Date(Date.now() - 30_000);
  svc.ultimaFalhaCodigo = 'NoSuchBucket';
  const saude = await svc.saudeDoEnvio();

  assert.equal(saude.configurado, true);
  assert.equal(saude.pendentes, 1200);
  assert.ok(saude.maisAntigaPendenteSegundos >= 89 * 60, 'a idade do atraso é o que dimensiona o problema');
  assert.equal(saude.ultimaFalhaCodigo, 'NoSuchBucket', 'o código do erro é o que aponta a causa na Central');
});

test('nuvem desligada: configurado=false e nada de alarme', async () => {
  const saude = await montarOffload({ enabled: false }).saudeDoEnvio();
  assert.equal(saude.configurado, false);
  assert.equal(saude.pendentes, 0);
});

test('banco fora: saúde vira null, nunca erro — o heartbeat não pode cair por diagnóstico', async () => {
  const svc = montarOffload();
  svc.prisma.recording.count = async () => { throw new Error('banco fora'); };
  assert.equal(await svc.saudeDoEnvio(), null);
});

// ── Reconciliação falha ⇒ envio ADIADO, nunca âncora errada ─────────────────

test('reconciliar falhou: storageParaEscrita devolve null (adia o ciclo)', async () => {
  // Seguir com id nulo gravava cloudStorageId=null = "segue o bucket ativo
  // para sempre": na próxima troca de fornecedor o acervo sumiria da tela.
  const erros: string[] = [];
  const svc: any = Object.create(CloudStorageResolverService.prototype);
  svc.logger = { warn: () => {}, log: () => {}, error: (m: string) => erros.push(m) };
  svc.legado = async () => ({ endpoint: 'https://s3', bucket: 'b', prefix: '', accessKeyId: 'k', secretAccessKey: 's' });
  svc.reconciliar = async () => { throw new Error('banco indisponível'); };

  assert.equal(await svc.storageParaEscrita(), null);
  assert.ok(erros.some((m) => m.includes('ADIADO')), 'adiar sem dizer por quê esconderia o envio parado');
});
