// ── QUAL É O GRUPO DO CLIENTE ───────────────────────────────────────────────
//
// A cota de câmeras privadas ("quantas o cliente pode cadastrar pelo app dele")
// vive no GRUPO. Para aplicá-la é preciso descobrir a qual grupo o cliente
// pertence — e é aí que estava o defeito.
//
// As duas rotas (ler a cota e criar a câmera) procuravam o grupo assim:
//
//     where: { userId, groupId: { not: null }, level: ADMIN }
//
// Exigir ADMIN é um palpite sobre como o acesso foi concedido, não um fato. Na
// instalação real o cliente tinha nível CONTROL no grupo dele. Resultado: a
// consulta não achava nada, `groupId` ficava nulo, a cota caía para 0 e o app
// dizia "Cadastro de câmeras não habilitado para sua conta" — mesmo com o
// operador tendo acabado de configurar 3 câmeras no grupo, e vendo o 3 salvo na
// tela. Nenhum log, nenhuma pista: as duas telas discordavam em silêncio.
//
// O que identifica o grupo do cliente é EXISTIR vínculo com ele, em qualquer
// nível. Quem decide se pode cadastrar é a cota do grupo (0 = não pode), que já
// é o freio explícito e configurado por quem opera.
//
// A regra ficou aqui, e não repetida nas duas rotas, porque lógica duplicada em
// dois lugares diverge — e foi exatamente assim que este defeito passou:
// bastava um dos lados mudar de ideia sobre o nível exigido.

export type NivelPermissao = 'VIEW' | 'CONTROL' | 'RECORD' | 'ADMIN';

export interface VinculoDeGrupo {
  groupId: string | null;
  level: NivelPermissao;
  createdAt: Date;
}

/**
 * Desempate quando o usuário tem vínculo com mais de um grupo.
 *
 * O nível mais alto ganha: se alguém é ADMIN de um grupo e VIEW de outro, o
 * "dele" é aquele que administra. Sem isso, a câmera privada poderia nascer
 * dentro do grupo de OUTRO cliente — o que, num sistema em que o grupo governa
 * retenção e acesso, é vazamento, não engano de cadastro.
 */
const PRIORIDADE: Record<NivelPermissao, number> = {
  ADMIN: 4,
  RECORD: 3,
  CONTROL: 2,
  VIEW: 1,
};

/**
 * O grupo ao qual o cliente pertence, ou `null` se não pertence a nenhum.
 *
 * `null` NÃO significa "pode tudo": significa que não há grupo de onde ler a
 * cota, e quem chama trata isso como limite 0.
 */
export function escolherGrupoDoCliente(vinculos: readonly VinculoDeGrupo[]): string | null {
  let melhor: VinculoDeGrupo | null = null;
  for (const v of vinculos) {
    if (!v.groupId) continue;
    if (!melhor) { melhor = v; continue; }
    const p = PRIORIDADE[v.level] ?? 0;
    const pMelhor = PRIORIDADE[melhor.level] ?? 0;
    if (p > pMelhor) { melhor = v; continue; }
    // Empate no nível: o vínculo mais ANTIGO vence. É estável — a resposta não
    // muda porque alguém ganhou acesso a outro grupo ontem, e uma cota que se
    // move sozinha é impossível de explicar para quem opera.
    if (p === pMelhor && v.createdAt < melhor.createdAt) melhor = v;
  }
  return melhor?.groupId ?? null;
}
