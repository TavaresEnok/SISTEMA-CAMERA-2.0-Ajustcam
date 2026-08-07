/** AlarmsScreen — eventos de detecção de movimento: reconhecer/resolver. */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme/ThemeProvider';
import { withAlpha } from '../services/branding';
import type { Alarm } from '../types';

const SEGMENTS = ['Abertos', 'Reconhecidos', 'Todos'] as const;
type Segment = (typeof SEGMENTS)[number];
const PRIORITY_RANK: Record<string, number> = { P1: 0, P2: 1, P3: 2, P4: 3 };

interface AlarmsScreenProps {
  alarms: Alarm[];
  highlightedAlarmId?: string | null;
  canManage: boolean;
  refreshing: boolean;
  onRefresh: () => void;
  /** Falha ao carregar — distingue "não há alarmes" de "não consegui perguntar". */
  erro?: string | null;
  onAck: (alarm: Alarm) => void;
  onResolve: (alarm: Alarm) => void;
  onOpenCamera: (cameraId: string) => void;
}

function timeAgo(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const diff = Math.max(0, Date.now() - then);
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}


export function AlarmsScreen({ alarms, highlightedAlarmId, canManage, refreshing, onRefresh, onAck, onResolve, onOpenCamera, erro}: AlarmsScreenProps) {
  const { theme } = useTheme();
  const [segment, setSegment] = useState<Segment>('Abertos');

  const openCount = useMemo(() => alarms.filter((a) => a.status === 'OPEN').length, [alarms]);
  const criticalCount = useMemo(() => alarms.filter((a) => a.status === 'OPEN' && ['P1', 'P2'].includes(a.priority)).length, [alarms]);
  const motionCount = useMemo(() => alarms.filter((a) => a.status === 'OPEN' && a.type.includes('MOTION')).length, [alarms]);
  const filtered = useMemo(() => {
    const items = segment === 'Abertos'
      ? alarms.filter((a) => a.status === 'OPEN')
      : segment === 'Reconhecidos'
        ? alarms.filter((a) => a.status === 'ACKED')
        : alarms;
    return [...items].sort((a, b) => {
      const highlight = Number(b.id === highlightedAlarmId) - Number(a.id === highlightedAlarmId);
      if (highlight) return highlight;
      const priority = (PRIORITY_RANK[a.priority] ?? 9) - (PRIORITY_RANK[b.priority] ?? 9);
      return priority || new Date(b.occurredAt).getTime() - new Date(a.occurredAt).getTime();
    });
  }, [alarms, segment, highlightedAlarmId]);

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textSub} />}
    >
      <View style={styles.header}>
        <View style={styles.headerRow}>
          <View style={[styles.headerIcon, { backgroundColor: 'rgba(239,68,68,0.12)' }]}>
            <Icon name="eye" size={22} color="#ef4444" strokeWidth={2} />
          </View>
          <View>
            <Text style={[styles.title, { color: theme.bgText }]}>Alarmes</Text>
            <Text style={[styles.subtitle, { color: withAlpha(theme.bgText, 0.72) ?? theme.bgText }]}>
              Eventos de segurança · {openCount} em aberto
            </Text>
          </View>
        </View>
      </View>

      <View style={styles.summaryRow}>
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={[styles.summaryIcon, { backgroundColor: theme.dangerBg }]}>
            <Icon name="alert" size={16} color={theme.danger} strokeWidth={2} />
          </View>
          <View>
            <Text style={[styles.summaryValue, { color: theme.text }]}>{criticalCount}</Text>
            <Text style={[styles.summaryLabel, { color: theme.textSub }]}>Prioridade alta</Text>
          </View>
        </View>
        <View style={[styles.summaryCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <View style={[styles.summaryIcon, { backgroundColor: theme.accentBg }]}>
            <Icon name="eye" size={16} color={theme.accent} strokeWidth={2} />
          </View>
          <View>
            <Text style={[styles.summaryValue, { color: theme.text }]}>{motionCount}</Text>
            <Text style={[styles.summaryLabel, { color: theme.textSub }]}>Movimentos</Text>
          </View>
        </View>
      </View>

      <View style={[styles.segments, { backgroundColor: theme.surfaceAlt }]}>
        {SEGMENTS.map((s) => {
          const on = s === segment;
          return (
            <Pressable
              key={s}
              onPress={() => setSegment(s)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[styles.segment, on && { backgroundColor: theme.surface }]}
            >
              <Text style={[styles.segmentText, { color: on ? theme.text : theme.textSub }]}>{s}</Text>
            </Pressable>
          );
        })}
      </View>

      {/* ERRO ≠ "TUDO TRANQUILO". Com a lista vazia POR FALHA, a tela afirmava
          que não havia alarme — numa central de monitoramento, é a mentira mais
          cara possível. Agora o erro tem cara de erro e oferece saída. */}
      {filtered.length === 0 && erro ? (
        <View style={[styles.empty, { borderColor: theme.danger }]}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.surface }]}>
            <Icon name="alert" size={24} color={theme.danger} strokeWidth={2.2} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.danger }]}>Não foi possível carregar</Text>
          <Text style={[styles.emptyText, { color: theme.textSub }]}>
            Isto é falha de comunicação — não quer dizer que não há alarmes.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Tentar carregar os alarmes novamente"
            onPress={onRefresh}
            style={[styles.retry, { borderColor: theme.border, backgroundColor: theme.surface }]}
          >
            <Text style={[styles.retryText, { color: theme.text }]}>Tentar novamente</Text>
          </Pressable>
        </View>
      ) : filtered.length === 0 ? (
        <View style={[styles.empty, { borderColor: theme.border }]}>
          <View style={[styles.emptyIcon, { backgroundColor: theme.surface }]}>
            <Icon name="check" size={24} color={theme.success} strokeWidth={2.2} />
          </View>
          <Text style={[styles.emptyTitle, { color: theme.text }]}>Tudo tranquilo</Text>
          <Text style={[styles.emptyText, { color: theme.textSub }]}>Nenhum alarme nesta categoria.</Text>
        </View>
      ) : (
        <View style={{ gap: 11 }}>
          {filtered.map((alarm) => (
            <AlarmCard
              key={alarm.id}
              alarm={alarm}
              highlighted={alarm.id === highlightedAlarmId}
              canManage={canManage}
              onAck={() => onAck(alarm)}
              onResolve={() => onResolve(alarm)}
              onOpen={() => alarm.cameraId && onOpenCamera(alarm.cameraId)}
            />
          ))}
        </View>
      )}
    </ScrollView>
  );
}

