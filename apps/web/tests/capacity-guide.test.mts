import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

type CapacityInput = {
  cameras: number;
  bitrateMbps: number;
  retentionDays: number;
  recordingFactor?: number;
  s3Enabled?: boolean;
  localDays?: number;
};

type CapacityResult = {
  cpu: number;
  ram: number;
  nic: string;
  ingressMbps: number;
  plannedNetworkMbps: number;
  dailyTB: number;
  fullStorageTB: number;
  localStorageTB: number;
  s3OutputMbps: number;
  projected: boolean;
};

type CapacityApi = {
  calculateCapacity(input: CapacityInput): CapacityResult;
};

const publicDirectory = resolve(import.meta.dirname, '../public');
const script = readFileSync(resolve(publicDirectory, 'capacidade/app.js'), 'utf8');
const sandbox: { AJUSTCAM_CAPACITY?: CapacityApi } = {};
vm.runInNewContext(script, sandbox);
const capacity = sandbox.AJUSTCAM_CAPACITY;
assert.ok(capacity, 'app.js precisa expor os cálculos sem depender do DOM');

test('página comercial de capacidade está completa e ligada ao guia de armazenamento', () => {
  const page = readFileSync(resolve(publicDirectory, 'capacidade/index.html'), 'utf8');
  const styles = readFileSync(resolve(publicDirectory, 'capacidade/styles.css'), 'utf8');
  const storageGuide = readFileSync(resolve(publicDirectory, 'armazenamento/index.html'), 'utf8');
  const helpIndex = readFileSync(resolve(publicDirectory, 'ajuda/index.html'), 'utf8');
  const helpContent = readFileSync(resolve(publicDirectory, 'ajuda/content.js'), 'utf8');

  assert.match(page, /CPU, memória, armazenamento e banda de rede/i);
  assert.match(page, /id="capacity-form"/);
  assert.match(page, /data-cameras="50"/);
  assert.match(page, /data-cameras="1000"/);
  assert.match(page, /<option value="3" selected>3 dias<\/option>/);
  assert.match(page, /href="\/armazenamento\/"/);
  assert.match(storageGuide, /href="\/capacidade\/"/);
  assert.match(helpIndex, /href="\/capacidade\/"/);
  assert.match(helpContent, /href="\/capacidade\/"/);
  assert.match(styles, /@media print/);
  assert.match(styles, /@media \(max-width: 680px\)/);
});

test('cenário padrão de 100 câmeras preserva a base matemática apresentada', () => {
  const result = capacity.calculateCapacity({ cameras: 100, bitrateMbps: 2.1, retentionDays: 30 });

  assert.equal(result.cpu, 4);
  assert.equal(result.ram, 16);
  assert.equal(result.nic, '1 GbE');
  assert.equal(result.ingressMbps, 210);
  assert.equal(result.plannedNetworkMbps, 273);
  assert.ok(Math.abs(result.dailyTB - 2.268) < 0.000001);
  assert.ok(Math.abs(result.fullStorageTB - 85.05) < 0.000001);
  assert.equal(result.projected, false);
});

test('S3 reduz apenas o disco local e mantém banda de ingestão e retenção total', () => {
  const local = capacity.calculateCapacity({ cameras: 500, bitrateMbps: 2.1, retentionDays: 30 });
  const cloud = capacity.calculateCapacity({
    cameras: 500,
    bitrateMbps: 2.1,
    retentionDays: 30,
    s3Enabled: true,
    localDays: 1,
  });

  assert.equal(cloud.ingressMbps, local.ingressMbps);
  assert.equal(cloud.fullStorageTB, local.fullStorageTB);
  assert.equal(cloud.s3OutputMbps, 1050);
  assert.ok(Math.abs(cloud.localStorageTB - 14.175) < 0.000001);
  assert.ok(cloud.localStorageTB < local.localStorageTB);
});

test('gravação por movimento reduz disco e escrita, sem reduzir o tráfego recebido', () => {
  const continuous = capacity.calculateCapacity({ cameras: 50, bitrateMbps: 2.1, retentionDays: 30 });
  const motion = capacity.calculateCapacity({ cameras: 50, bitrateMbps: 2.1, retentionDays: 30, recordingFactor: 0.25 });

  assert.equal(motion.ingressMbps, continuous.ingressMbps);
  assert.ok(Math.abs(motion.fullStorageTB - continuous.fullStorageTB * 0.25) < 0.000001);
});

test('faixas maiores são explicitamente tratadas como projeção', () => {
  const result = capacity.calculateCapacity({ cameras: 1000, bitrateMbps: 2.1, retentionDays: 30 });

  assert.equal(result.cpu, 24);
  assert.equal(result.ram, 96);
  assert.equal(result.projected, true);
});

test('CPU acompanha o custo medido e não superdimensiona o teste de 600 câmeras', () => {
  const result = capacity.calculateCapacity({ cameras: 600, bitrateMbps: 2.1, retentionDays: 3 });

  assert.equal(result.cpu, 16);
  assert.equal(result.ram, 56);
});

test('interface de rede acompanha o bitrate escolhido, não apenas a quantidade de câmeras', () => {
  const light = capacity.calculateCapacity({ cameras: 100, bitrateMbps: 2.1, retentionDays: 3 });
  const heavy = capacity.calculateCapacity({ cameras: 100, bitrateMbps: 12, retentionDays: 3 });

  assert.equal(light.nic, '1 GbE');
  assert.equal(heavy.nic, '10 GbE');
});
