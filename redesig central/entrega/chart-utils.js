'use strict';
/**
 * DRAC Central — lógica PURA do dashboard de frota (escala, downsampling, eixo de
 * tempo e agregação dos totais). Sem DOM, sem fetch, sem estado global: dá para
 * testar com node:test (CommonJS) e carregar no painel com <script src>.
 *
 * SEGURANÇA: este módulo NUNCA produz HTML. Ele só devolve números e strings
 * cruas; quem renderiza (index.html) continua obrigado a passar TODO valor
 * vindo do servidor por escapeHtml — o painel já teve XSS armazenado.
 *
 * Números: qualquer campo do heartbeat é atacante-controlável, então tudo entra
 * por toFiniteNumber() — string/NaN/Infinity viram o fallback, nunca vazam.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.DracChartUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 24 * 60 * 60 * 1000;

  function toFiniteNumber(value, fallback = 0) {
    if (value === null || value === undefined || value === '') return fallback;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function pad2(value) {
    return String(value).padStart(2, '0');
  }

  function round(value, decimals = 2) {
    const factor = 10 ** decimals;
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return 0;
    return Math.round(parsed * factor) / factor;
  }

  /**
   * Aceita ISO string, Date ou epoch. Epoch em SEGUNDOS (< 1e11) é promovido a
   * milissegundos — heartbeats de agentes usam os dois formatos.
   */
  function toEpochMs(value) {
    if (value === null || value === undefined || value === '') return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : null;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) return null;
      return Math.abs(value) < 1e11 ? Math.round(value * 1000) : Math.round(value);
    }
    const text = String(value).trim();
    if (!text) return null;
    if (/^-?\d+$/.test(text)) return toEpochMs(Number(text));
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
  }

  // ── Métricas da instalação ────────────────────────────────────────────────
  /**
   * Mesma cadeia de fallback do metric() do index.html, mas devolvendo NÚMERO
   * (o metric() do painel devolve texto escapado para innerHTML). Se as duas
   * divergirem, o card e o gráfico passam a contar coisas diferentes.
   */
  function metricNumber(installation, key, fallback = 0) {
    const metrics = (installation && typeof installation === 'object' && installation.metrics) || {};
    const cameras = metrics.cameras && typeof metrics.cameras === 'object' && !Array.isArray(metrics.cameras)
      ? metrics.cameras
      : {};
    const disk = metrics.disk && typeof metrics.disk === 'object' ? metrics.disk : {};
    const recording = metrics.recording && typeof metrics.recording === 'object' ? metrics.recording : {};
    let picked;
    if (metrics[key] !== undefined && metrics[key] !== null) picked = metrics[key];
    else if (key === 'cameraTotal') picked = cameras.total;
    else if (key === 'cameraOnline') picked = cameras.online;
    else if (key === 'cameraOffline') picked = cameras.offline;
    else if (key === 'cameraError') picked = cameras.error;
    else if (key === 'diskUsagePercent') picked = disk.usagePercent;
    else if (key === 'activeRecordingCount') picked = recording.active;
    else if (key === 'recordingAttentionCameras') picked = recording.attention;
    return toFiniteNumber(picked, fallback);
  }

  /**
   * Totais da frota para os cartões de topo. `offline` é tudo que não é ONLINE
   * nem PENDING_INSTALL — instalação provisionada e nunca vista não é queda.
   */
  function aggregateFleetTotals(installations) {
    const list = Array.isArray(installations) ? installations.filter((item) => item && typeof item === 'object') : [];
    const totals = {
      installations: list.length,
      online: 0,
      offline: 0,
      pending: 0,
      cameraTotal: 0,
      cameraOnline: 0,
      cameraIssues: 0,
      camerasProblem: 0,
      camerasAttention: 0,
      recordingActive: 0,
      recordingAttention: 0,
      maxDiskUsagePercent: 0,
      installationsWithIssues: 0,
    };
    for (const item of list) {
      const status = String(item.status || '');
      if (status === 'ONLINE') totals.online += 1;
      else if (status === 'PENDING_INSTALL') totals.pending += 1;
      else totals.offline += 1;

      totals.cameraTotal += metricNumber(item, 'cameraTotal', 0);
      totals.cameraOnline += metricNumber(item, 'cameraOnline', 0);
      const issues = metricNumber(item, 'cameraOffline', 0) + metricNumber(item, 'cameraError', 0);
      totals.cameraIssues += issues;
      totals.recordingActive += metricNumber(item, 'activeRecordingCount', 0);
      totals.recordingAttention += metricNumber(item, 'recordingAttentionCameras', 0);
      totals.maxDiskUsagePercent = Math.max(totals.maxDiskUsagePercent, metricNumber(item, 'diskUsagePercent', 0));
      const problem = selectProblemCameras(item).length;
      totals.camerasProblem += problem;
      // A mesma câmera aparece no contador agregado (cameraOffline/cameraError)
      // E no bloco detalhado `cameras`. Somar os dois inflaria o cartão, então
      // por instalação vale o MAIOR dos dois — nunca a soma.
      totals.camerasAttention += Math.max(issues, problem);
      if (issues > 0 || problem > 0 || status === 'OFFLINE') totals.installationsWithIssues += 1;
    }
    return totals;
  }

  // ── Câmeras com problema (bloco `cameras` do heartbeat) ───────────────────
  function readCameraList(installation) {
    if (Array.isArray(installation)) return installation; // resposta crua do endpoint
    if (!installation || typeof installation !== 'object') return [];
    const metrics = installation.metrics && typeof installation.metrics === 'object' ? installation.metrics : {};
    const candidates = [
      installation.cameras,
      metrics.cameras,
      metrics.cameras && typeof metrics.cameras === 'object' ? metrics.cameras.items : null,
      metrics.cameras && typeof metrics.cameras === 'object' ? metrics.cameras.list : null,
      metrics.cameraDetails,
    ];
    for (const candidate of candidates) {
      if (Array.isArray(candidate)) return candidate;
    }
    return [];
  }

  const CAMERA_REASON_WEIGHT = {
    recording_stalled: 0,
    error: 1,
    offline: 2,
    recording_inactive: 3,
    disabled: 4,
  };

  /**
   * Câmeras com problema. Aceita as TRÊS formas que circulam no sistema:
   *   • relatório de observabilidade da API .... recording.stalled/desired/active
   *   • saída de timeseries.parseCameraHealth .. recordingStalled/Desired/Active
   *   • campo plano que um agente antigo mande . stalled
   * Aceita tanto a instalação inteira quanto o array `cameras` cru da resposta
   * de /api/admin/installations/:id/timeseries.
   */
  function selectProblemCameras(installation, options = {}) {
    const limit = Number.isFinite(Number(options.limit)) && Number(options.limit) > 0 ? Math.floor(Number(options.limit)) : Infinity;
    const out = [];
    for (const camera of readCameraList(installation)) {
      if (!camera || typeof camera !== 'object' || Array.isArray(camera)) continue;
      const recording = camera.recording && typeof camera.recording === 'object' ? camera.recording : {};
      const pick = (nested, flat) => (nested === undefined || nested === null ? flat : nested);
      const stalled = pick(recording.stalled, pick(camera.recordingStalled, camera.stalled));
      const desired = pick(recording.desired, camera.recordingDesired);
      const active = pick(recording.active, camera.recordingActive);
      const status = String(camera.status === null || camera.status === undefined ? '' : camera.status).toLowerCase();
      const reasons = [];
      if (stalled === true) reasons.push('recording_stalled');
      if (status === 'error') reasons.push('error');
      else if (status === 'offline' || status === 'unavailable') reasons.push('offline');
      if (desired === true && active === false) reasons.push('recording_inactive');
      if (camera.enabled === false) reasons.push('disabled');
      if (!reasons.length) continue;
      const rawSeconds = pick(recording.secondsSinceLastSegment, camera.secondsSinceLastSegment);
      const secondsSinceLastSegment = rawSeconds === null || rawSeconds === undefined
        ? null
        : toFiniteNumber(rawSeconds, null);
      out.push({
        id: String(camera.cameraId ?? camera.id ?? ''),
        name: String(camera.name ?? camera.cameraId ?? camera.id ?? ''),
        status: status || 'unknown',
        enabled: camera.enabled !== false,
        reasons,
        severity: Math.min(...reasons.map((reason) => (reason in CAMERA_REASON_WEIGHT ? CAMERA_REASON_WEIGHT[reason] : 9))),
        secondsSinceLastSegment,
        restartsLastHour: toFiniteNumber(pick(recording.restartsLastHour, camera.restartsLastHour), 0),
      });
    }
    out.sort((a, b) => (a.severity - b.severity) || a.name.localeCompare(b.name));
    return limit === Infinity ? out : out.slice(0, limit);
  }

  // ── Série temporal ────────────────────────────────────────────────────────
  /**
   * Normaliza a resposta do endpoint de série temporal. Contrato mínimo:
   * pontos {t: <ISO>, ...valores numéricos}. Aceita o array cru ou embrulhado
   * em {points|items|series|data}. Campos NÃO numéricos são descartados — assim
   * nada de texto vindo do servidor entra no modelo do gráfico.
   */
  function normalizeSeries(payload) {
    const raw = Array.isArray(payload) ? payload
      : payload && Array.isArray(payload.points) ? payload.points
      : payload && Array.isArray(payload.items) ? payload.items
      : payload && Array.isArray(payload.series) ? payload.series
      : payload && Array.isArray(payload.data) ? payload.data
      : [];
    const out = [];
    for (const entry of raw) {
      if (!entry || typeof entry !== 'object') continue;
      const stamp = entry.t ?? entry.at ?? entry.time ?? entry.timestamp;
      const ts = toEpochMs(stamp);
      if (ts === null) continue;
      const point = { t: new Date(ts).toISOString(), ts };
      for (const key of Object.keys(entry)) {
        if (key === 't' || key === 'ts') continue;
        const raw = entry[key];
        // null é HONESTO no contrato do backend: métrica DESCONHECIDA, não zero.
        // Number(null) é 0 — deixar passar plotaria uma linha no chão que mente.
        if (raw === null || raw === undefined || raw === '') continue;
        const value = Number(raw);
        if (Number.isFinite(value)) point[key] = value;
      }
      out.push(point);
    }
    out.sort((a, b) => a.ts - b.ts);
    return out;
  }

  /**
   * Descobre qual nome de campo a série usa (o endpoint ainda está sendo criado;
   * aceitar aliases evita gráfico vazio por divergência de nomenclatura).
   */
  function resolveSeriesKey(points, aliases) {
    const list = Array.isArray(points) ? points : [];
    const names = Array.isArray(aliases) ? aliases : [aliases];
    for (const name of names) {
      if (typeof name !== 'string' || !name) continue;
      for (const point of list) {
        if (point && Number.isFinite(Number(point[name])) && point[name] !== null && point[name] !== '') return name;
      }
    }
    return null;
  }

  /**
   * Downsampling min/max: divide a série em baldes e, em CADA balde, guarda o
   * ponto de mínimo e o de máximo de CADA campo pedido (mais o primeiro e o
   * último). Média simples apagaria justamente o pico — que é o que interessa
   * num painel de operação. Resultado ≤ maxPoints + 2.
   */
  function downsamplePoints(points, maxPoints, keys) {
    const list = Array.isArray(points) ? points.filter((point) => point && typeof point === 'object') : [];
    const max = Math.max(2, Math.floor(toFiniteNumber(maxPoints, 2)));
    if (list.length <= max) return list.slice();
    const fields = (Array.isArray(keys) ? keys : [keys]).filter((key) => typeof key === 'string' && key);
    const perBucket = Math.max(2, fields.length * 2);
    const buckets = Math.max(1, Math.floor(max / perBucket));
    const bucketSize = list.length / buckets;
    const keep = new Set([0, list.length - 1]);
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = Math.floor(bucket * bucketSize);
      const end = bucket === buckets - 1 ? list.length : Math.floor((bucket + 1) * bucketSize);
      if (end <= start) continue;
      if (!fields.length) {
        keep.add(start);
        continue;
      }
      for (const field of fields) {
        let minIndex = -1;
        let maxIndex = -1;
        let minValue = Infinity;
        let maxValue = -Infinity;
        for (let index = start; index < end; index += 1) {
          const value = Number(list[index][field]);
          if (!Number.isFinite(value)) continue;
          if (value < minValue) { minValue = value; minIndex = index; }
          if (value > maxValue) { maxValue = value; maxIndex = index; }
        }
        if (minIndex >= 0) keep.add(minIndex);
        if (maxIndex >= 0) keep.add(maxIndex);
      }
    }
    return Array.from(keep).sort((a, b) => a - b).map((index) => list[index]);
  }

  // ── Escala e eixos ────────────────────────────────────────────────────────
  /** Passo "redondo" (1/2/5 × 10^n) para o eixo não virar 3,7142857. */
  function niceStep(span, targetTicks = 4) {
    const raw = toFiniteNumber(span, 0) / Math.max(1, Math.floor(toFiniteNumber(targetTicks, 4)));
    if (!Number.isFinite(raw) || raw <= 0) return 1;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    const normalized = raw / magnitude;
    const multiplier = normalized < 1.5 ? 1 : normalized < 3 ? 2 : normalized < 7 ? 5 : 10;
    return multiplier * magnitude;
  }

  /**
   * Escala do eixo Y. INVARIANTE: span > 0 SEMPRE — série constante, toda zero,
   * vazia ou com min/max forçados invertidos não pode gerar divisão por zero
   * (isso vira NaN no path do SVG e o gráfico some sem erro no console).
   */
  function computeScale(values, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const source = Array.isArray(values) ? values : [];
    const finite = [];
    for (const value of source) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) finite.push(parsed);
    }
    const forcedMin = Number.isFinite(Number(opts.min)) && opts.min !== null && opts.min !== undefined && opts.min !== '' ? Number(opts.min) : null;
    const forcedMax = Number.isFinite(Number(opts.max)) && opts.max !== null && opts.max !== undefined && opts.max !== '' ? Number(opts.max) : null;
    const includeZero = opts.includeZero !== false;
    const targetTicks = Math.max(2, Math.floor(toFiniteNumber(opts.ticks, 4)));

    let min = finite.length ? Math.min(...finite) : 0;
    let max = finite.length ? Math.max(...finite) : 0;
    if (includeZero) {
      min = Math.min(min, 0);
      max = Math.max(max, 0);
    }
    if (forcedMin !== null) min = forcedMin;
    if (forcedMax !== null) max = forcedMax;

    if (max === min) {
      if (max === 0) max = 1;
      else {
        const pad = Math.abs(max) / 2;
        min -= pad;
        max += pad;
      }
    }
    const integer = opts.integer === true;
    const niceStepFor = (span) => {
      const raw = niceStep(span, targetTicks);
      return integer ? Math.max(1, Math.ceil(raw)) : raw;
    };
    if (opts.nice !== false) {
      const step = niceStepFor(max - min);
      if (forcedMax === null) max = Math.ceil(max / step) * step;
      if (forcedMin === null) min = Math.floor(min / step) * step;
    }
    if (!(max > min)) max = min + 1; // guarda final: span nunca é 0 nem negativo

    const step = niceStepFor(max - min);
    const ticks = [];
    for (let value = min; value <= max + step / 1000 && ticks.length < 64; value += step) {
      ticks.push(round(value, 6));
    }
    if (ticks.length && ticks[ticks.length - 1] < max) ticks.push(round(max, 6));
    return { min, max, span: max - min, step, ticks };
  }

  /** Converte valor → coordenada Y (0 no topo). Fora da escala, grampeia. */
  function projectY(value, scale, height) {
    const plotHeight = Math.max(0, toFiniteNumber(height, 0));
    const parsed = Number(value);
    if (!scale || !Number.isFinite(Number(scale.span)) || Number(scale.span) <= 0) return plotHeight;
    if (!Number.isFinite(parsed)) return plotHeight;
    const clamped = Math.min(scale.max, Math.max(scale.min, parsed));
    return plotHeight - ((clamped - scale.min) / scale.span) * plotHeight;
  }

  /** Converte índice do ponto → coordenada X. */
  function projectX(index, count, width) {
    const plotWidth = Math.max(0, toFiniteNumber(width, 0));
    const total = Math.max(0, Math.floor(toFiniteNumber(count, 0)));
    const position = Math.max(0, Math.floor(toFiniteNumber(index, 0)));
    if (total <= 1) return plotWidth / 2;
    return (Math.min(position, total - 1) / (total - 1)) * plotWidth;
  }

  /** Coordenadas já projetadas de uma série (pontos sem número são pulados). */
  function projectSeries(points, key, geometry = {}, scale = null) {
    const list = Array.isArray(points) ? points : [];
    const geo = geometry && typeof geometry === 'object' ? geometry : {};
    const width = toFiniteNumber(geo.width, 0);
    const height = toFiniteNumber(geo.height, 0);
    const coords = [];
    for (let index = 0; index < list.length; index += 1) {
      const point = list[index];
      const value = point ? Number(point[key]) : NaN;
      if (!Number.isFinite(value)) continue;
      coords.push({
        index,
        value,
        x: round(projectX(index, list.length, width), 2),
        y: round(projectY(value, scale, height), 2),
      });
    }
    return coords;
  }

  /** Path da linha. Pontos sem valor numérico são pulados (a linha atravessa). */
  function buildLinePath(points, key, geometry = {}, scale = null) {
    const coords = projectSeries(points, key, geometry, scale);
    return coords.map((coord, index) => `${index ? 'L' : 'M'}${coord.x},${coord.y}`).join(' ');
  }

  /** Path da área (linha + fechamento na base). Vazio se a linha for vazia. */
  function buildAreaPath(points, key, geometry = {}, scale = null) {
    const coords = projectSeries(points, key, geometry, scale);
    if (!coords.length) return '';
    const geo = geometry && typeof geometry === 'object' ? geometry : {};
    const base = round(Math.max(0, toFiniteNumber(geo.height, 0)), 2);
    const line = coords.map((coord, index) => `${index ? 'L' : 'M'}${coord.x},${coord.y}`).join(' ');
    return `${line} L${coords[coords.length - 1].x},${base} L${coords[0].x},${base} Z`;
  }

  /** Índice do ponto mais próximo de uma posição relativa (0..1) no eixo X. */
  function nearestPointIndex(points, ratio) {
    const list = Array.isArray(points) ? points : [];
    if (!list.length) return -1;
    const clamped = Math.min(1, Math.max(0, toFiniteNumber(ratio, 0)));
    return Math.round(clamped * (list.length - 1));
  }

  /**
   * Rótulo do eixo de tempo. A granularidade segue a JANELA, não o ponto:
   * < 24h → HH:MM; < 7d → dd/mm HH:MM; ≥ 7d → dd/mm.
   */
  function formatAxisTime(value, options = {}) {
    const opts = options && typeof options === 'object' ? options : {};
    const ts = toEpochMs(value);
    if (ts === null) return '';
    const date = new Date(ts);
    const utc = opts.utc === true;
    const hours = utc ? date.getUTCHours() : date.getHours();
    const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
    const day = utc ? date.getUTCDate() : date.getDate();
    const month = (utc ? date.getUTCMonth() : date.getMonth()) + 1;
    const clock = `${pad2(hours)}:${pad2(minutes)}`;
    const stamp = `${pad2(day)}/${pad2(month)}`;
    const spanMs = toFiniteNumber(opts.spanMs, 0);
    if (opts.dateOnly === true || spanMs >= 7 * DAY_MS) return stamp;
    if (spanMs >= DAY_MS) return `${stamp} ${clock}`;
    return clock;
  }

  /** Marcas do eixo X distribuídas uniformemente pelos pontos já reduzidos. */
  function timeAxisTicks(points, count = 4, options = {}) {
    const list = Array.isArray(points) ? points.filter((point) => point && typeof point === 'object') : [];
    if (!list.length) return [];
    const first = toEpochMs(list[0].ts ?? list[0].t);
    const last = toEpochMs(list[list.length - 1].ts ?? list[list.length - 1].t);
    const spanMs = first === null || last === null ? 0 : Math.abs(last - first);
    const wanted = Math.max(1, Math.min(list.length, Math.floor(toFiniteNumber(count, 4))));
    const ticks = [];
    const seen = new Set();
    for (let step = 0; step < wanted; step += 1) {
      const index = wanted === 1 ? 0 : Math.round((step / (wanted - 1)) * (list.length - 1));
      if (seen.has(index)) continue;
      seen.add(index);
      ticks.push({
        index,
        ratio: list.length <= 1 ? 0 : index / (list.length - 1),
        label: formatAxisTime(list[index].ts ?? list[index].t, { ...options, spanMs }),
      });
    }
    return ticks;
  }

  return {
    toFiniteNumber,
    toEpochMs,
    round,
    metricNumber,
    aggregateFleetTotals,
    selectProblemCameras,
    readCameraList,
    normalizeSeries,
    resolveSeriesKey,
    downsamplePoints,
    niceStep,
    computeScale,
    projectX,
    projectY,
    projectSeries,
    buildLinePath,
    buildAreaPath,
    nearestPointIndex,
    formatAxisTime,
    timeAxisTicks,
  };
});
