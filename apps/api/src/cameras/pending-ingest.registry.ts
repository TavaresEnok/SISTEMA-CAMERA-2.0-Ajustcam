import { Injectable } from '@nestjs/common';
import { envNumber } from '../common/config/env-number.helper';
import { isAcceptableIngestPath, normalizeIngestPath } from './helpers/rtmp-ingest.helper';

// ── EQUIPAMENTOS BATENDO NA PORTA ──────────────────────────────────────────
//
// O princípio: o sistema não pode simplesmente calar quando um equipamento
// tenta publicar num caminho que não conhece. Recusar em silêncio transforma
// "a câmera não aparece" num mistério — foi exatamente o que aconteceu na
// primeira tentativa de campo, e só se descobriu capturando pacote.
//
// Aqui as tentativas viram informação: quem tentou, de onde, quando e quantas
// vezes. O administrador olha a lista e diz "esta é a câmera da portaria".
//
// Por que NÃO aceitar automaticamente: a porta 1935 é pública. Sem a
// confirmação, qualquer pessoa na internet publicaria vídeo que entraria como
// prova no sistema. A confirmação é barata (um clique) e é o que separa o
// equipamento do cliente de um desconhecido.
//
// Memória: mapa em RAM com teto e expiração. Tentativa é sinal operacional de
// vida curta — não merece tabela, migração nem disco, e reiniciar a API
// simplesmente limpa a lista (o equipamento tenta de novo em segundos).

export type PendingIngest = {
  path: string;
  /** Endereço de origem, para o operador reconhecer o site. */
  remoteAddr: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  attempts: number;
};

@Injectable()
export class PendingIngestRegistry {
  private readonly pendentes = new Map<string, PendingIngest>();

  /** Quantos caminhos distintos guardar. Teto contra varredura de porta. */
  private maxEntries() {
    return envNumber('RTMP_PENDING_MAX', 50, { min: 1, max: 500, integer: true });
  }

  /** Depois disto a tentativa some. Equipamento vivo re-tenta e volta à lista. */
  private ttlMs() {
    return envNumber('RTMP_PENDING_TTL_MINUTES', 60, { min: 1, max: 1440, integer: true }) * 60_000;
  }

  /**
   * Registra uma tentativa recusada. Devolve void de propósito: quem chama é o
   * caminho de autenticação, e nada aqui pode alterar a decisão de negar.
   */
  record(path: unknown, remoteAddr?: string | null) {
    if (!isAcceptableIngestPath(path)) return; // lixo não entra nem na lista
    const chave = normalizeIngestPath(path);
    const agora = Date.now();
    const existente = this.pendentes.get(chave);
    if (existente) {
      existente.lastSeenAt = agora;
      existente.attempts += 1;
      if (remoteAddr) existente.remoteAddr = remoteAddr;
      return;
    }
    this.expirarAntigas(agora);
    if (this.pendentes.size >= this.maxEntries()) {
      // Cheio: descarta quem MENOS insistiu, desempatando pela tentativa mais
      // antiga. O critério é esse, e não só o horário, porque uma varredura de
      // porta despeja dezenas de caminhos no mesmo instante — ordenar por tempo
      // ali escolhe ao acaso e pode expulsar justamente o equipamento real,
      // bem quando o operador for procurá-lo na tela.
      //
      // Câmera de verdade re-tenta a cada 60s e acumula tentativas; quem bateu
      // uma vez, não. A contagem é o que separa os dois.
      let vitima: string | null = null;
      let menorInsistencia = Infinity;
      let maisAntiga = Infinity;
      for (const [k, v] of this.pendentes) {
        if (v.attempts < menorInsistencia
          || (v.attempts === menorInsistencia && v.lastSeenAt < maisAntiga)) {
          menorInsistencia = v.attempts;
          maisAntiga = v.lastSeenAt;
          vitima = k;
        }
      }
      if (vitima) this.pendentes.delete(vitima);
    }
    this.pendentes.set(chave, {
      path: chave,
      remoteAddr: remoteAddr ?? null,
      firstSeenAt: agora,
      lastSeenAt: agora,
      attempts: 1,
    });
  }

  /** Lista para a tela, mais recente primeiro. */
  list(): PendingIngest[] {
    const agora = Date.now();
    this.expirarAntigas(agora);
    return [...this.pendentes.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt);
  }

  /** Some da lista quando o caminho é vinculado a uma câmera. */
  clear(path: string) {
    this.pendentes.delete(normalizeIngestPath(path));
  }

  private expirarAntigas(agora: number) {
    const ttl = this.ttlMs();
    for (const [k, v] of this.pendentes) {
      if (agora - v.lastSeenAt > ttl) this.pendentes.delete(k);
    }
  }
}
