import { useEffect, useState } from 'react';
import axios from 'axios';
import { Plus, Users, Camera, Settings, Trash2, Check, ChevronRight, Pencil, HardDrive } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { Switch } from '@/components/ui/switch';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetFooter } from '@/components/ui/sheet';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';

const API_URL = getApiBaseUrl();
type PermissionLevel = 'VIEW' | 'CONTROL' | 'RECORD' | 'ADMIN';

type AccessGroup = {
  id: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  /** Cota de câmeras privadas que o cliente deste grupo pode cadastrar (0 = nenhuma). */
  maxPrivateCameras?: number;
  cameras: Array<{ id: string; name: string }>;
  _userPermissions?: UserPermission[];
};

type UserPermission = {
  id: string;
  userId: string;
  groupId?: string | null;
  cameraId?: string | null;
  level: PermissionLevel;
  user?: { id: string; name: string; email: string };
};

const LEVEL_LABEL: Record<PermissionLevel, string> = {
  VIEW:    'Ver ao vivo e reprodução',
  CONTROL: 'Ver e controlar PTZ',
  RECORD:  'Ver, controlar e gravação',
  ADMIN:   'Administrar câmeras do grupo',
};

function apiClient(token: string | null) {
  return axios.create({
    baseURL: API_URL,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

export default function GroupsPage() {
  const cameras = useVmsDataStore((s) => s.cameras);
  const users   = useVmsDataStore((s) => s.users);
  const loadData = useVmsDataStore((s) => s.load);
  const accessToken = useAuthStore((s) => s.accessToken);
  const currentUser = useAuthStore((s) => s.user);
  const isAdmin = currentUser?.role === 'admin';

  const [groups, setGroups] = useState<AccessGroup[]>([]);
  const [permissions, setPermissions] = useState<UserPermission[]>([]);
  const [loading, setLoading] = useState(false);
  const [selGroupId, setSelGroupId] = useState<string | null>(null);
  const [tab, setTab] = useState<'cameras' | 'users' | 'permissions'>('cameras');

  // Create group dialog
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);

  // Edit group dialog
  const [editOpen, setEditOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const [editDesc, setEditDesc] = useState('');
  const [editMaxPrivate, setEditMaxPrivate] = useState(0);
  const [editSaving, setEditSaving] = useState(false);

  // Delete group dialog
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Grant access sheet
  const [grantOpen, setGrantOpen] = useState(false);
  const [grantUserId, setGrantUserId] = useState('');
  const [grantLevel, setGrantLevel] = useState<PermissionLevel>('VIEW');
  const [granting, setGranting] = useState(false);
  const [alarmsSaving, setAlarmsSaving] = useState(false);
  const [retentionOpen, setRetentionOpen] = useState(false);
  const [retentionValue, setRetentionValue] = useState('7');
  const [retentionSaving, setRetentionSaving] = useState(false);

  const selGroup = groups.find((g) => g.id === selGroupId) ?? groups[0] ?? null;
  const groupCamIds = new Set(selGroup?.cameras.map((c) => c.id) ?? []);
  const groupPerms = permissions.filter((p) => p.groupId === selGroup?.id);
  const groupLiveCams = cameras.filter((c) => groupCamIds.has(c.id));
  const groupAlarmsOn = groupLiveCams.length > 0 && groupLiveCams.every((c) => c.alarmsEnabled);

  const load = async () => {
    if (!accessToken) return;
    setLoading(true);
    try {
      const client = apiClient(accessToken);
      const [gr, pr] = await Promise.all([
        client.get('/camera-groups'),
        client.get('/camera-permissions'),
      ]);
      const loadedGroups: AccessGroup[] = Array.isArray(gr.data) ? gr.data : [];
      setGroups(loadedGroups);
      setPermissions(Array.isArray(pr.data) ? pr.data : []);
      if (!selGroupId && loadedGroups[0]) setSelGroupId(loadedGroups[0].id);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [accessToken]);

  const setGroupAlarms = async (enabled: boolean) => {
    if (!selGroup || !accessToken) return;
    setAlarmsSaving(true);
    try {
      const { data } = await apiClient(accessToken).post(`/camera-groups/${selGroup.id}/alarms`, { enabled });
      await Promise.all([loadData(), load()]);
      toast({
        title: enabled ? 'Alarmes ligados no grupo' : 'Alarmes desligados no grupo',
        description: `${data?.affected ?? selGroup.cameras.length} câmera(s) de ${selGroup.name} atualizada(s).`,
      });
    } catch (e) {
      toast({ title: 'Falha ao atualizar alarmes', description: e instanceof Error ? e.message : 'Não foi possível atualizar os alarmes do grupo.', variant: 'destructive' });
    } finally {
      setAlarmsSaving(false);
    }
  };

  const setGroupRetention = async () => {
    if (!selGroup || !accessToken) return;
    const days = Math.max(1, Math.min(3650, Math.floor(Number(retentionValue)) || 7));
    setRetentionSaving(true);
    try {
      const { data } = await apiClient(accessToken).post(`/camera-groups/${selGroup.id}/retention`, { retentionDays: days });
      await Promise.all([loadData(), load()]);
      setRetentionOpen(false);
      toast({
        title: 'Retenção aplicada ao grupo',
        description: `${data?.affected ?? selGroup.cameras.length} câmera(s) de ${selGroup.name} agora com ${days} dia(s) de retenção.`,
      });
    } catch (e) {
      toast({ title: 'Falha ao aplicar retenção', description: e instanceof Error ? e.message : 'Não foi possível aplicar a retenção do grupo.', variant: 'destructive' });
    } finally {
      setRetentionSaving(false);
    }
  };

  const createGroup = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    try {
      const { data } = await apiClient(accessToken).post('/camera-groups', {
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      });
      setCreateOpen(false);
      setNewName(''); setNewDesc('');
      await load();
      setSelGroupId(data.id);
      toast({ title: 'Grupo criado', description: newName.trim() });
    } catch (e) {
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Falha ao criar grupo.', variant: 'destructive' });
    } finally { setCreating(false); }
  };

  const openEditGroup = () => {
    setEditName(selGroup?.name ?? '');
    setEditDesc(selGroup?.description ?? '');
    setEditMaxPrivate(selGroup?.maxPrivateCameras ?? 0);
    setEditOpen(true);
  };

  const updateGroup = async () => {
    if (!selGroup || !editName.trim()) return;
    setEditSaving(true);
    try {
      await apiClient(accessToken).patch(`/camera-groups/${selGroup.id}`, {
        name: editName.trim(),
        description: editDesc.trim() || null,
        maxPrivateCameras: Math.max(0, Math.floor(Number(editMaxPrivate) || 0)),
      });
      await load();
      setEditOpen(false);
      toast({ title: 'Grupo atualizado', description: editName.trim() });
    } catch (e) {
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Falha ao atualizar grupo.', variant: 'destructive' });
    } finally { setEditSaving(false); }
  };

  const deleteGroup = async () => {
    if (!selGroup) return;
    setDeleting(true);
    try {
      await apiClient(accessToken).delete(`/camera-groups/${selGroup.id}`);
      setSelGroupId(null);
      await load();
      setDeleteOpen(false);
      toast({ title: 'Grupo removido', description: selGroup.name });
    } catch (e) {
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Falha ao remover grupo.', variant: 'destructive' });
    } finally { setDeleting(false); }
  };

  const toggleCamera = async (cameraId: string, shouldAdd: boolean) => {
    if (!selGroup) return;
    try {
      if (shouldAdd) {
        await apiClient(accessToken).post(`/camera-groups/${selGroup.id}/cameras/${cameraId}`);
      } else {
        await apiClient(accessToken).delete(`/camera-groups/${selGroup.id}/cameras/${cameraId}`);
      }
      await Promise.all([load(), loadData()]);
    } catch (e) {
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Falha ao atualizar grupo.', variant: 'destructive' });
    }
  };

  const grantAccess = async () => {
    if (!selGroup || !grantUserId) return;
    setGranting(true);
    try {
      await apiClient(accessToken).post('/camera-permissions', {
        userId: grantUserId,
        groupId: selGroup.id,
        level: grantLevel,
      });
      setGrantOpen(false);
      await load();
      toast({ title: 'Acesso liberado', description: `${users.find((u) => u.id === grantUserId)?.name} → ${selGroup.name}` });
    } catch (e) {
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Falha ao liberar acesso.', variant: 'destructive' });
    } finally { setGranting(false); }
  };

  const revokeAccess = async (permId: string) => {
    try {
      await apiClient(accessToken).delete(`/camera-permissions/${permId}`);
      await load();
    } catch (e) {
      toast({ title: 'Erro', description: e instanceof Error ? e.message : 'Falha ao remover acesso.', variant: 'destructive' });
    }
  };

  const TABS = [
    { id: 'cameras' as const,     label: 'Câmeras',    count: selGroup?.cameras.length ?? 0 },
    { id: 'users' as const,       label: 'Usuários',   count: groupPerms.length },
    { id: 'permissions' as const, label: 'Permissões' },
  ];

  return (
    <div className="flex h-full min-h-0">
      {/* ── Groups list ── */}
      <aside className="w-72 shrink-0 border-r border-border flex flex-col overflow-hidden bg-card">
        <div className="px-4 py-3 border-b border-border shrink-0 flex items-center justify-between">
          <div>
            <h2 className="text-[13px] font-semibold">Grupos</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">{groups.length} clientes / locais</p>
          </div>
          {isAdmin && (
            <button className="btn btn-secondary btn-sm btn-icon" onClick={() => setCreateOpen(true)}>
              <Plus className="w-4 h-4" />
            </button>
          )}
        </div>

        <div className="flex-1 overflow-y-auto divide-y divide-border/60">
          {loading && !groups.length && (
            <div className="flex items-center justify-center h-20 text-[11px] text-muted-foreground">
              Carregando...
            </div>
          )}
          {groups.map((g) => {
            const cCount = g.cameras.length;
            const uCount = permissions.filter((p) => p.groupId === g.id).length;
            const isSel = selGroup?.id === g.id;
            return (
              <button
                key={g.id}
                onClick={() => { setSelGroupId(g.id); setTab('cameras'); }}
                className={cn(
                  'w-full text-left px-4 py-3 transition-colors',
                  'border-l-2',
                  isSel
                    ? 'bg-[hsl(var(--accent))] border-l-[hsl(var(--primary))]'
                    : 'border-l-transparent hover:bg-[hsl(var(--accent)_/_0.6)]'
                )}
              >
                <div className="flex items-center gap-2.5 mb-1.5">
                  <div className={cn(
                    'w-7 h-7 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0',
                    isSel ? 'bg-[hsl(var(--primary)_/_0.15)] text-[hsl(var(--primary))]' : 'bg-muted text-muted-foreground'
                  )}>
                    {g.name.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="text-[12.5px] font-semibold truncate">{g.name}</div>
                    {g.description && (
                      <div className="text-[10px] text-muted-foreground truncate">{g.description}</div>
                    )}
                  </div>
                  <div className={cn('w-1.5 h-1.5 rounded-full shrink-0', g.isActive ? 'bg-[hsl(var(--status-online,152_46%_44%))]' : 'bg-muted-foreground/30')} />
                </div>
                <div className="flex items-center gap-3 pl-9 text-[10px] text-muted-foreground font-mono">
                  <span>{cCount} câmera{cCount !== 1 ? 's' : ''}</span>
                  <span>{uCount} usuário{uCount !== 1 ? 's' : ''}</span>
                </div>
              </button>
            );
          })}
        </div>
      </aside>

      {/* ── Detail ── */}
      {!selGroup ? (
        <div className="flex-1 flex items-center justify-center text-muted-foreground">
          <div className="text-center space-y-2">
            <Users className="w-10 h-10 opacity-20 mx-auto" />
            <p className="text-sm">{isAdmin ? 'Crie ou selecione um grupo' : 'Selecione um grupo'}</p>
          </div>
        </div>
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden">
          {/* Group header */}
          <div className="px-6 py-4 border-b border-border shrink-0 flex items-center gap-4">
            <div className="w-10 h-10 rounded-xl bg-muted border border-border flex items-center justify-center text-sm font-bold text-foreground shrink-0">
              {selGroup.name.slice(0, 2).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <h2 className="text-[16px] font-semibold">{selGroup.name}</h2>
              <p className="text-[11px] text-muted-foreground mt-0.5">
                {selGroup.cameras.length} câmeras · {groupPerms.length} usuários com acesso
              </p>
            </div>
            <div className="flex items-center gap-2">
              {isAdmin && (
                <div
                  className="flex items-center gap-2.5 h-8 rounded-md border border-border px-3"
                  style={{ background: 'hsl(var(--muted) / 0.5)' }}
                  title={groupAlarmsOn ? 'Alarmes ativos em todas as câmeras do grupo' : 'Alarmes desligados (ou parciais) no grupo'}
                >
                  <span className="flex items-center gap-1.5 text-[11px]" style={{ color: 'var(--tx-2)' }}>
                    <span className={`w-1.5 h-1.5 rounded-full ${groupAlarmsOn ? 'status-alarm' : ''}`} style={!groupAlarmsOn ? { background: 'var(--s-offline)' } : undefined} />
                    Alarmes do grupo
                  </span>
                  <Switch checked={groupAlarmsOn} disabled={alarmsSaving || !groupLiveCams.length} onCheckedChange={(v) => void setGroupAlarms(v)} />
                </div>
              )}
              {tab === 'users' && isAdmin && (
                <button className="btn btn-primary btn-sm" onClick={() => setGrantOpen(true)}>
                  <Plus className="w-3.5 h-3.5" /> Liberar acesso
                </button>
              )}
              {isAdmin && (
                <>
                  <button
                    className="btn btn-ghost btn-sm"
                    title="Definir a retenção (dias) de TODAS as câmeras deste grupo"
                    disabled={!selGroup?.cameras.length}
                    onClick={() => { setRetentionValue('7'); setRetentionOpen(true); }}
                  >
                    <HardDrive className="w-3.5 h-3.5" /> Retenção
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    title="Editar grupo"
                    onClick={openEditGroup}
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    className="btn btn-ghost btn-sm btn-icon"
                    title="Excluir grupo"
                    style={{ color: 'hsl(var(--destructive))' }}
                    onClick={() => setDeleteOpen(true)}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>

          {/* Tabs */}
          <div className="px-6 border-b border-border shrink-0 flex items-center gap-0">
            {TABS.map((t) => (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={cn(
                  'px-1 py-3 mr-5 text-[12px] font-medium border-b-2 transition-colors',
                  tab === t.id
                    ? 'border-[hsl(var(--primary))] text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground'
                )}>
                {t.label}
                {'count' in t && t.count != null && (
                  <span className="ml-1.5 font-mono text-[9px] text-muted-foreground">{t.count}</span>
                )}
              </button>
            ))}
          </div>

          {/* Tab content */}
          <div className="flex-1 overflow-y-auto p-6">

            {/* ── CAMERAS ── */}
            {tab === 'cameras' && (
              <div className="space-y-4">
                <p className="text-[12px] text-muted-foreground">
                  Marque as câmeras que devem ser visíveis para os usuários deste grupo.
                </p>
                <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
                  {cameras.map((cam) => {
                    const inGroup = groupCamIds.has(cam.id);
                    return (
                      <div key={cam.id}
                        className={cn(
                          'flex items-center gap-3 px-3.5 py-3 rounded-xl border transition-colors',
                          inGroup ? 'border-[hsl(var(--primary)_/_0.3)] bg-[hsl(var(--primary)_/_0.04)]' : 'border-border bg-card'
                        )}>
                        <div className={cn('w-2 h-2 rounded-full shrink-0', cam.isOnline ? 'bg-[hsl(var(--status-online,152_46%_44%))]' : 'bg-muted-foreground/30')} />
                        <div className="flex-1 min-w-0">
                          <div className="text-[12.5px] font-medium truncate">{cam.name}</div>
                          <div className="text-[10px] text-muted-foreground font-mono truncate">{cam.zone} · {cam.ipAddress}</div>
                        </div>
                        {isAdmin && (
                          <Switch checked={inGroup} onCheckedChange={(v) => void toggleCamera(cam.id, v)} />
                        )}
                        {!isAdmin && inGroup && <Check className="w-3.5 h-3.5 text-[hsl(var(--primary))]" />}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* ── USERS ── */}
            {tab === 'users' && (
              <div className="space-y-3 max-w-2xl">
                {groupPerms.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-40 gap-3 text-muted-foreground">
                    <Users className="w-8 h-8 opacity-20" />
                    <p className="text-sm">Nenhum usuário com acesso a este grupo</p>
                    {isAdmin && (
                      <Button size="sm" variant="outline" className="text-xs" onClick={() => setGrantOpen(true)}>
                        <Plus className="w-3.5 h-3.5 mr-1.5" /> Liberar acesso
                      </Button>
                    )}
                  </div>
                ) : groupPerms.map((perm) => {
                  const user = users.find((u) => u.id === perm.userId);
                  return (
                    <div key={perm.id}
                      className="flex items-center gap-3 px-4 py-3 rounded-xl border border-border bg-card">
                      <div className="w-8 h-8 rounded-lg bg-[hsl(var(--primary)_/_0.1)] border border-[hsl(var(--primary)_/_0.2)] flex items-center justify-center text-[11px] font-bold text-[hsl(var(--primary))] shrink-0">
                        {(user?.name ?? 'U').split(' ').map((n) => n[0]).join('').slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-[12.5px] font-semibold">{user?.name ?? perm.userId}</div>
                        <div className="text-[10px] text-muted-foreground mt-0.5">{LEVEL_LABEL[perm.level]}</div>
                      </div>
                      <Badge variant="outline" className="text-[9px] border-border text-muted-foreground">
                        {perm.level}
                      </Badge>
                      {isAdmin && (
                        <Button variant="ghost" size="sm" className="w-8 h-8 p-0 text-muted-foreground hover:text-destructive" onClick={() => void revokeAccess(perm.id)}>
                          <Trash2 className="w-3.5 h-3.5" />
                        </Button>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* ── PERMISSIONS ── */}
            {tab === 'permissions' && (
              <div className="max-w-xl space-y-3">
                <p className="text-[12px] text-muted-foreground leading-relaxed">
                  Permissões aplicadas a <strong>todos os usuários</strong> deste grupo.
                  Itens com cadeado são impostos pelo sistema e garantem isolamento entre clientes.
                </p>
                <div className="bg-card border border-border rounded-xl overflow-hidden">
                  {[
                    { label: 'Acesso ao Live View',                allowed: true,  locked: true },
                    { label: 'Playback das câmeras do grupo',       allowed: true,  locked: true },
                    { label: 'Controle PTZ',                        allowed: true,  locked: false },
                    { label: 'Reconhecer alarmes',                  allowed: true,  locked: false },
                    { label: 'Exportar evidências',                 allowed: true,  locked: false },
                    { label: 'Criar usuários no próprio grupo',     allowed: false, locked: false },
                    { label: 'Ver câmeras de outros grupos',        allowed: false, locked: true },
                    { label: 'Configurações globais do sistema',    allowed: false, locked: true },
                    { label: 'Logs do sistema (provedor)',          allowed: false, locked: true },
                    { label: 'Usuários de outros grupos',          allowed: false, locked: true },
                  ].map((p, i, arr) => (
                    <div key={p.label}
                      className={cn(
                        'flex items-center gap-4 px-4 py-3',
                        i < arr.length - 1 && 'border-b border-border/60'
                      )}>
                      <div className="flex-1 text-[12px] text-foreground">{p.label}</div>
                      {p.locked ? (
                        <div className="flex items-center gap-1.5 text-[10px] font-mono text-muted-foreground/70">
                          {p.allowed ? 'Sempre' : 'Nunca'}
                        </div>
                      ) : (
                        <Switch checked={p.allowed} disabled={!isAdmin} />
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ── Create group dialog ── */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && setCreateOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Criar novo grupo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Nome do grupo</Label>
              <Input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Ex.: Supermercado Central" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Descrição <span className="font-normal text-muted-foreground">(opcional)</span></Label>
              <Input value={newDesc} onChange={(e) => setNewDesc(e.target.value)} placeholder="Ex.: Loja principal, Recife" />
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>Cancelar</Button>
              <Button size="sm" className="flex-1 justify-center" disabled={creating || !newName.trim()} onClick={() => void createGroup()}>
                {creating ? 'Criando...' : <><Plus className="w-3.5 h-3.5 mr-1.5" /> Criar grupo</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Edit group dialog ── */}
      <Dialog open={editOpen} onOpenChange={(o) => !o && setEditOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Editar grupo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <div className="space-y-1.5">
              <Label className="text-xs">Nome do grupo</Label>
              <Input value={editName} onChange={(e) => setEditName(e.target.value)} placeholder="Ex.: Supermercado Central" autoFocus />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Descrição <span className="font-normal text-muted-foreground">(opcional)</span></Label>
              <Input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder="Ex.: Loja principal, Recife" />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Câmeras privadas permitidas</Label>
              <Input
                type="number"
                min={0}
                max={1000}
                value={editMaxPrivate}
                onChange={(e) => setEditMaxPrivate(Math.max(0, Math.floor(Number(e.target.value) || 0)))}
              />
              <p className="text-[10px] text-muted-foreground">
                Quantas câmeras o cliente deste grupo pode cadastrar pelo app dele (o "acordado"). 0 = não permite.
              </p>
            </div>
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setEditOpen(false)}>Cancelar</Button>
              <Button size="sm" className="flex-1 justify-center" disabled={editSaving || !editName.trim()} onClick={() => void updateGroup()}>
                {editSaving ? 'Salvando...' : 'Salvar alterações'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Delete group confirmation dialog ── */}
      <Dialog open={deleteOpen} onOpenChange={(o) => !o && setDeleteOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Excluir grupo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <p className="text-[13px] text-muted-foreground">
              Tem certeza que deseja excluir o grupo{' '}
              <strong className="text-foreground">{selGroup?.name}</strong>?
            </p>
            <p className="text-[11px] text-muted-foreground rounded-lg border border-border bg-muted/30 p-3 leading-relaxed">
              As câmeras e os acessos de usuários vinculados a este grupo serão removidos.
              Esta ação não pode ser desfeita.
            </p>
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setDeleteOpen(false)}>Cancelar</Button>
              <Button variant="destructive" size="sm" className="flex-1 justify-center" disabled={deleting} onClick={() => void deleteGroup()}>
                {deleting ? 'Excluindo...' : <><Trash2 className="w-3.5 h-3.5 mr-1.5" /> Excluir grupo</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* Retenção do grupo — sobrescreve o valor individual de cada câmera. */}
      <Dialog open={retentionOpen} onOpenChange={(o) => !o && setRetentionOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Retenção do grupo</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            <label className="text-[13px] font-medium text-foreground">Manter gravações por (dias)</label>
            <Input
              type="number"
              min={1}
              max={3650}
              value={retentionValue}
              onChange={(e) => setRetentionValue(e.target.value)}
              className="text-sm font-mono"
              autoFocus
            />
            <p className="text-[12px] rounded-lg border p-3 leading-relaxed" style={{ borderColor: 'hsl(var(--warning) / 0.4)', background: 'hsl(var(--warning) / 0.08)', color: 'hsl(var(--warning-foreground, var(--foreground)))' }}>
              ⚠️ Isto vai <strong>sobrescrever</strong> a retenção individual de{' '}
              <strong>{selGroup?.cameras.length ?? 0} câmera(s)</strong> do grupo{' '}
              <strong>{selGroup?.name}</strong>. Cada câmera passará a manter as gravações por {Math.max(1, Math.min(3650, Math.floor(Number(retentionValue)) || 7))} dia(s).
            </p>
            <div className="flex gap-2 pt-2">
              <Button variant="ghost" size="sm" onClick={() => setRetentionOpen(false)}>Cancelar</Button>
              <Button size="sm" className="flex-1 justify-center" disabled={retentionSaving} onClick={() => void setGroupRetention()}>
                {retentionSaving ? 'Aplicando...' : <><HardDrive className="w-3.5 h-3.5 mr-1.5" /> Aplicar a todas</>}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Grant access sheet ── */}
      <Sheet open={grantOpen} onOpenChange={(o) => !o && setGrantOpen(false)}>
        <SheetContent className="w-[360px] flex flex-col p-0 gap-0">
          <SheetHeader className="px-5 py-4 border-b border-border shrink-0">
            <SheetTitle className="text-[14px]">Liberar acesso ao grupo</SheetTitle>
            <p className="text-[11px] text-muted-foreground mt-1">{selGroup?.name}</p>
          </SheetHeader>
          <div className="flex-1 px-5 py-4 space-y-4">
            <div className="space-y-1.5">
              <Label className="text-xs">Usuário</Label>
              <Select value={grantUserId} onValueChange={setGrantUserId}>
                <SelectTrigger className="text-sm"><SelectValue placeholder="Selecione um usuário" /></SelectTrigger>
                <SelectContent>
                  {users.map((u) => (
                    <SelectItem key={u.id} value={u.id} className="text-sm">{u.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Nível de acesso</Label>
              <Select value={grantLevel} onValueChange={(v) => setGrantLevel(v as PermissionLevel)}>
                <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {(Object.entries(LEVEL_LABEL) as [PermissionLevel, string][]).map(([v, l]) => (
                    <SelectItem key={v} value={v} className="text-sm">{l}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="rounded-lg border border-border bg-muted/30 p-3 text-[11px] text-muted-foreground">
              O usuário selecionado só poderá ver câmeras deste grupo — nunca de outros clientes.
            </div>
          </div>
          <SheetFooter className="px-5 py-3 border-t border-border shrink-0 flex-row gap-2">
            <Button variant="ghost" size="sm" onClick={() => setGrantOpen(false)}>Cancelar</Button>
            <Button size="sm" className="ml-auto" disabled={granting || !grantUserId} onClick={() => void grantAccess()}>
              {granting ? 'Salvando...' : 'Salvar acesso'}
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>
    </div>
  );
}
