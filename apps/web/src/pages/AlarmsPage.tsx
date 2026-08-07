import { useEffect, useMemo, useRef, useState } from 'react';
import axios from 'axios';
import { toast } from '../hooks/use-toast';
import { motion, AnimatePresence } from 'framer-motion';
import { format } from 'date-fns';
import { Link, useLocation } from 'wouter';
import {
  Bell, BellOff, CheckCheck, ChevronUp, ChevronDown,
  AlertTriangle, Flame, DoorOpen, Shield, MapPin,
  Volume2, VolumeX, ArrowRight, X, Clock, Settings2, Plus, Play, Pencil, Trash2, TriangleAlert, Filter,
  ChevronRight, MessageSquare
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip as ReTooltip, ResponsiveContainer } from 'recharts';
import { Switch } from '@/components/ui/switch';
import { useAlarmStore } from '../store/alarmStore';
import { useAuthStore } from '../store/authStore';
import { Alarm, Camera } from '../store/vmsDataStore';
import { getApiBaseUrl } from '../lib/api-base';

const PRIORITY_STYLES: Record<string, { badge: string; iconBg: string }> = {
  P1: {
    badge: 'bg-[hsl(354_52%_52%_/_0.12)] text-[hsl(354,52%,68%)] border-[hsl(354_52%_52%_/_0.35)]',
    iconBg: 'bg-[hsl(354_52%_52%_/_0.10)] text-[hsl(354,52%,65%)]',
  },
  P2: {
    badge: 'bg-[hsl(22_60%_54%_/_0.12)]  text-[hsl(22,60%,68%)]  border-[hsl(22_60%_54%_/_0.35)]',
    iconBg: 'bg-[hsl(22_60%_54%_/_0.10)]  text-[hsl(22,60%,65%)]',
  },
  P3: {
    badge: 'bg-[hsl(38_58%_54%_/_0.12)]  text-[hsl(38,58%,68%)]  border-[hsl(38_58%_54%_/_0.35)]',
    iconBg: 'bg-[hsl(38_58%_54%_/_0.10)]  text-[hsl(38,58%,65%)]',
  },
  P4: {
    badge: 'bg-[hsl(213_65%_57%_/_0.10)] text-[hsl(213,65%,70%)] border-[hsl(213_65%_57%_/_0.28)]',
    iconBg: 'bg-[hsl(213_65%_57%_/_0.10)] text-[hsl(213,65%,68%)]',
  },
};

const TYPE_ICONS: Record<string, React.ElementType> = {
  intrusion: Shield,
  fire: Flame,
  access_violation: DoorOpen,
  camera_tampering: AlertTriangle,
  perimeter_breach: MapPin,
  panic_button: AlertTriangle,
  loitering: Clock,
};

type AlarmRule = {
  id: string;
  name: string;
  source: 'MOTION' | 'STREAM' | 'HEALTH' | 'ANALYTICS';
  eventType: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  isEnabled: boolean;
  dedupWindowSeconds: number;
  autoResolveOnRecovery: boolean;
  notifyOnOpen: boolean;
  webhookUrl: string | null;
  emailTo: string | null;
  createdAt: string;
  updatedAt: string;
};

type RuleFormState = {
  id?: string;
  name: string;
  source: AlarmRule['source'];
  eventType: string;
  priority: AlarmRule['priority'];
  dedupWindowSeconds: number;
  autoResolveOnRecovery: boolean;
  notifyOnOpen: boolean;
  webhookUrl: string;
  emailTo: string;
  isEnabled: boolean;
};

type AlarmApiItem = {
  id: string;
  cameraId: string;
  cameraName?: string | null;
  source: string;
  type: string;
  title: string;
  message: string;
  severity: string;
  priority: 'P1' | 'P2' | 'P3' | 'P4';
  status: 'OPEN' | 'ACKED' | 'RESOLVED';
  note?: string | null;
  occurredAt: string;
  acknowledgedAt?: string | null;
  acknowledgedByUserName?: string | null;
  lastNotificationStatus?: string | null;
  notificationDelivery?: Array<Record<string, unknown>>;
  transitionHistory?: Array<Record<string, unknown>>;
  isSnoozed?: boolean;
  snoozedUntil?: string | null;
  occurrenceCount?: number;
};

const API_URL = getApiBaseUrl();
const TOOLTIP_STYLE = {
  background: 'hsl(var(--popover))',
  border: '1px solid hsl(var(--border))',
  borderRadius: 4,
  fontSize: 11,
  color: 'hsl(var(--foreground))',
};

const P_COLORS: Record<string, string> = {
  P1: 'hsl(354,52%,52%)',
  P2: 'hsl(22,60%,54%)',
  P3: 'hsl(38,58%,54%)',
  P4: 'hsl(213,65%,57%)',
};

const ALARM_SOURCE_LABELS: Record<AlarmRule['source'], string> = {
  MOTION: 'Movimento',
  STREAM: 'Vídeo',
  HEALTH: 'Saúde',
  ANALYTICS: 'Análise',
};

const EMPTY_RULE_FORM: RuleFormState = {
  name: '',
  source: 'MOTION',
  eventType: '',
  priority: 'P3',
  dedupWindowSeconds: 30,
  autoResolveOnRecovery: true,
  notifyOnOpen: true,
  webhookUrl: '',
  emailTo: '',
  isEnabled: true,
};

