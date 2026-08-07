(function initialiseCapacityGuide(global) {
  'use strict';

  const CAMERA_TIERS = [
    { cameras: 50 },
    { cameras: 100 },
    { cameras: 300 },
    { cameras: 500 },
    { cameras: 1000 },
  ];
  const GB_PER_DAY_PER_MBPS = 10.8;
  const DISK_FREE_FACTOR = 0.8;
  const NETWORK_HEADROOM = 1.3;
  const CPU_PER_CAMERA = 0.016;
  const CPU_BASE_CORES = 0.5;
  const CPU_TARGET_FACTOR = 0.7;
  const RAM_GB_PER_CAMERA = 0.053;
  const RAM_BASE_GB = 1;
  const RAM_TARGET_FACTOR = 0.6;

  function clamp(value, minimum, maximum) {
    const numeric = Number(value);
    if (!Number.isFinite(numeric)) return minimum;
    return Math.min(maximum, Math.max(minimum, numeric));
  }

  function roundUp(value, multiple) {
    return Math.ceil(value / multiple) * multiple;
  }

  function nicFor(plannedNetworkMbps) {
    if (plannedNetworkMbps <= 700) return '1 GbE';
    if (plannedNetworkMbps <= 7000) return '10 GbE';
    if (plannedNetworkMbps <= 14000) return '2 × 10 GbE ou 25 GbE';
    return '25 ou 40 GbE';
  }

  function resourcesFor(cameraCount) {
    const cameras = clamp(cameraCount, 1, 5000);
    const cpu = Math.max(4, roundUp((CPU_BASE_CORES + cameras * CPU_PER_CAMERA) / CPU_TARGET_FACTOR, 4));
    const ram = Math.max(8, roundUp((RAM_BASE_GB + cameras * RAM_GB_PER_CAMERA) / RAM_TARGET_FACTOR, 8));
    return { cpu, ram, nic: nicFor(cameras * 2.1 * NETWORK_HEADROOM) };
  }

  function architectureFor(cameraCount) {
    if (cameraCount <= 50) return { title: 'Um servidor ou VM dedicada.', detail: 'Perfil indicado para uma instalação compacta.' };
    if (cameraCount <= 100) return { title: 'Um servidor robusto ou VM dedicada.', detail: 'Faça a validação final no hardware que será entregue.' };
    if (cameraCount <= 300) return { title: 'Múltiplos nós são recomendados.', detail: 'Segmente a carga e homologue a arquitetura horizontal antes da proposta.' };
    return { title: 'Arquitetura distribuída e redundante.', detail: 'Separe gravação, armazenamento e serviços para reduzir o impacto de uma falha.' };
  }

  function calculateCapacity(input) {
    const cameras = Math.round(clamp(input.cameras, 1, 5000));
    const bitrateMbps = clamp(input.bitrateMbps, 0.1, 100);
    const retentionDays = Math.round(clamp(input.retentionDays, 1, 3650));
    const recordingFactor = clamp(input.recordingFactor == null ? 1 : input.recordingFactor, 0.01, 1);
    const s3Enabled = Boolean(input.s3Enabled);
    const localDays = Math.round(clamp(input.localDays == null ? 1 : input.localDays, 1, retentionDays));
    const ingressMbps = cameras * bitrateMbps;
    const recordedMbps = ingressMbps * recordingFactor;
    const dailyTB = (recordedMbps * GB_PER_DAY_PER_MBPS) / 1000;
    const retainedDataTB = dailyTB * retentionDays;
    const fullStorageTB = retainedDataTB / DISK_FREE_FACTOR;
    const localStorageTB = s3Enabled ? (dailyTB * localDays) / DISK_FREE_FACTOR : fullStorageTB;
    const plannedNetworkMbps = ingressMbps * NETWORK_HEADROOM;
    const writeMBps = recordedMbps / 8;
    const resources = resourcesFor(cameras);

    return {
      cameras,
      bitrateMbps,
      retentionDays,
      recordingFactor,
      s3Enabled,
      localDays,
      ingressMbps,
      s3OutputMbps: s3Enabled ? recordedMbps : 0,
      dailyTB,
      retainedDataTB,
      fullStorageTB,
      localStorageTB,
      plannedNetworkMbps,
      writeMBps,
      cpu: resources.cpu,
      ram: resources.ram,
      nic: nicFor(plannedNetworkMbps),
      architecture: architectureFor(cameras),
      projected: cameras > 100,
    };
  }

  global.AJUSTCAM_CAPACITY = Object.freeze({
    CAMERA_TIERS,
    GB_PER_DAY_PER_MBPS,
    DISK_FREE_FACTOR,
    NETWORK_HEADROOM,
    CPU_PER_CAMERA,
    RAM_GB_PER_CAMERA,
    calculateCapacity,
    resourcesFor,
  });

  if (typeof document === 'undefined') return;

  const number = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 1 });
  const integer = new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 0 });
  const byId = (id) => document.getElementById(id);
  const form = byId('capacity-form');
  const cameraInput = byId('camera-count');
  const bitrateInput = byId('bitrate');
  const retentionInput = byId('retention');
  const recordingInput = byId('recording-factor');
  const s3Input = byId('s3-enabled');
  const localDaysInput = byId('local-days');

  function formatRate(mbps) {
    if (mbps >= 1000) return `${number.format(mbps / 1000)} Gbps`;
    return `${integer.format(mbps)} Mbps`;
  }

  function formatStorage(tb) {
    if (tb < 1) return `${integer.format(tb * 1000)} GB`;
    return `${number.format(tb)} TB`;
  }

  function selectedRecordingLabel() {
    return recordingInput.options[recordingInput.selectedIndex].text.split('·')[0].trim().toLowerCase();
  }

  function currentInput(cameraOverride) {
    return {
      cameras: cameraOverride == null ? cameraInput.value : cameraOverride,
      bitrateMbps: bitrateInput.value,
      retentionDays: retentionInput.value,
      recordingFactor: recordingInput.value,
      s3Enabled: s3Input.checked,
      localDays: localDaysInput.value,
    };
  }

  function setText(id, value) {
    const element = byId(id);
    if (element) element.textContent = value;
  }

  function renderTable(selectedCameras) {
    const body = byId('capacity-table');
    body.replaceChildren(...CAMERA_TIERS.map((tier) => {
      const result = calculateCapacity(currentInput(tier.cameras));
      const row = document.createElement('tr');
      if (selectedCameras === tier.cameras) row.className = 'active-row';
      const values = [
        `${integer.format(tier.cameras)} câmeras`,
        `${result.cpu} núcleos`,
        `${result.ram} GB`,
        formatRate(result.plannedNetworkMbps),
        formatStorage(result.localStorageTB),
        result.nic,
      ];
      values.forEach((value) => {
        const cell = document.createElement('td');
        cell.textContent = value;
        row.appendChild(cell);
      });
      return row;
    }));
  }

  function render() {
    const result = calculateCapacity(currentInput());
    cameraInput.value = String(result.cameras);
    setText('bitrate-value', `${number.format(result.bitrateMbps)} Mbps`);
    setText('result-title', `${integer.format(result.cameras)} câmeras`);
    byId('cpu-result').innerHTML = `${result.cpu} <small>núcleos</small>`;
    byId('ram-result').innerHTML = `${result.ram} <small>GB</small>`;
    byId('storage-result').innerHTML = `${formatStorage(result.localStorageTB).replace(' ', ' <small>')}</small>`;
    setText('storage-label', result.s3Enabled ? 'Cache local útil' : 'Disco útil');
    setText('storage-note', result.s3Enabled ? `${result.localDays} dia(s) local e 20% livre` : `${result.retentionDays} dias e 20% livre`);
    byId('network-result').innerHTML = `${formatRate(result.plannedNetworkMbps).replace(' ', ' <small>')}</small>`;
    setText('network-note', `Interface de ${result.nic}`);
    setText('daily-result', formatStorage(result.dailyTB));
    setText('write-result', `${number.format(result.writeMBps)} MB/s`);
    setText('ingress-result', formatRate(result.ingressMbps));
    setText('s3-output-result', formatRate(result.s3OutputMbps));
    byId('s3-output-row').hidden = !result.s3Enabled;
    byId('local-days-wrap').hidden = !result.s3Enabled;
    localDaysInput.max = String(result.retentionDays);
    localDaysInput.value = String(result.localDays);

    const confidence = byId('confidence-badge');
    confidence.textContent = result.projected ? 'Projeção · exige homologação' : 'Projeção baseada em medição';
    confidence.classList.toggle('projected', result.projected);
    byId('architecture-note').querySelector('p').innerHTML = `<strong>${result.architecture.title}</strong> ${result.architecture.detail}`;
    setText('scenario-summary', `${number.format(result.bitrateMbps)} Mbps · ${result.retentionDays} dias · ${selectedRecordingLabel()}${result.s3Enabled ? ' · S3' : ''}`);

    document.querySelectorAll('[data-cameras]').forEach((button) => {
      button.classList.toggle('active', Number(button.dataset.cameras) === result.cameras);
    });
    renderTable(result.cameras);
    byId('copy-summary').dataset.summary = buildSummary(result);
  }

  function buildSummary(result) {
    const storageKind = result.s3Enabled ? `cache local de ${formatStorage(result.localStorageTB)} (${result.localDays} dia(s))` : `${formatStorage(result.localStorageTB)} úteis para ${result.retentionDays} dias`;
    const s3 = result.s3Enabled ? ` Upload médio ao S3: ${formatRate(result.s3OutputMbps)}.` : '';
    const status = result.projected ? ' Esta faixa é uma projeção e deve ser homologada no hardware definitivo.' : ' Dimensionamento baseado na medição do gravador, sujeito à validação no hardware definitivo.';
    return `AjustCam — ${integer.format(result.cameras)} câmeras a ${number.format(result.bitrateMbps)} Mbps: ${result.cpu} núcleos, ${result.ram} GB de RAM, ${storageKind}, banda planejada de ${formatRate(result.plannedNetworkMbps)} e interface ${result.nic}.${s3}${status}`;
  }

  form.addEventListener('input', render);
  form.addEventListener('change', render);
  document.querySelectorAll('[data-cameras]').forEach((button) => {
    button.addEventListener('click', () => {
      cameraInput.value = button.dataset.cameras;
      render();
    });
  });
  byId('print-page').addEventListener('click', () => global.print());
  byId('copy-summary').addEventListener('click', async (event) => {
    const feedback = byId('copy-feedback');
    try {
      await navigator.clipboard.writeText(event.currentTarget.dataset.summary);
      feedback.textContent = 'Resumo copiado.';
    } catch (_) {
      feedback.textContent = 'Não foi possível copiar automaticamente. Use a impressão em PDF.';
    }
    global.setTimeout(() => { feedback.textContent = ''; }, 3000);
  });

  render();
})(typeof window === 'undefined' ? globalThis : window);
