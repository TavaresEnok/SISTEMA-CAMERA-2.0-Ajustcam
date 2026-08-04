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

/**
 * A COR do selo de conexão. Verde e vermelho, e nada mais.
 *
 * Antes a cor vinha do status CRU, então o rótulo já dizia "Online" enquanto o
 * fundo continuava vermelho (gravando) ou âmbar (movimento): três "Online" com
 * três cores, dois deles gritando alarme sem haver alarme.
 *
 * Verde e vermelho são reservados a conectado/caído. Estado intermediário fica
 * NEUTRO — pintar "Sem sinal" de vermelho equipara um problema de sinal a uma
 * câmera fora do ar, e quem olha a lista não consegue mais priorizar.
 */
export const CLASSE_CONEXAO: Record<EstadoConexao, string> = {
  online: 'bg-[hsl(var(--status-online)_/_0.12)] text-[hsl(var(--status-online))] border-[hsl(var(--status-online)_/_0.3)]',
  offline: 'bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))] border-[hsl(var(--destructive)_/_0.3)]',
  sem_sinal: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-border',
  manutencao: 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-border',
};

/** O ponto colorido, mesma regra do selo. */
export const PONTO_CONEXAO: Record<EstadoConexao, string> = {
  online: 'bg-[hsl(var(--status-online))]',
  offline: 'bg-[hsl(var(--destructive))]',
  sem_sinal: 'bg-[hsl(var(--muted-foreground))]',
  manutencao: 'bg-[hsl(var(--muted-foreground))]',
};

/**
 * A cor do MODO de gravação. Deliberadamente sem verde, vermelho ou âmbar.
 *
 * Modo é configuração, não incidente. Pintá-lo com as cores de alerta faz uma
 * lista de câmeras saudáveis parecer um painel de emergência — e quando algo
 * realmente quebrar, ninguém vai notar no meio do vermelho.
 */
export const CLASSE_MODO_GRAVACAO =
  'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-border';
