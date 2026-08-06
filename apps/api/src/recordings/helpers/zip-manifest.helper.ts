// ── O ZIP PRESTA CONTAS DO QUE FOI PEDIDO ───────────────────────────────────
//
// Num acervo probatório, "pedi 20 gravações e vieram 3" sem explicação é
// inaceitável — e era exatamente o que o `continue` silencioso fazia. O
// manifesto viaja DENTRO do próprio ZIP: onde quer que o pacote chegue
// (perícia, seguradora, backup), a lista do que entrou e do que ficou de fora
// — com o motivo — chega junto.

export function montarManifestoZip(
  totalPedidas: number,
  incluidas: string[],
  puladas: Array<{ id: string; motivo: string }>,
): string {
  const linhas: string[] = [
    'MANIFESTO DO PACOTE DE GRAVAÇÕES — DRAC VMS',
    `Gerado em: ${new Date().toISOString()}`,
    '',
    `Pedidas: ${totalPedidas}`,
    `Incluídas: ${incluidas.length}`,
    `Fora do pacote: ${puladas.length}`,
    '',
    '── INCLUÍDAS ──',
    ...(incluidas.length ? incluidas.map((nome) => `  ${nome}`) : ['  (nenhuma)']),
  ];
  if (puladas.length) {
    linhas.push('', '── FORA DO PACOTE (verifique antes de considerar o acervo completo) ──');
    for (const item of puladas) linhas.push(`  ${item.id} — ${item.motivo}`);
  }
  linhas.push('');
  return linhas.join('\n');
}
