import { useEffect, useState } from 'react';
import axios from 'axios';
import { Camera, Shield, UserPlus, UserX, Unlock, RefreshCw, Users, KeyRound } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { cn } from '@/lib/utils';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';

const API_URL = getApiBaseUrl();

type PermissionLevel = 'VIEW' | 'CONTROL' | 'RECORD' | 'ADMIN';

type Group = {
  id: string;
  name: string;
  description?: string | null;
  cameras: Array<{ id: string; name: string }>;
};

type MyPermission = {
  id: string;
  userId?: string | null;
  groupId: string | null;
  level: PermissionLevel;
  group?: { id: string; name: string } | null;
};

type GroupUser = {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
};

const LEVEL_LABEL: Record<PermissionLevel, string> = {
  VIEW:    'Ao vivo e Reprodução',
  CONTROL: 'Ao vivo, Reprodução e PTZ',
  RECORD:  'Ao vivo, Reprodução, PTZ e Gravação',
  ADMIN:   'Administrador do grupo',
};

const ROLE_LABEL: Record<string, string> = {
  admin:    'Administrador',
  operator: 'Operador',
  viewer:   'Visualizador',
};

function apiClient(token: string | null) {
  return axios.create({
    baseURL: API_URL,
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
  });
}

export default function ProfilePage() {
  const currentUser  = useAuthStore((s) => s.user);
  const accessToken  = useAuthStore((s) => s.accessToken);

  const [groups, setGroups]         = useState<Group[]>([]);
  const [myPerms, setMyPerms]       = useState<MyPermission[]>([]);
  const [groupUsers, setGroupUsers] = useState<GroupUser[]>([]);
  const [loading, setLoading]       = useState(true);

  // Dialog: criar usuário
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', password: '' });
  const [saving, setSaving] = useState(false);

  // Dialog: alterar minha senha
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: '', newPassword: '' });
  const [changingPassword, setChangingPassword] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Grupos onde o usuário corrente é administrador
  const adminPerms    = myPerms.filter((p) => p.groupId && p.level === 'ADMIN');
  const isGroupAdmin  = adminPerms.length > 0;
  const adminGroupIds = adminPerms.map((p) => p.groupId!);
  const adminGroups   = groups.filter((g) => adminGroupIds.includes(g.id));

  const load = async () => {
    if (!accessToken) return;
    setLoading(true);
    const client = apiClient(accessToken);
    try {
      // `userId` é OBRIGATÓRIO aqui. Sem ele o endpoint devolve, para quem tem
      // privilégio, as permissões de TODO MUNDO — e esta tela as exibia como
      // "meus grupos": o admin via os grupos alheios como se fossem dele, e o
      // visualizador comum (que não recebe nada nesse modo) lia "Nenhum grupo
      // atribuído" tendo acesso a dezenas de câmeras.
      const [groupsRes, permsRes] = await Promise.all([
        client.get<Group[]>('/camera-groups'),
        client.get<MyPermission[]>('/camera-permissions', {
          params: currentUser?.id ? { userId: currentUser.id } : undefined,
        }),
      ]);

      const loadedGroups = Array.isArray(groupsRes.data) ? groupsRes.data : [];
      const allPerms     = Array.isArray(permsRes.data)  ? permsRes.data  : [];
      // Cinto e suspensório: mesmo com o userId no pedido, só entram as
      // permissões DESTE usuário que tenham grupo.
      const mine = allPerms.filter((p) => p.groupId && (!p.userId || p.userId === currentUser?.id));
      setGroups(loadedGroups);
      setMyPerms(mine);

      // Carrega usuários apenas se for admin de algum grupo
      const admIds = mine.filter((p) => p.level === 'ADMIN').map((p) => p.groupId!);
      if (admIds.length > 0) {
        const usersRes = await client.get<GroupUser[]>('/users');
        setGroupUsers(Array.isArray(usersRes.data) ? usersRes.data : []);
      } else {
        setGroupUsers([]);
      }
      setLoadError(null);
    } catch {
      // Falha de rede NÃO é "você não tem grupo": a tela afirmava isso de forma
      // categórica e o usuário ligava para o suporte achando que perdeu acesso.
      setLoadError('Não foi possível carregar seus grupos e acessos.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, [accessToken]);

  const createUser = async () => {
    const name  = form.name.trim();
    const email = form.email.trim().toLowerCase();
    if (!name || !email || !form.password) {
      toast({ title: 'Preencha todos os campos.', variant: 'destructive' });
      return;
    }
    setSaving(true);
    try {
      await apiClient(accessToken).post('/users', {
        name,
        email,
        password: form.password,
        role: 'VIEWER',
        groupIds: adminGroupIds,
        permissionLevel: 'VIEW',
      });
      setCreateOpen(false);
      setForm({ name: '', email: '', password: '' });
      toast({
        title: 'Usuário criado',
        description: `${name} já pode acessar o sistema.`,
      });
      await load();
    } catch (error) {
      toast({
        title: 'Erro ao criar usuário',
        description: error instanceof Error ? error.message : 'Falha ao criar usuário.',
        variant: 'destructive',
      });
    } finally {
      setSaving(false);
    }
  };

  const toggleActive = async (userId: string, active: boolean) => {
    try {
      await apiClient(accessToken).patch(`/users/${userId}`, { isActive: active });
      toast({ title: active ? 'Usuário reativado' : 'Usuário bloqueado' });
      await load();
    } catch (error) {
      toast({
        title: 'Erro',
        description: error instanceof Error ? error.message : 'Falha ao atualizar usuário.',
        variant: 'destructive',
      });
    }
  };

  const changeMyPassword = async () => {
    if (!passwordForm.currentPassword || !passwordForm.newPassword) {
      toast({ title: 'Preencha a senha atual e a nova senha.', variant: 'destructive' });
      return;
    }
    setChangingPassword(true);
    try {
      await apiClient(accessToken).patch('/users/me/password', passwordForm);
      setPasswordOpen(false);
      setPasswordForm({ currentPassword: '', newPassword: '' });
      toast({ title: 'Senha alterada com sucesso.' });
    } catch (error) {
      const message = axios.isAxiosError(error)
        ? (error.response?.data as { message?: string | string[] })?.message
        : undefined;
      toast({
        title: 'Erro ao alterar senha',
        description: Array.isArray(message) ? message.join(' ') : message ?? 'Falha ao alterar senha.',
        variant: 'destructive',
      });
    } finally {
      setChangingPassword(false);
    }
  };

  const initials = (name: string) =>
    name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div className="flex flex-col h-full overflow-y-auto">
      <div className="page-hdr flex items-center justify-between">
        <div>
          <h1 className="page-title">Minha conta</h1>
          <p className="page-sub">Seus dados, grupos e acessos</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => { setPasswordForm({ currentPassword: '', newPassword: '' }); setPasswordOpen(true); }}
            className="btn btn-secondary btn-sm"
          >
            <KeyRound className="h-3.5 w-3.5" />
            Alterar senha
          </button>
          <button
            onClick={() => void load()}
            disabled={loading}
            className="btn btn-secondary btn-sm"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
            Atualizar
          </button>
        </div>
      </div>

      <div className="flex-1 p-5 space-y-6 max-w-2xl">

        {/* ── Dados do usuário ── */}
        <div className="rounded-xl border border-border bg-card p-5 flex items-center gap-4">
          <div
            className="w-14 h-14 rounded-xl flex items-center justify-center text-lg font-bold shrink-0"
            style={{ background: 'hsl(var(--primary) / 0.1)', border: '1px solid hsl(var(--primary) / 0.2)', color: 'hsl(var(--primary))' }}
          >
            {initials(currentUser?.name ?? '?')}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold truncate">{currentUser?.name}</div>
            <div className="text-xs text-muted-foreground mt-0.5">{currentUser?.email}</div>
            <div className="mt-2">
              <span className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-0.5 text-[10px] font-mono text-muted-foreground">
                <Shield className="w-3 h-3" />
                {ROLE_LABEL[currentUser?.role ?? 'viewer'] ?? 'Visualizador'}
              </span>
            </div>
          </div>
        </div>

        {/* ── Meus grupos ── */}
        <div>
          <h2 className="text-sm font-semibold mb-3">Meus grupos</h2>
          {loading ? (
            <div className="text-xs text-muted-foreground px-1">Carregando...</div>
          ) : loadError ? (
            <div className="rounded-xl border border-[hsl(var(--destructive)_/_0.35)] bg-[hsl(var(--destructive)_/_0.08)] p-4 text-xs">
              <div className="text-[hsl(var(--destructive))]">{loadError}</div>
              <div className="mt-1 text-muted-foreground">
                Isto NÃO significa que você perdeu acesso — o sistema só não conseguiu consultar agora.
              </div>
              <button type="button" onClick={() => void load()} className="btn btn-secondary btn-sm mt-3">
                Tentar novamente
              </button>
            </div>
          ) : myPerms.length === 0 ? (
            <div className="rounded-xl border border-border bg-card p-4 text-xs text-muted-foreground">
              Nenhum grupo atribuído. Entre em contato com o administrador do sistema.
            </div>
          ) : (
            <div className="space-y-2">
              {myPerms.map((perm) => {
                const group = groups.find((g) => g.id === perm.groupId);
                if (!group) return null;
                return (
                  <div
                    key={perm.id}
                    className="rounded-xl border border-border bg-card p-4 flex items-center gap-3"
                  >
                    <div
                      className="w-9 h-9 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0"
                      style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}
                    >
                      {group.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[13px] font-medium truncate">{group.name}</div>
                      {group.description && (
                        <div className="text-[10px] text-muted-foreground truncate">{group.description}</div>
                      )}
                      <div className="text-[10px] text-muted-foreground mt-0.5">{LEVEL_LABEL[perm.level]}</div>
                    </div>
                    <div className="flex items-center gap-1 text-[10px] text-muted-foreground font-mono shrink-0">
                      <Camera className="w-3 h-3" />
                      {group.cameras.length} câmera{group.cameras.length !== 1 ? 's' : ''}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* ── Gestão de usuários (apenas para group admins) ── */}
        {isGroupAdmin && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <div>
                <h2 className="text-sm font-semibold">Usuários do grupo</h2>
                <p className="text-[11px] text-muted-foreground mt-0.5">
                  {adminGroups.map((g) => g.name).join(' · ')}
                </p>
              </div>
              <button
                className="btn btn-primary btn-sm"
                onClick={() => { setForm({ name: '', email: '', password: '' }); setCreateOpen(true); }}
              >
                <UserPlus className="w-3.5 h-3.5" />
                Novo usuário
              </button>
            </div>

            <div className="space-y-2">
              {groupUsers
                .filter((u) => u.id !== currentUser?.id)
                .map((user) => (
                  <div
                    key={user.id}
                    className={cn(
                      'rounded-xl border border-border bg-card px-4 py-3 flex items-center gap-3 transition-opacity',
                      !user.isActive && 'opacity-60',
                    )}
                  >
                    <div
                      className="w-8 h-8 rounded-lg flex items-center justify-center text-[10px] font-bold shrink-0"
                      style={{ background: 'hsl(var(--muted))', color: 'hsl(var(--muted-foreground))' }}
                    >
                      {initials(user.name)}
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-[12.5px] font-medium truncate">{user.name}</div>
                      <div className="text-[10px] font-mono text-muted-foreground truncate">{user.email}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className="w-1.5 h-1.5 rounded-full"
                        style={{ background: user.isActive ? 'hsl(var(--status-online))' : 'hsl(var(--muted-foreground) / 0.4)' }}
                      />
                      <span className="text-[10px] text-muted-foreground">
                        {user.isActive ? 'Ativo' : 'Bloqueado'}
                      </span>
                      <button
                        className="btn btn-ghost btn-xs"
                        title={user.isActive ? 'Bloquear acesso' : 'Reativar acesso'} aria-label={user.isActive ? 'Bloquear acesso' : 'Reativar acesso'}
                        onClick={() => void toggleActive(user.id, !user.isActive)}
                      >
                        {user.isActive
                          ? <UserX className="w-3.5 h-3.5" />
                          : <Unlock className="w-3.5 h-3.5 text-[hsl(var(--status-online))]" />}
                      </button>
                    </div>
                  </div>
                ))}

              {groupUsers.filter((u) => u.id !== currentUser?.id).length === 0 && !loading && (
                <div className="rounded-xl border border-border border-dashed bg-card/50 p-6 flex flex-col items-center gap-2 text-center">
                  <Users className="w-7 h-7 opacity-20" />
                  <p className="text-xs text-muted-foreground">
                    Nenhum usuário criado ainda.<br />Crie o primeiro acesso para sua equipe.
                  </p>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* ── Dialog: criar usuário ── */}
      <Dialog open={createOpen} onOpenChange={(o) => !o && setCreateOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Novo usuário</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Nome completo</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="Nome do usuário"
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">E-mail</label>
              <input
                type="email"
                value={form.email}
                onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                placeholder="email@exemplo.com"
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Senha inicial</label>
              <input
                type="password"
                value={form.password}
                onChange={(e) => setForm((f) => ({ ...f, password: e.target.value }))}
                placeholder="Mínimo 12 caracteres"
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            {/* Info sobre o grupo que será atribuído */}
            <div className="rounded-lg border border-border bg-muted/30 p-2.5 text-[10px] text-muted-foreground">
              O usuário será criado como <strong>Visualizador</strong> com acesso a:{' '}
              <strong>{adminGroups.map((g) => g.name).join(', ')}</strong>.
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setCreateOpen(false)}
                className="btn btn-ghost btn-sm flex-1 justify-center"
              >
                Cancelar
              </button>
              <button
                onClick={() => void createUser()}
                disabled={saving || !form.name.trim() || !form.email.trim() || !form.password}
                className="btn btn-primary btn-sm flex-1 justify-center"
              >
                {saving ? 'Criando...' : 'Criar usuário'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {/* ── Dialog: alterar minha senha ── */}
      <Dialog open={passwordOpen} onOpenChange={(o) => !o && setPasswordOpen(false)}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Alterar senha</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Senha atual</label>
              <input
                type="password"
                value={passwordForm.currentPassword}
                onChange={(e) => setPasswordForm((f) => ({ ...f, currentPassword: e.target.value }))}
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium text-muted-foreground">Nova senha</label>
              <input
                type="password"
                value={passwordForm.newPassword}
                onChange={(e) => setPasswordForm((f) => ({ ...f, newPassword: e.target.value }))}
                placeholder="Mínimo 10 caracteres"
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>

            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setPasswordOpen(false)}
                className="btn btn-ghost btn-sm flex-1 justify-center"
              >
                Cancelar
              </button>
              <button
                onClick={() => void changeMyPassword()}
                disabled={changingPassword || !passwordForm.currentPassword || !passwordForm.newPassword}
                className="btn btn-primary btn-sm flex-1 justify-center"
              >
                {changingPassword ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
