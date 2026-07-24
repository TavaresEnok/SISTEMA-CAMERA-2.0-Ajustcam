// Tempo da timeline de playback expresso em MINUTO-DO-DIA (float, com os
// segundos como fração). A precisão de segundos é o que faz a fila de Revisão
// abrir no INSTANTE do evento — o caminho de navegação/seek NUNCA deve arredondar
// para o minuto inteiro (arredondar erra até 30s, o caso de uso da Revisão).

export function minuteOfDay(input: string | Date): number {
  const date = input instanceof Date ? input : new Date(input);
  return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
}

export function hmsToMinute(hh: number, mm: number, ss = 0): number {
  return hh * 60 + mm + ss / 60;
}
