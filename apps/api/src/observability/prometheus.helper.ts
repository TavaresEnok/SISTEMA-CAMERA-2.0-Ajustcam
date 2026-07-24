// Exposição de métricas no formato de texto do Prometheus, sem dependência nova
// (prom-client seria um extra; o formato é simples e estável). Puro e testável.

export type Metric = {
  name: string;
  help: string;
  type: 'gauge' | 'counter';
  value: number;
  labels?: Record<string, string>;
};

function renderLabels(labels?: Record<string, string>): string {
  const entries = Object.entries(labels ?? {}).filter(([, v]) => v != null && v !== '');
  if (!entries.length) return '';
  const inner = entries
    .map(([k, v]) => `${k}="${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, ' ')}"`)
    .join(',');
  return `{${inner}}`;
}

export function formatPrometheus(metrics: Metric[]): string {
  const lines: string[] = [];
  // Agrupa HELP/TYPE por nome (o Prometheus exige uma única declaração por métrica).
  const declared = new Set<string>();
  for (const m of metrics) {
    if (!Number.isFinite(m.value)) continue; // nunca emite NaN/Inf (quebra o scraper)
    if (!declared.has(m.name)) {
      lines.push(`# HELP ${m.name} ${m.help}`);
      lines.push(`# TYPE ${m.name} ${m.type}`);
      declared.add(m.name);
    }
    lines.push(`${m.name}${renderLabels(m.labels)} ${m.value}`);
  }
  return lines.join('\n') + '\n';
}
