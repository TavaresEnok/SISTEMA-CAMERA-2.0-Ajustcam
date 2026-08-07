/**
 * `$queryRaw` falso para os testes da fila de Revisão.
 *
 * A partir de 07/08/2026 o feed decide EM SQL quais eventos entram (só os que
 * ainda têm gravação cobrindo o instante) — ver `review.service.ts`. Um fake
 * que apenas devolvesse tudo tornaria os testes cegos justamente à regra nova,
 * então este aqui reimplementa a MESMA semântica sobre os dados do teste:
 *
 *   · piso  — evento anterior à gravação mais antiga não pode estar coberto;
 *   · EXISTS — gravação da mesma câmera com startedAt <= t <= (endedAt|∞);
 *   · ordem — occurredAt desc, com LIMIT/OFFSET.
 *
 * As duas consultas do serviço são distinguidas pelo texto: a da página começa
 * em `SELECT e."id"`, a de existência em `SELECT EXISTS`.
 */

type EventoFake = { id: string; cameraId: string; occurredAt: Date };
type GravacaoFake = { cameraId: string; startedAt: Date; endedAt: Date | null };

const textoDe = (sql: any) =>
  String(sql?.sql ?? (Array.isArray(sql?.strings) ? sql.strings.join(' ') : sql ?? ''));

export function temGravacao(evento: EventoFake, gravacoes: GravacaoFake[]) {
  const t = evento.occurredAt.getTime();
  return gravacoes.some(
    (r) =>
      r.cameraId === evento.cameraId &&
      r.startedAt.getTime() <= t &&
      (r.endedAt == null || r.endedAt.getTime() >= t),
  );
}

/** Eventos que o SQL do serviço deixaria passar, na ordem em que os devolve. */
export function eventosRevisaveis(eventos: EventoFake[], gravacoes: GravacaoFake[]) {
  if (!gravacoes.length) return [];
  const piso = Math.min(...gravacoes.map((r) => r.startedAt.getTime()));
  return eventos
    .filter((e) => e.occurredAt.getTime() >= piso && temGravacao(e, gravacoes))
    .sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
}

/** Monta o `$queryRaw` do prisma falso. */
export function criarQueryRaw(eventos: EventoFake[], gravacoes: GravacaoFake[]) {
  return async (sql: any) => {
    const texto = textoDe(sql);

    if (texto.includes('SELECT EXISTS')) {
      const algumSemVideo = eventos.some((e) => !temGravacao(e, gravacoes));
      return [{ ha: algumSemVideo }];
    }

    // `LIMIT ${limit + 1} OFFSET ${offset}` fecham a consulta, então são sempre
    // os dois últimos parâmetros ligados. Ler daí (em vez de fixar no fake)
    // mantém o teste honesto quando ele varia o tamanho da página.
    const valores: unknown[] = Array.isArray(sql?.values) ? sql.values : [];
    const deslocamento = Number(valores[valores.length - 1] ?? 0);
    const limiteMaisUm = Number(valores[valores.length - 2] ?? 41);

    return eventosRevisaveis(eventos, gravacoes)
      .slice(deslocamento, deslocamento + limiteMaisUm)
      .map((e) => ({ id: e.id }));
  };
}