function AlarmCard({ alarm, onAck, onResolve, onAddNote }: { alarm: Alarm; onAck: () => void; onResolve: () => void; onAddNote?: (note: string) => void }) {
  const [expanded, setExpanded] = useState(alarm.priority === 'P1');
  const [noteInput, setNoteInput] = useState('');
  const [showNoteInput, setShowNoteInput] = useState(false);
  const ps = PRIORITY_STYLES[alarm.priority];
  const Icon = TYPE_ICONS[alarm.type] ?? AlertTriangle;
  const isActiveP1 = alarm.priority === 'P1' && alarm.status === 'active';
  const statusLabel = alarm.status === 'active' ? 'Aberto' : alarm.status === 'acknowledged' ? 'Reconhecido' : 'Resolvido';

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: -8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, height: 0 }}
      className={`bg-card border rounded-lg overflow-hidden transition-shadow ${
        isActiveP1
          ? 'border-[hsl(354_52%_52%_/_0.4)] alarm-glow'
          : 'border-border'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-3 cursor-pointer select-none" onClick={() => setExpanded((e) => !e)}>
        <div className={`w-7 h-7 rounded flex items-center justify-center shrink-0 ${ps.iconBg}`}>
          <Icon className="w-3.5 h-3.5" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-[9px] px-1.5 py-0.5 rounded border font-bold ${ps.badge}`}>{alarm.priority}</span>
            <span className="text-[12px] font-semibold truncate">{alarm.name}</span>
          </div>
          <div className="flex items-center gap-2 mt-0.5">
            <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{alarm.zone}</span>
            <span className="text-[hsl(var(--border))]">·</span>
            <span className="font-mono text-[10px] text-[hsl(var(--muted-foreground))] tabular-nums">{format(new Date(alarm.triggeredAt), 'HH:mm:ss')}</span>
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className={`text-[9px] px-1.5 py-0.5 rounded border ${
            alarm.status === 'active'
              ? 'bg-[hsl(354_52%_52%_/_0.09)] text-[hsl(354,52%,65%)] border-[hsl(354_52%_52%_/_0.28)]'
              : alarm.status === 'acknowledged'
                ? 'bg-[hsl(38_58%_54%_/_0.09)]  text-[hsl(38,58%,65%)]  border-[hsl(38_58%_54%_/_0.28)]'
                : 'bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))] border-border'
          }`}>
            {statusLabel}
          </span>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" /> : <ChevronDown className="w-3.5 h-3.5 text-[hsl(var(--muted-foreground))]" />}
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18 }} className="overflow-hidden">
            <div className="px-4 pb-3 border-t border-border pt-3 space-y-3">
              <p className="text-[11px] text-[hsl(var(--muted-foreground))] leading-relaxed">{alarm.description}</p>
              <div className="grid grid-cols-2 gap-2 text-[10px] text-[hsl(var(--muted-foreground))]">
                <span>Ocorrências agrupadas: {alarm.occurrenceCount ?? 1}</span>
                <span>Última ocorrência: {alarm.lastOccurredAt ? format(new Date(alarm.lastOccurredAt), 'HH:mm:ss') : format(new Date(alarm.triggeredAt), 'HH:mm:ss')}</span>
              </div>
              {alarm.notes && (
                <div className="space-y-1">
                  <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Notas</p>
                  {alarm.notes.split('\n').map((n, i) => (
                    <p key={i} className="text-[11px] text-[hsl(var(--muted-foreground))] bg-[hsl(var(--muted))] px-3 py-1.5 rounded">{n}</p>
                  ))}
                </div>
              )}
              {/* ACCEPTED = push aceito pelo Expo, aguardando o receipt (estágio 2).
                  NÃO é falha — só ainda não é entrega provada. */}
              {alarm.lastNotificationStatus
                && alarm.lastNotificationStatus !== 'DELIVERED'
                && alarm.lastNotificationStatus !== 'ACCEPTED' && (
                <div className="rounded border border-[hsl(354_52%_52%_/_0.35)] bg-[hsl(354_52%_52%_/_0.10)] px-3 py-2">
                  <p className="text-[10px] font-semibold text-[hsl(354,52%,65%)] uppercase tracking-wider">Notificação com falha</p>
                  <p className="text-[11px] text-[hsl(354,52%,72%)] mt-1">
                    Último status: {alarm.lastNotificationStatus}
                  </p>
                </div>
              )}
              {Array.isArray(alarm.notificationDelivery) && alarm.notificationDelivery.length > 0 && (
                <details className="space-y-1.5 rounded border border-border bg-background/45 px-3 py-2">
                  <summary className="cursor-pointer text-[10px] font-semibold text-muted-foreground">Entrega de notificações</summary>
                  <div className="space-y-1">
                    {alarm.notificationDelivery.slice(-4).reverse().map((delivery, idx) => {
                      const channel = String(delivery?.channel ?? '-').toUpperCase();
                      const status = String(delivery?.status ?? '-').toUpperCase();
                      const reason = typeof delivery?.reason === 'string' ? delivery.reason : '';
                      const at = typeof delivery?.at === 'string' ? delivery.at : '';
                      const attempt = typeof delivery?.attempt === 'number' ? delivery.attempt : null;
                      const tone = status === 'DELIVERED'
                        ? 'border-[hsl(var(--status-online)_/_0.3)] bg-[hsl(var(--status-online)_/_0.1)] text-[hsl(var(--status-online))]'
                        : status === 'ACCEPTED'
                          ? 'border-border bg-[hsl(var(--muted))] text-[hsl(var(--muted-foreground))]'
                          : status === 'SKIPPED'
                          ? 'border-[hsl(var(--status-warning)_/_0.3)] bg-[hsl(var(--status-warning)_/_0.1)] text-[hsl(var(--status-warning))]'
                          : 'border-[hsl(var(--destructive)_/_0.3)] bg-[hsl(var(--destructive)_/_0.1)] text-[hsl(var(--destructive))]';
                      return (
                        <div key={`${channel}-${status}-${idx}`} className={`rounded border px-2 py-1 text-[10px] ${tone}`}>
                          <div className="flex items-center justify-between gap-2">
                            <span>{channel} · {status}</span>
                            <span className="font-mono">{at ? format(new Date(at), 'HH:mm:ss') : '--:--:--'}</span>
                          </div>
                          {(attempt != null || reason) && (
                            <div className="mt-0.5 text-[9px] opacity-90">
                              {attempt != null ? `tentativa ${attempt}` : ''}
                              {attempt != null && reason ? ' · ' : ''}
                              {reason || ''}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </details>
              )}
              {showNoteInput && (
                <div className="flex gap-2">
                  <input
                    value={noteInput}
                    onChange={(e) => setNoteInput(e.target.value)}
                    placeholder="Adicionar nota..."
                    className="flex-1 h-8 px-3 rounded border border-border bg-background text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && noteInput.trim()) {
                        onAddNote?.(noteInput.trim());
                        setNoteInput('');
                        setShowNoteInput(false);
                      }
                    }}
                  />
                  <button
                    onClick={() => {
                      if (noteInput.trim()) {
                        onAddNote?.(noteInput.trim());
                        setNoteInput('');
                        setShowNoteInput(false);
                      }
                    }}
                    className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs"
                  >
                    Adicionar
                  </button>
                </div>
              )}
              <div className="flex items-center gap-2">
                {alarm.status === 'active' && (
                  <button onClick={onAck} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-[11px] hover:bg-[hsl(var(--accent))] transition-colors">
                    <CheckCheck className="w-3 h-3" />
                    Reconhecer
                  </button>
                )}
                {alarm.status !== 'resolved' && (
                  <button onClick={onResolve} className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-[hsl(var(--primary)_/_0.08)] border border-[hsl(var(--primary)_/_0.25)] text-[hsl(var(--primary))] text-[11px] hover:bg-[hsl(var(--primary)_/_0.13)] transition-colors">
                    <X className="w-3 h-3" />
                    Resolver
                  </button>
                )}
                <button onClick={() => setShowNoteInput((s) => !s)} className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-[11px] hover:bg-[hsl(var(--accent))] transition-colors">
                  {showNoteInput ? 'Cancelar' : '+ Nota'}
                </button>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-border text-[11px] hover:bg-[hsl(var(--accent))] transition-colors ml-auto">
                  <ArrowRight className="w-3 h-3" />
                  Ver Câmera
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

export default function AlertasPage() {
  const { cameras, load } = useAlarmStore();
  const { accessToken } = useAuthStore();
  const [, setLocation] = useLocation();
  const [muted, setMuted] = useState(() => window.localStorage.getItem('drac:alarm-sound-muted') === '1');
  const seenAlarmIdsRef = useRef<Set<string> | null>(null);
  const backgroundRefreshInFlightRef = useRef(false);
  const [workspaceMode, setWorkspaceMode] = useState<'operation' | 'advanced'>('operation');
  const [selectedAlarmId, setSelectedAlarmId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [alarmItems, setAlarmItems] = useState<Alarm[]>([]);
  const [alarmsLoading, setAlarmsLoading] = useState(false);
  // "Atualizado às" + aviso de dado velho: sem isto a lista podia ficar
  // estagnada por horas sem nenhum sinal de que estava morta.
  const [ultimaAtualizacao, setUltimaAtualizacao] = useState<Date | null>(null);
  const [falhaDeFundo, setFalhaDeFundo] = useState(false);
  const [alarmsError, setAlarmsError] = useState<string | null>(null);
  const [cameraFilter, setCameraFilter] = useState('all');
  const [zoneFilter, setZoneFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<'all' | 'OPEN' | 'ACKED' | 'RESOLVED'>('all');
  const [priorityFilter, setPriorityFilter] = useState<'all' | 'P1' | 'P2' | 'P3' | 'P4'>('all');
  const [severityFilter, setSeverityFilter] = useState<'all' | 'CRITICAL' | 'WARNING' | 'INFO'>('all');
  const [sourceFilter, setSourceFilter] = useState<'all' | 'MOTION' | 'STREAM' | 'HEALTH' | 'ANALYTICS'>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [searchFilter, setSearchFilter] = useState('');

  // Quantos filtros do modo avançado continuam valendo (eles sobrevivem à
  // volta para o modo Operação, onde não havia nem indicador nem como limpar).
  const filtrosAtivosCount = [
    cameraFilter !== 'all', zoneFilter !== 'all', priorityFilter !== 'all',
    sourceFilter !== 'all', Boolean(fromFilter), Boolean(toFilter), Boolean(searchFilter.trim()),
  ].filter(Boolean).length;
  const limparFiltros = () => {
    setCameraFilter('all'); setZoneFilter('all'); setPriorityFilter('all');
    setSourceFilter('all'); setFromFilter(''); setToFilter(''); setSearchFilter('');
  };
  const [rules, setRules] = useState<AlarmRule[]>([]);
  const [rulesLoading, setRulesLoading] = useState(false);
  const [rulesError, setRulesError] = useState<string | null>(null);
  const [showRuleForm, setShowRuleForm] = useState(false);
  const [ruleForm, setRuleForm] = useState<RuleFormState>(EMPTY_RULE_FORM);
  const [savingRule, setSavingRule] = useState(false);
  const [deletingAllAlarms, setDeletingAllAlarms] = useState(false);
  const [apagarTudoAberto, setApagarTudoAberto] = useState(false);
  const [confirmApagarTudo, setConfirmApagarTudo] = useState('');
  const [simCameraId, setSimCameraId] = useState('');
  const [simSeverity, setSimSeverity] = useState('WARNING');
  const [runningSimulationId, setRunningSimulationId] = useState<string | null>(null);

  const client = useMemo(() => axios.create({
    baseURL: API_URL,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  }), [accessToken]);

  function mapApiAlarm(raw: AlarmApiItem): Alarm {
    return {
      id: raw.id,
      name: raw.title || `${raw.type} — ${raw.cameraName ?? 'Câmera'}`,
      type: raw.type,
      status: raw.status === 'RESOLVED' ? 'resolved' : raw.status === 'ACKED' ? 'acknowledged' : 'active',
      priority: raw.priority,
      triggeredAt: raw.occurredAt,
      acknowledgedAt: raw.acknowledgedAt ?? undefined,
      acknowledgedBy: raw.acknowledgedByUserName ?? undefined,
      cameraId: raw.cameraId,
      zone: cameras.find((c) => c.id === raw.cameraId)?.zone ?? 'Sem zona',
      description: raw.message,
      notes: raw.note ?? undefined,
      isSnoozed: Boolean(raw.isSnoozed),
      snoozedUntil: raw.snoozedUntil ?? undefined,
      transitionHistory: Array.isArray(raw.transitionHistory) ? raw.transitionHistory : [],
      notificationDelivery: Array.isArray(raw.notificationDelivery) ? raw.notificationDelivery : [],
      lastNotificationStatus: raw.lastNotificationStatus ?? undefined,
      occurrenceCount: typeof raw.occurrenceCount === 'number' ? raw.occurrenceCount : 1,
      lastOccurredAt: raw.occurredAt ?? raw.acknowledgedAt ?? undefined,
    };
  }

  async function loadAlarmsList(background = false) {
    if (!accessToken) return;
    if (background && backgroundRefreshInFlightRef.current) return;
    if (background) backgroundRefreshInFlightRef.current = true;
    if (!background) setAlarmsLoading(true);
    if (!background) setAlarmsError(null);
    try {
      const params: Record<string, string | number> = { limit: 300, offset: 0 };
      if (cameraFilter !== 'all') params.cameraId = cameraFilter;
      if (zoneFilter !== 'all') params.zone = zoneFilter;
      if (statusFilter !== 'all') params.status = statusFilter;
      if (priorityFilter !== 'all') params.priority = priorityFilter;
      if (severityFilter !== 'all') params.severity = severityFilter;
      if (sourceFilter !== 'all') params.source = sourceFilter;
      if (typeFilter !== 'all') params.type = typeFilter;
      if (fromFilter) params.from = new Date(fromFilter).toISOString();
      if (toFilter) params.to = new Date(toFilter).toISOString();
      const { data } = await client.get<{ items: AlarmApiItem[] }>('/cameras/alarms', { params });
      const mapped = (Array.isArray(data?.items) ? data.items : []).map(mapApiAlarm);
      setAlarmItems(mapped);
      setUltimaAtualizacao(new Date());
      setFalhaDeFundo(false);
    } catch (error) {
      // O refresh de 5s engolia o erro: a lista ficava estagnada com dados
      // antigos por tempo indeterminado, sem nada na tela dizendo isso.
      if (background) setFalhaDeFundo(true);
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao carregar alarmes.';
      if (!background) setAlarmsError(Array.isArray(msg) ? msg.join(' | ') : String(msg));
    } finally {
      if (background) backgroundRefreshInFlightRef.current = false;
      if (!background) setAlarmsLoading(false);
    }
  }

  useEffect(() => {
    void loadAlarmsList();
  }, [accessToken, cameraFilter, cameras, zoneFilter, statusFilter, priorityFilter, severityFilter, sourceFilter, typeFilter, fromFilter, toFilter]);

  useEffect(() => {
    if (!accessToken) return;
    const refresh = () => {
      if (document.visibilityState === 'visible') void loadAlarmsList(true);
    };
    const timer = window.setInterval(refresh, 5_000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [accessToken, cameraFilter, cameras, client, fromFilter, priorityFilter, severityFilter, sourceFilter, statusFilter, toFilter, typeFilter, zoneFilter]);

  useEffect(() => {
    const currentIds = new Set(alarmItems.map((alarm) => alarm.id));
    if (!seenAlarmIdsRef.current) {
      seenAlarmIdsRef.current = currentIds;
      return;
    }
    const hasNewUrgentAlarm = alarmItems.some((alarm) => (
      !seenAlarmIdsRef.current!.has(alarm.id)
      && alarm.status === 'active'
      && (alarm.priority === 'P1' || alarm.priority === 'P2')
      && Date.now() - new Date(alarm.triggeredAt).getTime() < 30_000
    ));
    for (const id of currentIds) seenAlarmIdsRef.current.add(id);
    if (muted || !hasNewUrgentAlarm) return;

    const AudioContextCtor = window.AudioContext ?? (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioContextCtor) return;
    const context = new AudioContextCtor();
    void context.resume().then(() => {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.frequency.setValueAtTime(880, context.currentTime);
      gain.gain.setValueAtTime(0.0001, context.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, context.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start();
      oscillator.stop(context.currentTime + 0.36);
      oscillator.addEventListener('ended', () => void context.close(), { once: true });
    }).catch(() => void context.close());
  }, [alarmItems, muted]);

  function toggleAlarmSound() {
    setMuted((current) => {
      const next = !current;
      window.localStorage.setItem('drac:alarm-sound-muted', next ? '1' : '0');
      return next;
    });
  }

  const zoneOptions = useMemo(() => ['all', ...Array.from(new Set(cameras.map((camera) => camera.zone))).sort()], [cameras]);

  const typeOptions = useMemo(() => {
    const fromAlarms = alarmItems.map((item) => item.type).filter(Boolean);
    return ['all', ...Array.from(new Set(fromAlarms)).sort()];
  }, [alarmItems]);

  const visibleAlarms = useMemo(() => {
    const query = searchFilter.trim().toLowerCase();
    if (!query) return alarmItems;
    return alarmItems.filter((alarm) =>
      alarm.name.toLowerCase().includes(query) ||
      alarm.description.toLowerCase().includes(query) ||
      alarm.type.toLowerCase().includes(query) ||
      alarm.zone.toLowerCase().includes(query),
    );
  }, [alarmItems, searchFilter]);

  const alarmStats = Object.entries(visibleAlarms.reduce<Record<string, number>>((acc, alarm) => {
    acc[alarm.zone] = (acc[alarm.zone] ?? 0) + 1;
    return acc;
  }, {})).map(([zone, count]) => ({ zone, count }));

  const activeAlertas = visibleAlarms.filter((a) => a.status === 'active').sort((a, b) => {
    const order = { P1: 0, P2: 1, P3: 2, P4: 3 };
    return order[a.priority] - order[b.priority];
  });
  const ackAlertas = visibleAlarms.filter((a) => a.status === 'acknowledged');
  const resolvedAlertas = visibleAlarms.filter((a) => a.status === 'resolved');

  async function loadRules() {
    if (!accessToken) return;
    setRulesLoading(true);
    setRulesError(null);
    try {
      const { data } = await client.get<{ items: AlarmRule[] }>('/alarms/rules');
      setRules(Array.isArray(data?.items) ? data.items : []);
    } catch (error) {
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao carregar regras.';
      setRulesError(Array.isArray(msg) ? msg.join(' | ') : String(msg));
    } finally {
      setRulesLoading(false);
    }
  }

  useEffect(() => {
    void loadRules();
  }, [accessToken]);

  async function handleAcknowledgeAlarm(id: string) {
    await client.post(`/cameras/alarms/${id}/ack`, {});
    await loadAlarmsList();
    await load();
  }

  async function handleResolveAlarm(id: string) {
    await client.post(`/cameras/alarms/${id}/resolve`, {});
    await loadAlarmsList();
    await load();
  }

  async function handleAddAlarmNote(id: string, note: string) {
    await client.post(`/cameras/alarms/${id}/note`, { note });
    await loadAlarmsList();
    await load();
  }

  async function handleDeleteAllAlarms() {
    // O endpoint apaga TODOS os alarmes do sistema — não os da lista filtrada.
    // O botão, porém, era habilitado pela lista visível: filtrar "Câmera 3" e
    // ver 12 itens fazia parecer que 12 seriam apagados. Agora a confirmação
    // declara o alcance real e exige digitação, como já se exige para esvaziar
    // um bucket. (O diálogo é aberto pelo botão; esta função só executa.)
    setDeletingAllAlarms(true);
    try {
      await client.delete('/cameras/alarms');
      setAlarmItems([]);
      await loadAlarmsList();
      await load();
    } catch (error) {
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao apagar alertas.';
      toast({ title: 'Não foi possível apagar', description: Array.isArray(msg) ? msg.join(' | ') : String(msg), variant: 'destructive' });
    } finally {
      setDeletingAllAlarms(false);
    }
  }

  function openCreateRule() {
    setRuleForm(EMPTY_RULE_FORM);
    setShowRuleForm(true);
  }

  function openEditRule(rule: AlarmRule) {
    setRuleForm({
      id: rule.id,
      name: rule.name,
      source: rule.source,
      eventType: rule.eventType,
      priority: rule.priority,
      dedupWindowSeconds: rule.dedupWindowSeconds,
      autoResolveOnRecovery: rule.autoResolveOnRecovery,
      notifyOnOpen: rule.notifyOnOpen,
      webhookUrl: rule.webhookUrl ?? '',
      emailTo: rule.emailTo ?? '',
      isEnabled: rule.isEnabled,
    });
    setShowRuleForm(true);
  }

  async function saveRule() {
    if (!ruleForm.name.trim() || !ruleForm.eventType.trim()) return;
    setSavingRule(true);
    try {
      const payload = {
        name: ruleForm.name.trim(),
        source: ruleForm.source,
        eventType: ruleForm.eventType.trim().toUpperCase(),
        priority: ruleForm.priority,
        dedupWindowSeconds: Number(ruleForm.dedupWindowSeconds),
        autoResolveOnRecovery: ruleForm.autoResolveOnRecovery,
        notifyOnOpen: ruleForm.notifyOnOpen,
        webhookUrl: ruleForm.webhookUrl.trim() || undefined,
        emailTo: ruleForm.emailTo.trim() || undefined,
        isEnabled: ruleForm.isEnabled,
      };

      if (ruleForm.id) {
        await client.patch(`/alarms/rules/${ruleForm.id}`, payload);
        await client.patch(`/alarms/rules/${ruleForm.id}/enabled`, { isEnabled: ruleForm.isEnabled });
      } else {
        await client.post('/alarms/rules', payload);
      }

      setShowRuleForm(false);
      await loadRules();
    } catch (error) {
      const msg = axios.isAxiosError(error) ? (error.response?.data?.message || error.message) : 'Falha ao salvar regra.';
      toast({ title: 'Não foi possível salvar a regra', description: Array.isArray(msg) ? msg.join(' | ') : String(msg), variant: 'destructive' });
    } finally {
      setSavingRule(false);
    }
  }

  async function toggleRuleEnabled(rule: AlarmRule) {
    try {
      await client.patch(`/alarms/rules/${rule.id}/enabled`, { isEnabled: !rule.isEnabled });
      await loadRules();
    } catch {
      toast({ title: 'Não foi possível alterar a regra', variant: 'destructive' });
    }
  }

  async function runSimulation(rule: AlarmRule) {
    const cameraId = simCameraId || cameras[0]?.id;
    if (!cameraId) {
      toast({ title: 'Selecione uma câmera para simular', variant: 'destructive' });
      return;
    }

    setRunningSimulationId(rule.id);
    try {
      await client.post(`/alarms/rules/${rule.id}/simulate`, {
        cameraId,
        eventType: rule.eventType,
        severity: simSeverity,
        message: `Simulação manual da regra ${rule.name}`,
      });
      await load();
      toast({ title: 'Simulação executada' });
    } catch {
      toast({ title: 'Falha ao simular a regra', variant: 'destructive' });
    } finally {
      setRunningSimulationId(null);
    }
  }

  const selectedAlarm = visibleAlarms.find((alarm) => alarm.id === selectedAlarmId)
    ?? activeAlertas[0]
    ?? ackAlertas[0]
    ?? visibleAlarms[0]
    ?? null;
  const selectedCamera = selectedAlarm
    ? cameras.find((camera) => camera.id === selectedAlarm.cameraId) ?? null
    : null;

  if (workspaceMode === 'operation') {
    const statusTabs = [
      { value: 'OPEN' as const, label: 'Ativos', count: activeAlertas.length },
      { value: 'ACKED' as const, label: 'Reconhecidos', count: ackAlertas.length },
      { value: 'RESOLVED' as const, label: 'Resolvidos', count: resolvedAlertas.length },
    ];

    return (
      <div className="flex h-full min-h-0 flex-col">
        <div className="px-3 sm:px-6 py-3 border-b border-border shrink-0 flex items-center gap-2">
          {/* FRESCOR DO DADO. A lista se atualiza a cada 5s em segundo plano;
              sem este carimbo, uma falha silenciosa deixava o operador olhando
              um retrato morto sem nenhuma forma de perceber. */}
          <div className="mr-auto flex items-center gap-2 text-[11px]">
            {falhaDeFundo ? (
              <span className="inline-flex items-center gap-1.5 rounded border border-[hsl(var(--destructive)_/_0.35)] bg-[hsl(var(--destructive)_/_0.08)] px-2 py-1 text-[hsl(var(--destructive))]">
                <TriangleAlert className="h-3 w-3" />
                Sem contato com o servidor — dados de {ultimaAtualizacao ? format(ultimaAtualizacao, 'HH:mm:ss') : 'antes'}
              </span>
            ) : ultimaAtualizacao ? (
              <span className="font-mono tabular-nums text-muted-foreground">
                atualizado às {format(ultimaAtualizacao, 'HH:mm:ss')}
              </span>
            ) : null}
          </div>
          {/* FILTROS ATIVOS: continuavam valendo ao voltar do modo avançado,
              sem indicador nem forma de limpar — o operador passava o turno
              vendo tela vazia achando que não havia ocorrência. */}
          {filtrosAtivosCount > 0 && (
            <button
              onClick={limparFiltros}
              className="btn btn-secondary btn-sm"
              title="Remover todos os filtros aplicados no modo avançado" aria-label="Remover todos os filtros aplicados no modo avançado"
            >
              <Filter className="h-3.5 w-3.5" />
              {filtrosAtivosCount} filtro(s) ativo(s) · limpar
            </button>
          )}
          <button
            onClick={() => setWorkspaceMode('advanced')}
            className="btn btn-secondary btn-sm"
          >
            <Settings2 className="h-3.5 w-3.5" /> Filtros e regras
          </button>
          <button
            onClick={toggleAlarmSound}
            className="btn btn-secondary btn-sm btn-icon"
            title={muted ? 'Ativar som' : 'Silenciar alertas'} aria-label={muted ? 'Ativar som' : 'Silenciar alertas'}
          >
            {muted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col md:flex-row">
          <aside className="flex max-h-56 w-full shrink-0 flex-col overflow-hidden border-b border-border bg-card md:max-h-none md:w-72 md:border-b-0 md:border-r">
            <div className="flex shrink-0 items-center gap-1 border-b border-border px-3 py-2">
              {statusTabs.map((tab) => (
                <button
                  key={tab.value}
                  onClick={() => setStatusFilter(tab.value)}
                  className={`h-7 flex-1 rounded-md text-[10px] font-medium transition-colors ${
                    statusFilter === tab.value
                      ? 'bg-accent text-foreground'
                      : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {tab.label}
                  {tab.count > 0 && <span className="ml-1 font-mono opacity-60">{tab.count}</span>}
                </button>
              ))}
            </div>
            <div className="flex-1 divide-y divide-border/60 overflow-y-auto">
              {alarmsLoading && !visibleAlarms.length && (
                <div className="p-5 text-center text-xs text-muted-foreground">Carregando alarmes...</div>
              )}
              {/* ERRO ≠ VAZIO. Antes, com a API fora, o operador lia "Nenhum
                  alarme neste status" às 2h da manhã e concluía que a noite
                  estava tranquila — o erro só era mostrado num acordeão
                  recolhido da OUTRA tela. */}
              {!alarmsLoading && !visibleAlarms.length && (alarmsError || falhaDeFundo) && (
                <div className="flex h-36 flex-col items-center justify-center gap-2 px-4 text-center">
                  <TriangleAlert className="h-6 w-6 text-[hsl(var(--destructive))]" />
                  <p className="text-xs text-[hsl(var(--destructive))]">
                    Não foi possível carregar os alarmes
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    Isto é falha de comunicação — não quer dizer que não há alarmes.
                  </p>
                  <button type="button" onClick={() => void loadAlarmsList(false)} className="btn btn-secondary btn-sm mt-1">
                    Tentar novamente
                  </button>
                </div>
              )}
              {!alarmsLoading && !visibleAlarms.length && !alarmsError && !falhaDeFundo && (
                <div className="flex h-36 flex-col items-center justify-center gap-2 text-muted-foreground">
                  <BellOff className="h-6 w-6 opacity-30" />
                  <p className="text-xs">Nenhum alarme neste status</p>
                </div>
              )}
              {visibleAlarms.map((alarm) => {
                const selected = selectedAlarm?.id === alarm.id;
                return (
                  <button
                    key={alarm.id}
                    onClick={() => setSelectedAlarmId(alarm.id)}
                    className={`w-full border-l-2 px-4 py-3 text-left transition-colors ${
                      selected
                        ? 'border-l-primary bg-accent'
                        : 'border-l-transparent hover:bg-accent/60'
                    }`}
                  >
                    <div className="mb-1 flex items-start justify-between gap-2">
                      <span className="min-w-0 flex-1 text-[12.5px] font-semibold leading-snug">{alarm.name}</span>
                      <span className={`shrink-0 font-mono text-[9px] font-bold ${PRIORITY_STYLES[alarm.priority].badge.split(' ')[1]}`}>
                        {alarm.priority}
                      </span>
                    </div>
                    <div className="text-[10px] text-muted-foreground">{alarm.zone}</div>
                    <div className="mt-0.5 font-mono text-[9px] text-muted-foreground/60">
                      {format(new Date(alarm.triggeredAt), 'dd/MM/yyyy HH:mm:ss')}
                    </div>
                  </button>
                );
              })}
            </div>
          </aside>

          <section className="min-w-0 flex-1 overflow-y-auto">
            {!selectedAlarm ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-muted-foreground">
                <Bell className="h-10 w-10 opacity-20" />
                <p className="text-sm">Selecione um alarme para ver detalhes</p>
              </div>
            ) : (
              <div className="flex max-w-3xl flex-col gap-5 p-4 sm:p-6">
                <div>
                  <div className="mb-2 flex flex-wrap items-center gap-2">
                    <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] font-semibold ${PRIORITY_STYLES[selectedAlarm.priority].badge}`}>
                      {selectedAlarm.priority}
                    </span>
                    <span className="rounded border border-border bg-muted/50 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {selectedAlarm.status === 'active' ? 'Ativo' : selectedAlarm.status === 'acknowledged' ? 'Reconhecido' : 'Resolvido'}
                    </span>
                  </div>
                  <h2 className="text-[18px] font-semibold tracking-tight">{selectedAlarm.name}</h2>
                  <p className="mt-1 text-[12px] leading-relaxed text-muted-foreground">{selectedAlarm.description}</p>
                </div>

                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {[
                    ['Câmera', selectedCamera?.name ?? selectedAlarm.cameraId],
                    ['Zona', selectedAlarm.zone],
                    ['Registrado', format(new Date(selectedAlarm.triggeredAt), 'dd/MM/yyyy HH:mm:ss')],
                    ['Tipo', selectedAlarm.type],
                  ].map(([label, value]) => (
                    <div key={label} className="ops-card rounded-lg p-3">
                      <div className="mb-1 font-mono text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
                      <div className="truncate text-[12.5px] font-medium">{value}</div>
                    </div>
                  ))}
                </div>

                {selectedCamera && (
                  <Link
                    href={`/playback?cameraId=${encodeURIComponent(selectedCamera.id)}&at=${encodeURIComponent(selectedAlarm.triggeredAt)}`}
                    className="flex w-full items-center gap-3 rounded-lg border border-border px-4 py-3 text-left transition-colors hover:bg-accent"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] font-medium">Ver reprodução: {selectedCamera.name}</div>
                      <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">{selectedCamera.ipAddress} · {selectedCamera.resolution}</div>
                    </div>
                    <ChevronRight className="h-4 w-4 shrink-0 text-muted-foreground" />
                  </Link>
                )}

                {selectedAlarm.notes && (
                  <div className="rounded-lg border border-border bg-muted/30 p-3">
                    <div className="mb-1.5 flex items-center gap-2">
                      <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
                      <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground">Notas</span>
                    </div>
                    <p className="whitespace-pre-line text-[12px] text-muted-foreground">{selectedAlarm.notes}</p>
                  </div>
                )}

                {selectedAlarm.status !== 'resolved' && (
                  <div className="space-y-3 pt-1">
                    <textarea
                      value={noteDraft}
                      onChange={(event) => setNoteDraft(event.target.value)}
                      placeholder="Adicionar nota opcional..."
                      className="h-20 w-full resize-none rounded-lg border border-border bg-background p-3 text-xs outline-none focus:ring-1 focus:ring-primary"
                    />
                    <div className="flex flex-wrap items-center gap-2">
                      {selectedAlarm.status === 'active' && (
                        <button
                          onClick={() => void handleAcknowledgeAlarm(selectedAlarm.id)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-primary px-3 text-[11px] font-medium text-primary-foreground"
                        >
                          <CheckCheck className="h-3.5 w-3.5" /> Reconhecer
                        </button>
                      )}
                      {noteDraft.trim() && (
                        <button
                          onClick={() => {
                            void handleAddAlarmNote(selectedAlarm.id, noteDraft.trim());
                            setNoteDraft('');
                          }}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-border px-3 text-[11px] hover:bg-accent"
                        >
                          <MessageSquare className="h-3.5 w-3.5" /> Adicionar nota
                        </button>
                      )}
                      <button
                        onClick={() => void handleResolveAlarm(selectedAlarm.id)}
                        className="ml-auto inline-flex h-8 items-center gap-1.5 rounded-lg border border-destructive/30 px-3 text-[11px] text-destructive hover:bg-destructive/10"
                      >
                        <X className="h-3.5 w-3.5" /> Resolver
                      </button>
                    </div>
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Page header */}
      <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end gap-2">
          <button
            onClick={() => setWorkspaceMode('operation')}
            className="btn btn-secondary btn-sm"
          >
            <ArrowRight className="h-3.5 w-3.5 rotate-180" />
            Voltar à operação
          </button>
          <button
            onClick={() => { setConfirmApagarTudo(''); setApagarTudoAberto(true); }}
            disabled={deletingAllAlarms}
            className="btn btn-sm border-[hsl(var(--destructive)_/_0.35)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.08)] disabled:opacity-45"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {deletingAllAlarms ? 'Apagando...' : 'Apagar todo o histórico'}
          </button>
          <button
            onClick={toggleAlarmSound}
            className={`btn btn-sm ${
              muted
                ? 'border-[hsl(38_58%_54%_/_0.4)] text-[hsl(38,58%,62%)] bg-[hsl(38_58%_54%_/_0.07)]'
                : 'btn-secondary'
            }`}
          >
            {muted ? <VolumeX className="w-3.5 h-3.5" /> : <Volume2 className="w-3.5 h-3.5" />}
            {muted ? 'Ativar som dos alertas' : 'Silenciar alertas'}
          </button>
      </div>
      <div className="flex-1 overflow-y-auto p-5 space-y-5 min-w-0">

        <details className="bg-card border border-border rounded-xl p-4 space-y-3">
          <summary className="cursor-pointer text-[12px] font-semibold">Filtros avançados</summary>
          <div className="mt-3 space-y-3">
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-4 gap-2">
            <select value={cameraFilter} onChange={(e) => setCameraFilter(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="all">Todas as câmeras</option>
              {cameras.map((camera) => (
                <option key={camera.id} value={camera.id}>{camera.name}</option>
              ))}
            </select>
            <select value={zoneFilter} onChange={(e) => setZoneFilter(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              {zoneOptions.map((zone) => (
                <option key={zone} value={zone}>{zone === 'all' ? 'Todas as zonas' : zone}</option>
              ))}
            </select>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as typeof statusFilter)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="all">Todos os status</option>
              <option value="OPEN">Abertos</option>
              <option value="ACKED">Reconhecidos</option>
              <option value="RESOLVED">Resolvidos</option>
            </select>
            <select value={priorityFilter} onChange={(e) => setPriorityFilter(e.target.value as typeof priorityFilter)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="all">Todas prioridades</option>
              <option value="P1">P1</option>
              <option value="P2">P2</option>
              <option value="P3">P3</option>
              <option value="P4">P4</option>
            </select>
            <select value={severityFilter} onChange={(e) => setSeverityFilter(e.target.value as typeof severityFilter)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="all">Todas severidades</option>
              <option value="CRITICAL">Crítica</option>
              <option value="WARNING">Atenção</option>
              <option value="INFO">Informativa</option>
            </select>
            <select value={sourceFilter} onChange={(e) => setSourceFilter(e.target.value as typeof sourceFilter)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="all">Todas as fontes</option>
              <option value="MOTION">Movimento</option>
              <option value="STREAM">Vídeo</option>
              <option value="HEALTH">Saúde</option>
              <option value="ANALYTICS">Análise</option>
            </select>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              {typeOptions.map((type) => (
                <option key={type} value={type}>{type === 'all' ? 'Todos os tipos' : type}</option>
              ))}
            </select>
            <input type="datetime-local" value={fromFilter} onChange={(e) => setFromFilter(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs" />
            <input type="datetime-local" value={toFilter} onChange={(e) => setToFilter(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs" />
          </div>
          <div className="flex items-center gap-2">
            <input value={searchFilter} onChange={(e) => setSearchFilter(e.target.value)} placeholder="Buscar por nome, tipo, zona ou descrição..." className="h-8 px-3 rounded border border-border bg-background text-xs flex-1" />
            <button onClick={() => void loadAlarmsList()} className="h-8 px-3 rounded border border-border text-xs">Atualizar alarmes</button>
          </div>
          {(alarmsLoading || alarmsError) && (
            <div className="text-[11px]">
              {alarmsLoading && <span className="text-muted-foreground">Carregando alarmes...</span>}
              {alarmsError && <span className="text-[hsl(354,52%,62%)]">{alarmsError}</span>}
            </div>
          )}
          </div>
        </details>

        <details className="bg-card border border-border rounded-xl p-4 space-y-3">
          <summary className="cursor-pointer text-[12px] font-semibold">Regras e simulação</summary>
          <div className="mt-3 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 text-[12px] font-semibold">
              <Settings2 className="w-4 h-4" />
              Regras de Alarme
            </div>
            <button onClick={openCreateRule} className="h-8 px-3 rounded bg-primary text-primary-foreground text-xs font-medium inline-flex items-center gap-1.5">
              <Plus className="w-3.5 h-3.5" /> Nova regra
            </button>
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <select value={simCameraId} onChange={(e) => setSimCameraId(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="">Câmera padrão (primeira)</option>
              {cameras.map((camera: Camera) => (
                <option key={camera.id} value={camera.id}>{camera.name}</option>
              ))}
            </select>
            <select value={simSeverity} onChange={(e) => setSimSeverity(e.target.value)} className="h-8 px-2 rounded border border-border bg-background text-xs">
              <option value="INFO">Informativa</option>
              <option value="WARNING">Atenção</option>
              <option value="CRITICAL">Crítica</option>
            </select>
            <button onClick={() => void loadRules()} className="h-8 px-3 rounded border border-border text-xs">Atualizar regras</button>
            {rulesLoading && <span className="text-[11px] text-muted-foreground">Carregando...</span>}
            {rulesError && <span className="text-[11px] text-[hsl(354,52%,62%)]">{rulesError}</span>}
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[11px]">
              <thead>
                <tr className="border-b border-border text-[hsl(var(--muted-foreground))]">
                  {['Nome', 'Origem', 'Evento', 'Prioridade', 'Dedup(s)', 'Notificação', 'Status', 'Ações'].map((h) => (
                    <th key={h} className="px-2 py-2 text-left font-medium">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {rules.map((rule) => (
                  <tr key={rule.id}>
                    <td className="px-2 py-2 font-medium">{rule.name}</td>
                    <td className="px-2 py-2">{ALARM_SOURCE_LABELS[rule.source] ?? rule.source}</td>
                    <td className="px-2 py-2 text-muted-foreground">{rule.eventType}</td>
                    <td className="px-2 py-2"><span className={`font-mono px-1.5 py-0.5 rounded border ${PRIORITY_STYLES[rule.priority].badge}`}>{rule.priority}</span></td>
                    <td className="px-2 py-2">{rule.dedupWindowSeconds}</td>
                    <td className="px-2 py-2">{rule.notifyOnOpen ? 'Ativa' : 'Desativada'}</td>
                    <td className="px-2 py-2">{rule.isEnabled ? 'Habilitada' : 'Desabilitada'}</td>
                    <td className="px-2 py-2">
                      <div className="flex items-center gap-1">
                        <button onClick={() => openEditRule(rule)} className="h-7 px-2 rounded border border-border inline-flex items-center gap-1"><Pencil className="w-3 h-3" />Editar</button>
                        <button onClick={() => void toggleRuleEnabled(rule)} className="h-7 px-2 rounded border border-border">{rule.isEnabled ? 'Desabilitar' : 'Habilitar'}</button>
                        <button onClick={() => void runSimulation(rule)} disabled={runningSimulationId === rule.id} className="h-7 px-2 rounded border border-border inline-flex items-center gap-1 disabled:opacity-50">
                          <Play className="w-3 h-3" />Simular
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {!rules.length && !rulesLoading && (
                  <tr>
                    <td colSpan={8} className="px-2 py-4 text-center text-muted-foreground">Nenhuma regra cadastrada.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          </div>
        </details>

        {activeAlertas.length > 0 ? (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-[hsl(354,52%,62%)] flex items-center gap-2">
              <Bell className="w-3 h-3" />Ativos ({activeAlertas.length})
            </div>
            <AnimatePresence>
              {activeAlertas.map((alarm) => (
                <AlarmCard key={alarm.id} alarm={alarm} onAck={() => void handleAcknowledgeAlarm(alarm.id)} onResolve={() => void handleResolveAlarm(alarm.id)} onAddNote={(note) => void handleAddAlarmNote(alarm.id, note)} />
              ))}
            </AnimatePresence>
          </div>
        ) : (
          <div className="bg-card border border-border rounded-xl p-8 text-center">
            <Bell className="w-7 h-7 text-[hsl(var(--chart-3))] mx-auto mb-3 opacity-60" />
            <div className="text-[13px] font-semibold text-[hsl(var(--chart-3))]">Tudo normal</div>
            <div className="text-[11px] text-[hsl(var(--muted-foreground))] mt-1">Não há alarmes ativos</div>
          </div>
        )}

        {ackAlertas.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))] flex items-center gap-2">
              <CheckCheck className="w-3 h-3" />Reconhecidos ({ackAlertas.length > 5 ? `mostrando 5 de ${ackAlertas.length}` : ackAlertas.length})
            </div>
            {ackAlertas.slice(0, 5).map((alarm) => (
              <AlarmCard key={alarm.id} alarm={alarm} onAck={() => void handleAcknowledgeAlarm(alarm.id)} onResolve={() => void handleResolveAlarm(alarm.id)} onAddNote={(note) => void handleAddAlarmNote(alarm.id, note)} />
            ))}
          </div>
        )}

        {resolvedAlertas.length > 0 && (
          <div className="space-y-2">
            <div className="text-[11px] font-semibold text-[hsl(var(--muted-foreground))]">Resolvidos ({resolvedAlertas.length > 10 ? `mostrando 10 de ${resolvedAlertas.length}` : resolvedAlertas.length})</div>
            <div className="bg-card border border-border rounded-xl overflow-hidden">
              <table className="w-full text-[11px]">
                <thead>
                  <tr className="border-b border-border">
                    {/* "Reconhecido por": a célula é alimentada por `acknowledgedBy`, não por
                        quem resolveu — atribuir a resolução à pessoa errada é problema
                        real em auditoria de plantão. */}
                    {['Prioridade', 'Nome', 'Zona', 'Reconhecido por', 'Disparado em'].map((h) => (
                      <th key={h} className="px-4 py-2.5 text-left font-medium text-[hsl(var(--muted-foreground))]">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {resolvedAlertas.slice(0, 10).map((alarm) => (
                    <tr key={alarm.id} className="hover:bg-[hsl(var(--accent))] transition-colors">
                      <td className="px-4 py-2.5"><span className={`font-mono text-[9px] px-1.5 py-0.5 rounded border ${PRIORITY_STYLES[alarm.priority].badge}`}>{alarm.priority}</span></td>
                      <td className="px-4 py-2.5 font-medium">{alarm.name}</td>
                      <td className="px-4 py-2.5 text-[hsl(var(--muted-foreground))]">{alarm.zone}</td>
                      <td className="px-4 py-2.5 text-[hsl(var(--muted-foreground))] font-mono text-[9px]">{alarm.acknowledgedBy ?? '—'}</td>
                      <td className="px-4 py-2.5 font-mono text-[9px] text-[hsl(var(--muted-foreground))] tabular-nums">{format(new Date(alarm.triggeredAt), 'yyyy-MM-dd HH:mm')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      <div className="w-60 border-l border-border bg-card p-4 overflow-y-auto shrink-0 space-y-5">
        <h3 className="text-[12px] font-semibold text-[hsl(var(--muted-foreground))]">Resumo</h3>

        <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Ativos', value: activeAlertas.length, color: 'text-[hsl(354,52%,62%)]' },
              { label: 'Reconh.', value: ackAlertas.length, color: 'text-[hsl(38,58%,60%)]' },
              { label: 'Resolvidos', value: resolvedAlertas.length, color: 'text-[hsl(152,36%,52%)]' },
              { label: 'Total', value: visibleAlarms.length, color: 'text-foreground' },
            ].map((s) => (
            <div key={s.label} className="bg-[hsl(var(--muted))] rounded-lg p-2.5 text-center">
              <div className={`text-lg font-bold ${s.color}`}>{s.value}</div>
              <div className="text-[9px] text-[hsl(var(--muted-foreground))]">{s.label}</div>
            </div>
          ))}
        </div>

        <div>
          <h4 className="text-[9px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">Por Zona</h4>
          <ResponsiveContainer width="100%" height={130}>
            <BarChart data={alarmStats} layout="vertical" margin={{ top: 0, right: 4, left: 0, bottom: 0 }}>
              <XAxis type="number" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} />
              <YAxis type="category" dataKey="zone" tick={{ fontSize: 9, fill: 'hsl(var(--muted-foreground))' }} axisLine={false} tickLine={false} width={50} />
              <ReTooltip contentStyle={TOOLTIP_STYLE} />
              <Bar dataKey="count" fill="hsl(213,65%,52%)" radius={[0, 2, 2, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div>
          <h4 className="text-[9px] font-semibold uppercase tracking-wider text-[hsl(var(--muted-foreground))] mb-2">Por Prioridade</h4>
          <div className="space-y-2">
            {(['P1', 'P2', 'P3', 'P4'] as const).map((p) => {
              const count = visibleAlarms.filter((a) => a.priority === p).length;
              const color = P_COLORS[p];
              return (
                <div key={p} className="flex items-center gap-2">
                  <span className="font-mono text-[9px] w-5 shrink-0" style={{ color }}>{p}</span>
                  <div className="flex-1 h-1 bg-[hsl(var(--border))] rounded-full overflow-hidden">
                    <div className="h-full rounded-full transition-all" style={{ width: `${visibleAlarms.length ? (count / visibleAlarms.length) * 100 : 0}%`, background: color }} />
                  </div>
                  <span className="font-mono text-[9px] text-[hsl(var(--muted-foreground))] w-4 text-right">{count}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <AnimatePresence>
        {showRuleForm && (
          <motion.div className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div initial={{ scale: 0.98, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.98, opacity: 0 }} className="w-full max-w-xl bg-card border border-border rounded-lg p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">{ruleForm.id ? 'Editar regra de alarme' : 'Nova regra de alarme'}</h3>
                <button onClick={() => setShowRuleForm(false)} className="h-8 w-8 rounded border border-border inline-flex items-center justify-center"><X className="w-4 h-4" /></button>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <label className="space-y-1 text-xs"><span>Nome da regra</span><input value={ruleForm.name} onChange={(e) => setRuleForm((s) => ({ ...s, name: e.target.value }))} className="w-full h-9 px-3 rounded border border-border bg-background" /></label>
                <label className="space-y-1 text-xs"><span>Evento</span><input value={ruleForm.eventType} onChange={(e) => setRuleForm((s) => ({ ...s, eventType: e.target.value }))} className="w-full h-9 px-3 rounded border border-border bg-background" placeholder="Ex.: movimento_detectado" /></label>
                <label className="space-y-1 text-xs"><span>Origem</span><select value={ruleForm.source} onChange={(e) => setRuleForm((s) => ({ ...s, source: e.target.value as RuleFormState['source'] }))} className="w-full h-9 px-3 rounded border border-border bg-background"><option value="MOTION">Movimento</option><option value="STREAM">Vídeo</option><option value="HEALTH">Saúde</option><option value="ANALYTICS">Análise</option></select></label>
                <label className="space-y-1 text-xs"><span>Prioridade</span><select value={ruleForm.priority} onChange={(e) => setRuleForm((s) => ({ ...s, priority: e.target.value as RuleFormState['priority'] }))} className="w-full h-9 px-3 rounded border border-border bg-background"><option value="P1">P1</option><option value="P2">P2</option><option value="P3">P3</option><option value="P4">P4</option></select></label>
                <label className="space-y-1 text-xs"><span>Deduplicação (segundos)</span><input type="number" min={5} max={3600} value={ruleForm.dedupWindowSeconds} onChange={(e) => setRuleForm((s) => ({ ...s, dedupWindowSeconds: Number(e.target.value) }))} className="w-full h-9 px-3 rounded border border-border bg-background" /></label>
                <label className="space-y-1 text-xs"><span>E-mail destino (opcional)</span><input value={ruleForm.emailTo} onChange={(e) => setRuleForm((s) => ({ ...s, emailTo: e.target.value }))} className="w-full h-9 px-3 rounded border border-border bg-background" placeholder="seguranca@empresa.com" /></label>
                <label className="space-y-1 text-xs md:col-span-2"><span>Webhook (opcional)</span><input value={ruleForm.webhookUrl} onChange={(e) => setRuleForm((s) => ({ ...s, webhookUrl: e.target.value }))} className="w-full h-9 px-3 rounded border border-border bg-background" placeholder="https://seu-webhook.local/alarme" /></label>
              </div>

              <div className="flex flex-wrap items-center gap-x-5 gap-y-2.5 text-xs">
                <span className="inline-flex items-center gap-2"><Switch checked={ruleForm.isEnabled} onCheckedChange={(v) => setRuleForm((s) => ({ ...s, isEnabled: v }))} /> Habilitada</span>
                <span className="inline-flex items-center gap-2"><Switch checked={ruleForm.autoResolveOnRecovery} onCheckedChange={(v) => setRuleForm((s) => ({ ...s, autoResolveOnRecovery: v }))} /> Auto-resolver em recuperação</span>
                <span className="inline-flex items-center gap-2"><Switch checked={ruleForm.notifyOnOpen} onCheckedChange={(v) => setRuleForm((s) => ({ ...s, notifyOnOpen: v }))} /> Notificar ao abrir</span>
              </div>

              <div className="flex items-center justify-end gap-2">
                <button onClick={() => setShowRuleForm(false)} className="h-9 px-3 rounded border border-border text-xs">Cancelar</button>
                <button onClick={() => void saveRule()} disabled={savingRule || !ruleForm.name.trim() || !ruleForm.eventType.trim()} className="h-9 px-3 rounded bg-primary text-primary-foreground text-xs disabled:opacity-60">{savingRule ? 'Salvando...' : 'Salvar regra'}</button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── APAGAR TODO O HISTÓRICO: atrito proporcional ao alcance ─────────
          O endpoint apaga TODOS os alarmes do sistema, mas o botão era
          habilitado pela lista FILTRADA e confirmado por uma caixa nativa do
          navegador: filtrar "Câmera 3", ver 12 itens e clicar destruía o
          histórico de todas as câmeras. Agora a confirmação declara o alcance
          e exige digitação — o mesmo atrito que já se exige para esvaziar um
          bucket, que é uma ação MENOS destrutiva que esta. */}
      {apagarTudoAberto && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-[hsl(var(--destructive)_/_0.4)] bg-card p-5 shadow-xl">
            <h2 className="text-sm font-semibold text-[hsl(var(--destructive))]">
              Apagar TODO o histórico de alarmes?
            </h2>
            <p className="mt-2 text-xs text-muted-foreground">
              Isto apaga os alarmes de <b>todas as câmeras</b> — não apenas os que estão na lista
              filtrada. O histórico que embasaria uma investigação vai junto, e não pode ser desfeito.
            </p>
            <label className="mt-4 block text-[11px] text-muted-foreground" htmlFor="confirmar-apagar-alarmes">
              Para confirmar, digite <b className="font-mono text-foreground">APAGAR</b>:
            </label>
            <input
              id="confirmar-apagar-alarmes"
              autoFocus
              value={confirmApagarTudo}
              onChange={(event) => setConfirmApagarTudo(event.target.value)}
              className="input mt-1 w-full"
              placeholder="APAGAR"
            />
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setApagarTudoAberto(false)} className="btn btn-primary btn-sm">
                Cancelar
              </button>
              <button
                type="button"
                disabled={confirmApagarTudo.trim().toUpperCase() !== 'APAGAR' || deletingAllAlarms}
                onClick={() => { setApagarTudoAberto(false); void handleDeleteAllAlarms(); }}
                className="btn btn-sm border-[hsl(var(--destructive)_/_0.45)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.1)] disabled:opacity-40"
              >
                Apagar definitivamente
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
