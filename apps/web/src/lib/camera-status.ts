// ── O QUE A COLUNA "STATUS" DEVE DIZER ──────────────────────────────────────
//
// `camera.status` carrega TRÊS ideias no mesmo campo:
//
//   conexão   → online, offline, no_signal, maintenance
//   atividade → recording  ("está gravando neste instante")
//   evento    → motion, alarm  ("detectou algo agora")
//
// Mostrar o campo cru numa coluna chamada "Status" produz uma lista em que uma
// câmera diz "Gravando", a de baixo diz "Movimento" e a outra diz "Online" —
// três respostas para perguntas diferentes, empilhadas como se fossem
// comparáveis. E quando a coluna vizinha ("Gravação") mostra o MODO configurado,
// as duas exibem "Movimento" lado a lado significando coisas distintas: uma é o
// que aconteceu agora, a outra é como a câmera está configurada há meses.
//
// Aqui as três ideias são separadas. Cada coluna passa a responder uma pergunta
// só, e a mesma palavra deixa de aparecer duas vezes com sentidos diferentes.

export type EstadoConexao = 'online' | 'offline' | 'sem_sinal' | 'manutencao';

/**
 * A CONEXÃO, e nada mais.
 *
 * `recording`, `motion` e `alarm` implicam câmera conectada — são atividade
 * acontecendo sobre uma conexão viva. Tratá-los como estados de conexão é o que
 * fazia a coluna oscilar entre palavras incomparáveis.
 */
export function estadoConexao(status: string): EstadoConexao {
  switch (status) {
    case 'offline':
      return 'offline';
    case 'no_signal':
      return 'sem_sinal';
    case 'maintenance':
      return 'manutencao';
    default:
      // online, recording, motion, alarm e qualquer estado novo: há conexão.
      return 'online';
  }
}

export const ROTULO_CONEXAO: Record<EstadoConexao, string> = {
  online: 'Online',
  offline: 'Offline',
  sem_sinal: 'Sem sinal',
  manutencao: 'Manutenção',
};

/**
 * A ATIVIDADE do instante, ou `null` quando não há nada acontecendo.
 *
 * Devolver `null` em vez de "Parada" é deliberado: ausência de atividade não é
 * um estado que mereça um selo na tela. Um selo para cada câmera ociosa vira
 * ruído que esconde as duas que estão gravando.
 */
export function atividadeAgora(status: string): string | null {
  switch (status) {
    case 'recording':
      return 'Gravando agora';
    case 'motion':
      return 'Movimento agora';
    case 'alarm':
      return 'Alarme';
    default:
      return null;
  }
}
