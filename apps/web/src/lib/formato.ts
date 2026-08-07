// ── FORMATAÇÃO ÚNICA ────────────────────────────────────────────────────────
//
// A auditoria encontrou dois formatadores de bytes diferentes (um forçava GB
// sempre — uma câmera de 30 MB aparecia como "0.03 GB" — e usava ponto decimal
// sem separador de milhar, "1234.56 GB") e duas convenções de data convivendo
// (sete telas com `format()` do date-fns, três com `toLocaleString`), nenhuma
// declarando o locale pt-BR. Uma tela chegava a usar `yyyy-MM-dd` na linha
// seguinte a um `dd/MM/yyyy`.

/** Bytes em unidade legível, com vírgula decimal e separador de milhar. */
export function formatarBytes(bytes: number | string | null | undefined): string {
  const valor = typeof bytes === 'string' ? Number(bytes) : bytes;
  if (valor == null || !Number.isFinite(valor)) return 'N/D';
  if (valor === 0) return '0 B';
  const unidades = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const escala = Math.min(unidades.length - 1, Math.floor(Math.log(Math.abs(valor)) / Math.log(1024)));
  const numero = valor / 1024 ** escala;
  // Sem casas em B/KB (precisão que ninguém usa) e no máximo duas nas demais.
  // `maximumFractionDigits` sem o mínimo: 30 MB sai "30 MB", não "30,00 MB".
  const casas = escala <= 1 ? 0 : numero >= 100 ? 1 : 2;
  return `${numero.toLocaleString('pt-BR', { maximumFractionDigits: casas })} ${unidades[escala]}`;
}

/** Data e hora no padrão brasileiro. */
export function formatarDataHora(valor: Date | string | number | null | undefined): string {
  if (valor == null) return 'N/D';
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? 'N/D' : data.toLocaleString('pt-BR');
}

/** Só a data, padrão brasileiro. */
export function formatarData(valor: Date | string | number | null | undefined): string {
  if (valor == null) return 'N/D';
  const data = valor instanceof Date ? valor : new Date(valor);
  return Number.isNaN(data.getTime()) ? 'N/D' : data.toLocaleDateString('pt-BR');
}

/** Número com separador de milhar brasileiro. */
export function formatarNumero(valor: number | null | undefined): string {
  return valor == null || !Number.isFinite(valor) ? 'N/D' : valor.toLocaleString('pt-BR');
}
