import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert } from 'react-native';
import { AppState } from 'react-native';
import { request } from '../services/api';
import type { Alarm, Session } from '../types';

const POLL_INTERVAL_MS = 30_000;

export type UseAlarms = {
  alarms: Alarm[];
  openAlarmCount: number;
  reload: () => Promise<void>;
  ack: (alarm: Alarm) => Promise<void>;
  resolve: (alarm: Alarm) => Promise<void>;
  /** Falha na última carga — distingue "não há alarmes" de "não consegui perguntar". */
  erro: string | null;
  carregando: boolean;
};

/**
 * Estado e ações dos alarmes no app. Carrega sob demanda (`reload`, usado também no
 * pull-to-refresh) e sonda a cada 30s — substituto temporário do push, que exige um
 * dev build. As ações fazem update otimista e recarregam para reconciliar.
 */
export function useAlarms(session: Session | null): UseAlarms {
  const [alarms, setAlarms] = useState<Alarm[]>([]);
  const [erro, setErro] = useState<string | null>(null);
  const [carregando, setCarregando] = useState(false);
  const [foreground, setForeground] = useState(AppState.currentState === 'active');

  useEffect(() => {
    const sub = AppState.addEventListener('change', (state) => setForeground(state === 'active'));
    return () => sub.remove();
  }, []);

  const reload = useCallback(async () => {
    if (!session) return;
    setCarregando(true);
    try {
      const data = await request<{ items: Alarm[] }>(session.apiUrl, '/cameras/alarms?limit=100', session.token);
      setAlarms(Array.isArray(data.items) ? data.items : []);
      setErro(null);
    } catch (erro) {
      // ERRO ≠ "TUDO TRANQUILO". Mantém a lista atual (falha transitória não
      // apaga o que já está na tela), mas REGISTRA a falha: sem isto, uma
      // primeira carga que falhasse deixava `alarms: []` e a tela afirmava
      // "Tudo tranquilo — nenhum alarme". Numa central de alarmes, essa é a
      // mentira mais cara que a interface pode contar.
      setErro(erro instanceof Error ? erro.message : 'Não foi possível carregar os alarmes.');
    } finally {
      setCarregando(false);
    }
  }, [session?.token, session?.apiUrl]);

  const transition = useCallback(
    async (alarm: Alarm, action: 'ack' | 'resolve', optimisticStatus: Alarm['status'], failMessage: string) => {
      if (!session) return;
      setAlarms((current) => current.map((item) => (item.id === alarm.id ? { ...item, status: optimisticStatus } : item)));
      try {
        await request(session.apiUrl, `/cameras/alarms/${alarm.id}/${action}`, session.token, {
          method: 'POST',
          body: JSON.stringify({}),
        });
        void reload();
      } catch (error) {
        void reload();
        Alert.alert('Alarme', error instanceof Error ? error.message : failMessage);
      }
    },
    [session?.token, session?.apiUrl, reload],
  );

  const ack = useCallback(
    (alarm: Alarm) => transition(alarm, 'ack', 'ACKED', 'Não foi possível reconhecer o alarme.'),
    [transition],
  );
  const resolve = useCallback(
    (alarm: Alarm) => transition(alarm, 'resolve', 'RESOLVED', 'Não foi possível resolver o alarme.'),
    [transition],
  );

  useEffect(() => {
    if (!session) {
      setAlarms([]);
      return;
    }
    if (!foreground) return;
    const interval = setInterval(() => { void reload(); }, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [session?.token, reload, foreground]);

  const openAlarmCount = useMemo(() => alarms.filter((alarm) => alarm.status === 'OPEN').length, [alarms]);

  return { alarms, openAlarmCount, reload, ack, resolve, erro, carregando };
}