function AlarmCard({
  alarm, highlighted, canManage, onAck, onResolve, onOpen,
}: { alarm: Alarm; highlighted?: boolean; canManage: boolean; onAck: () => void; onResolve: () => void; onOpen: () => void }) {
  const { theme } = useTheme();
  const ago = timeAgo(alarm.occurredAt);
  const label = alarm.title || alarm.type;
  const sub = alarm.cameraName || alarm.message || '—';

  const acked = alarm.status === 'ACKED';
  const offline = alarm.type.includes('OFFLINE') || alarm.type.includes('SIGNAL');
  const motion = alarm.type.includes('MOTION');

  if (alarm.status === 'RESOLVED') {
    return (
      <Pressable onPress={onOpen} style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border, opacity: 0.62 }]}>
        <View style={styles.cardBody}>
          <View style={[styles.motionIcon, { backgroundColor: 'rgba(34,197,94,0.14)' }]}>
            <Icon name="check" size={18} color={theme.success} strokeWidth={2.2} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.cardTopRow}>
              <Text style={[styles.cardType, { color: theme.text }]} numberOfLines={1}>
                {label || 'Detecção de Movimento'}
              </Text>
              <Text style={[styles.cardAgo, { color: theme.textMuted }]}>{ago}</Text>
            </View>
            <Text style={[styles.cardLoc, { color: theme.textSub }]} numberOfLines={1}>
              {sub}{alarm.acknowledgedByUserName ? ` · ${alarm.acknowledgedByUserName}` : ''}
            </Text>
          </View>
        </View>
      </Pressable>
    );
  }

  // Reconhecido segue a cor principal da marca; aberto é vermelho (semântico).
  const borderColor = acked ? (withAlpha(theme.accent, 0.28) ?? theme.border) : 'rgba(239,68,68,0.28)';
  const accentColor = acked ? theme.accent : '#ef4444';
  const iconBg = acked ? (withAlpha(theme.accent, 0.14) ?? theme.accentBg) : 'rgba(239,68,68,0.12)';

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: highlighted ? theme.accent : borderColor }]}>
      <View style={[styles.stripe, { backgroundColor: accentColor }]} />
      <View style={styles.cardInner}>
        <Pressable style={styles.cardBody} onPress={onOpen}>
          <View style={[styles.motionIcon, { backgroundColor: iconBg }]}>
            <Icon name={offline ? 'videoOff' : motion ? 'eye' : 'alert'} size={20} color={accentColor} strokeWidth={2} />
          </View>
          <View style={{ flex: 1 }}>
            <View style={styles.cardTopRow}>
              <View style={styles.cardTitleWrap}>
                <Text style={[styles.cardType, { color: theme.text }]} numberOfLines={1}>
                  {label || 'Detecção de Movimento'}
                </Text>
                {alarm.priority ? (
                  <View style={[styles.priorityPill, { backgroundColor: ['P1', 'P2'].includes(alarm.priority) ? theme.dangerBg : theme.surfaceAlt }]}>
                    <Text style={[styles.priorityText, { color: ['P1', 'P2'].includes(alarm.priority) ? theme.danger : theme.textSub }]}>{alarm.priority}</Text>
                  </View>
                ) : null}
              </View>
              <Text style={[styles.cardAgo, { color: theme.textMuted }]}>{ago}</Text>
            </View>
            <Text style={[styles.cardLoc, { color: theme.textSub }]} numberOfLines={1}>
              {sub}{acked ? ' · Reconhecido' : ''}
            </Text>
          </View>
          {alarm.cameraId ? (
            <View style={[styles.openCamBtn, { borderColor: theme.border }]}>
              <Icon name="camera" size={15} color={theme.textSub} strokeWidth={1.8} />
            </View>
          ) : null}
        </Pressable>
        {canManage ? (
          <View style={styles.actions}>
            {!acked ? (
              <Pressable
                onPress={onAck}
                accessibilityRole="button"
                style={[styles.actionGhost, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}
              >
                <Text style={[styles.actionGhostText, { color: theme.text }]}>Reconhecer</Text>
              </Pressable>
            ) : null}
            <Pressable style={styles.actionPrimaryWrap} onPress={onResolve}>
              <LinearGradient colors={[theme.accent, theme.accentDark]} style={styles.actionPrimary}>
                <Text style={styles.actionPrimaryText}>Resolver</Text>
              </LinearGradient>
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 24, gap: 16 },
  header: { marginTop: 10 },
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  headerIcon: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  title: { fontSize: 24, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  summaryRow: { flexDirection: 'row', gap: 10 },
  summaryCard: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, padding: 11 },
  summaryIcon: { width: 34, height: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  summaryValue: { fontSize: 16, lineHeight: 18, fontWeight: '900' },
  summaryLabel: { fontSize: 9.5, fontWeight: '700' },
  segments: { flexDirection: 'row', borderRadius: 13, padding: 4, gap: 7 },
  segment: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 10, overflow: 'hidden' },
  segmentText: { fontSize: 12.5, fontWeight: '700' },
  card: { borderRadius: 18, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  stripe: { height: 3 },
  cardInner: { padding: 14 },
  cardBody: { flexDirection: 'row', gap: 12, alignItems: 'center' },
  motionIcon: { width: 46, height: 46, borderRadius: 14, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  openCamBtn: { width: 32, height: 32, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  cardTopRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  cardTitleWrap: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 6 },
  cardType: { fontSize: 13.5, fontWeight: '800', flex: 1 },
  priorityPill: { borderRadius: 7, paddingHorizontal: 6, paddingVertical: 2 },
  priorityText: { fontSize: 9, fontWeight: '900' },
  cardAgo: { fontSize: 11, fontWeight: '600' },
  cardLoc: { fontSize: 12.5, fontWeight: '600', marginTop: 2 },
  actions: { flexDirection: 'row', gap: 8, marginTop: 12 },
  actionGhost: { flex: 1, alignItems: 'center', paddingVertical: 9, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  actionGhostText: { fontSize: 12, fontWeight: '700' },
  actionPrimaryWrap: { flex: 1, borderRadius: 11, overflow: 'hidden' },
  actionPrimary: { paddingVertical: 9, alignItems: 'center' },
  actionPrimaryText: { color: '#fff', fontSize: 12, fontWeight: '800' },
  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 20, paddingVertical: 36, paddingHorizontal: 22, alignItems: 'center', gap: 10 },
  emptyIcon: { width: 50, height: 50, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  emptyTitle: { fontSize: 14.5, fontWeight: '800' },
  retry: { marginTop: 12, borderWidth: 1, borderRadius: 10, paddingHorizontal: 14, paddingVertical: 9 },
  retryText: { fontSize: 13, fontWeight: '600' },
  emptyText: { fontSize: 12.5, fontWeight: '500', textAlign: 'center' },
});
