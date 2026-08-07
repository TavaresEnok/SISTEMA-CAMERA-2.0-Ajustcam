import { useEffect, useMemo, useState } from 'react';
import axios from 'axios';
import { Plus, UserX, Unlock, Edit2, Save, Trash2, RefreshCw, Search, MoreHorizontal } from 'lucide-react';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { useVmsDataStore } from '../store/vmsDataStore';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { toast } from '../hooks/use-toast';

const API_URL = getApiBaseUrl();

type PermissionLevel = 'VIEW' | 'CONTROL' | 'RECORD' | 'ADMIN';
type ApiUserRole = 'ADMIN' | 'OPERATOR' | 'VIEWER';

type AccessGroup = {
  id: string;
  name: string;
  description?: string | null;
  isActive: boolean;
  cameras: Array<{ id: string; name: string }>;
};

type AccessPermission = {
  id: string;
  userId: string;
  cameraId?: string | null;
  groupId?: string | null;
  level: PermissionLevel;
  user?: { id: string; name: string; email: string };
  group?: { id: string; name: string } | null;
  camera?: { id: string; name: string } | null;
};

const levelLabel: Record<PermissionLevel, string> = {
  VIEW: 'Ver ao vivo e reprodução',
  CONTROL: 'Ver e controlar PTZ',
  RECORD: 'Ver, controlar e gravação',
  ADMIN: 'Administrar câmeras do grupo',
};

const roleOptions: Array<{ value: ApiUserRole; label: string }> = [
  { value: 'VIEWER', label: 'Visualizador' },
  { value: 'OPERATOR', label: 'Operador' },
  { value: 'ADMIN', label: 'Administrador' },
];

const visibleRoleLabel = (role: string) => {
  if (role === 'admin') return 'Administrador';
  if (role === 'operator') return 'Operador';
  return 'Visualizador';
};

function apiClient() {
  const accessToken = useAuthStore.getState().accessToken;
  return axios.create({
    baseURL: API_URL,
    headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined,
  });
}

// Piso mínimo do backend (DTO). A política de senha forte é OPCIONAL e fica em
// Configurações → Segurança ("Exigir senha forte").
const PASSWORD_HINT = 'Mín. 4 caracteres.';
function passwordPolicyError(pw: string): string | null {
  if (pw.length < 4) return 'A senha precisa ter ao menos 4 caracteres.';
  return null;
}

// Extrai a mensagem real da API (class-validator devolve string OU array).
function apiErrorMessage(error: unknown, fallback: string): string {
  if (axios.isAxiosError(error)) {
    const m = error.response?.data?.message;
    if (Array.isArray(m)) return m.join('; ');
    if (typeof m === 'string') return m;
  }
  return error instanceof Error ? error.message : fallback;
}

export default function UsuariosPage() {
  const userList = useVmsDataStore((state) => state.users);
  const updateUserActive = useVmsDataStore((state) => state.updateUserActive);
  const loadData = useVmsDataStore((state) => state.load);
  const accessToken = useAuthStore((state) => state.accessToken);
  const currentUser = useAuthStore((state) => state.user);
  const canManageGlobalAccess = currentUser?.role === 'admin';
  const [addOpen, setAddOpen] = useState(false);
  const [editUser, setEditUser] = useState<(typeof userList)[number] | null>(null);
  const [search, setSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'all' | 'admin' | 'operator' | 'viewer'>('all');
  const [groups, setGroups] = useState<AccessGroup[]>([]);
  const [permissions, setPermissions] = useState<AccessPermission[]>([]);
  const [accessLoading, setAccessLoading] = useState(false);
  const [selectedUserId, setSelectedUserId] = useState('');
  const [selectedGroupId, setSelectedGroupId] = useState('');
  const [selectedLevel, setSelectedLevel] = useState<PermissionLevel>('VIEW');
  const [userSaving, setUserSaving] = useState(false);
  const [userForm, setUserForm] = useState({
    name: '',
    email: '',
    password: '',
    role: 'VIEWER' as ApiUserRole,
    isActive: true,
  });

  const availableRoleOptions = canManageGlobalAccess ? roleOptions : roleOptions.filter((option) => option.value !== 'ADMIN');

  const filtered = useMemo(() => userList.filter(u =>
    (!search || u.name.toLowerCase().includes(search.toLowerCase()) || u.email.toLowerCase().includes(search.toLowerCase()))
    && (roleFilter === 'all' || u.role === roleFilter)
  ), [userList, search, roleFilter]);

  const ROLE_FILTS: Array<{ v: typeof roleFilter; l: string }> = [
    { v: 'all', l: 'Todos' },
    { v: 'admin', l: 'Admins' },
    { v: 'operator', l: 'Operadores' },
    { v: 'viewer', l: 'Visualizadores' },
  ];

  const selectedGroup = useMemo(() => groups.find((group) => group.id === selectedGroupId) ?? groups[0] ?? null, [groups, selectedGroupId]);
  const selectedUser = useMemo(() => userList.find((user) => user.id === selectedUserId) ?? userList[0] ?? null, [userList, selectedUserId]);

  const permissionsByUser = useMemo(() => {
    const map = new Map<string, AccessPermission[]>();
    for (const permission of permissions) {
      const list = map.get(permission.userId) ?? [];
      list.push(permission);
      map.set(permission.userId, list);
    }
    return map;
  }, [permissions]);

  const loadAccess = async () => {
    if (!accessToken) return;
    setAccessLoading(true);
    try {
      const client = apiClient();
      const [groupsRes, permissionsRes] = await Promise.all([
        client.get('/camera-groups'),
        client.get('/camera-permissions'),
      ]);
      const loadedGroups = Array.isArray(groupsRes.data) ? groupsRes.data : [];
      setGroups(loadedGroups);
      setPermissions(Array.isArray(permissionsRes.data) ? permissionsRes.data : []);
      if (!selectedGroupId && loadedGroups[0]?.id) setSelectedGroupId(loadedGroups[0].id);
      if (!selectedUserId && userList[0]?.id) setSelectedUserId(userList[0].id);
    } catch (error) {
      toast({
        title: 'Falha ao carregar acessos',
        description: error instanceof Error ? error.message : 'Não foi possível carregar grupos e permissões.',
        variant: 'destructive',
      });
    } finally {
      setAccessLoading(false);
    }
  };

  useEffect(() => {
    void loadAccess();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accessToken, userList.length]);

  useEffect(() => {
    if (!selectedUserId && userList[0]?.id) setSelectedUserId(userList[0].id);
  }, [selectedUserId, userList]);

  useEffect(() => {
    if (editUser) {
      setUserForm({
        name: editUser.name,
        email: editUser.email,
        password: '',
        role: editUser.role === 'admin' ? 'ADMIN' : editUser.role === 'operator' ? 'OPERATOR' : 'VIEWER',
        isActive: editUser.active,
      });
      return;
    }
    if (addOpen) {
      setUserForm({ name: '', email: '', password: '', role: 'VIEWER', isActive: true });
    }
  }, [addOpen, editUser]);

  const toggleLock = async (id: string, active: boolean) => {
    await updateUserActive(id, active);
  };

  // A exclusão é PERMANENTE e usava a caixa cinza do navegador — fora do tema,
  // sem foco preso, um Enter distraído apagava a conta. Excluir um GRUPO, uma
  // ação menos grave, já tinha diálogo completo.
  const [excluirAlvo, setExcluirAlvo] = useState<{ id: string; name: string; email: string } | null>(null);

  const deleteUser = async (u: { id: string; name: string; email: string }) => {
    try {
      await apiClient().delete(`/users/${u.id}/permanent`);
      toast({ title: 'Usuário excluído', description: `${u.name} foi removido do sistema.` });
      if (selectedUserId === u.id) setSelectedUserId('');
      await loadData();
    } catch (error) {
      toast({
        title: 'Falha ao excluir',
        description: apiErrorMessage(error, 'Não foi possível excluir o usuário.'),
        variant: 'destructive',
      });
    }
  };

  const grantGroupAccess = async () => {
    const userId = selectedUser?.id;
    const groupId = selectedGroup?.id;
    if (!userId || !groupId) return;
    setAccessLoading(true);
    try {
      await apiClient().post('/camera-permissions', { userId, groupId, level: selectedLevel });
      await loadAccess();
      toast({ title: 'Acesso liberado', description: `${selectedUser?.name} agora acessa ${selectedGroup?.name}.` });
    } catch (error) {
      toast({
        title: 'Falha ao liberar acesso',
        description: error instanceof Error ? error.message : 'Não foi possível salvar a permissão.',
        variant: 'destructive',
      });
    } finally {
      setAccessLoading(false);
    }
  };

  const revokeAccess = async (permissionId: string) => {
    setAccessLoading(true);
    try {
      await apiClient().delete(`/camera-permissions/${permissionId}`);
      await loadAccess();
    } catch (error) {
      toast({
        title: 'Falha ao remover acesso',
        description: error instanceof Error ? error.message : 'Não foi possível remover a permissão.',
        variant: 'destructive',
      });
    } finally {
      setAccessLoading(false);
    }
  };

  const saveUser = async () => {
    const name = userForm.name.trim();
    const email = userForm.email.trim().toLowerCase();
    if (!name || !email) {
      toast({ title: 'Dados incompletos', description: 'Informe nome e e-mail.', variant: 'destructive' });
      return;
    }
    if (!editUser && !userForm.password) {
      toast({ title: 'Senha obrigatória', description: 'Crie uma senha inicial para o usuário.', variant: 'destructive' });
      return;
    }
    // Valida a política antes de enviar (evita 400 sem explicação).
    if (userForm.password) {
      const pwErr = passwordPolicyError(userForm.password);
      if (pwErr) {
        toast({ title: 'Senha fraca', description: pwErr, variant: 'destructive' });
        return;
      }
    }

    setUserSaving(true);
    try {
      if (editUser) {
        // O frontend só representa 3 papéis; SUPER_ADMIN e ADMIN aparecem como 'admin'.
        // Só envia `role` se o editor realmente mudou o campo, para não rebaixar um
        // SUPER_ADMIN para ADMIN sem querer ao salvar outras alterações.
        const mappedOriginalRole: ApiUserRole = editUser.role === 'admin' ? 'ADMIN' : editUser.role === 'operator' ? 'OPERATOR' : 'VIEWER';
        await apiClient().patch(`/users/${editUser.id}`, {
          name,
          email,
          ...(userForm.role !== mappedOriginalRole ? { role: userForm.role } : {}),
          isActive: userForm.isActive,
          ...(userForm.password ? { password: userForm.password } : {}),
        });
        toast({ title: 'Usuário atualizado', description: `${name} foi atualizado.` });
      } else {
        await apiClient().post('/users', {
          name,
          email,
          password: userForm.password,
          role: userForm.role,
          ...(!canManageGlobalAccess && selectedGroup ? { groupIds: [selectedGroup.id], permissionLevel: selectedLevel } : {}),
        });
        toast({ title: 'Usuário criado', description: `${name} já pode receber acesso a grupos.` });
      }
      setAddOpen(false);
      setEditUser(null);
      setUserForm({ name: '', email: '', password: '', role: 'VIEWER', isActive: true });
      await Promise.all([loadData(), loadAccess()]);
    } catch (error) {
      toast({
        title: editUser ? 'Falha ao atualizar usuário' : 'Falha ao criar usuário',
        description: apiErrorMessage(error, 'Não foi possível salvar o usuário.'),
        variant: 'destructive',
      });
    } finally {
      setUserSaving(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-6 py-3 border-b border-border shrink-0 flex items-center justify-end gap-2">
          <div className="input-wrap w-44">
            <span className="input-icon"><Search className="w-3.5 h-3.5" /></span>
            <input className="input" style={{ height: 32, fontSize: 12 }} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Buscar usuário..." />
          </div>
          <button onClick={() => void loadAccess()} disabled={accessLoading} className="btn btn-secondary btn-sm">
            <RefreshCw className={cn('h-3.5 w-3.5', accessLoading && 'animate-spin')} /> Atualizar
          </button>
          <button onClick={() => setAddOpen(true)} className="btn btn-primary btn-sm">
            <Plus className="h-3.5 w-3.5" /> Novo usuário
          </button>
      </div>

      {/* Filtros por papel */}
      <div className="px-5 py-2 border-b border-border shrink-0 flex gap-1">
        {ROLE_FILTS.map((f) => (
          <button key={f.v} onClick={() => setRoleFilter(f.v)} className={`ops-pill ${roleFilter === f.v ? 'ops-pill-active' : ''}`}>
            {f.l}
          </button>
        ))}
      </div>

      {/* Tabela de usuários */}
      <div className="flex-1 overflow-y-auto p-5">
        <div className="ops-card overflow-hidden">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-10">
              <tr className="border-b border-border">
                {['Usuário', 'Perfil', 'Grupos', 'Status', 'Ações'].map(h => (
                  <th key={h} className="px-3 py-2.5 text-left font-medium text-[hsl(var(--muted-foreground))] whitespace-nowrap">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map((u) => {
                const initials = u.name.split(' ').map((n) => n[0]).join('').slice(0, 2).toUpperCase();
                const groupPermissions = (permissionsByUser.get(u.id) ?? []).filter((p) => p.groupId);
                return (
                  <tr
                    key={u.id}
                    className={cn('hover:bg-[hsl(var(--accent))] transition-colors cursor-pointer', !u.active && 'opacity-60')}
                    onClick={() => { setEditUser(u); setSelectedUserId(u.id); }}
                  >
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-2.5">
                        <div className="flex items-center justify-center text-[13px] font-bold shrink-0" style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--surf-3)', border: '1px solid var(--bdr)', color: 'var(--tx-2)' }}>{initials}</div>
                        <div className="min-w-0">
                          <div className="font-medium truncate">{u.name}</div>
                          <div className="text-[10px] font-mono text-[hsl(var(--muted-foreground))] truncate">{u.email}</div>
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-[hsl(var(--muted-foreground))]">{visibleRoleLabel(u.role)}</td>
                    <td className="px-3 py-2.5">
                      {groupPermissions.length > 0 ? (
                        <span className="text-[hsl(var(--muted-foreground))] truncate block max-w-[200px]" title={groupPermissions.map((p) => p.group?.name).filter(Boolean).join(', ')}>
                          {groupPermissions.map((p) => p.group?.name).filter(Boolean).join(', ')}
                        </span>
                      ) : (
                        <span className="text-[hsl(var(--muted-foreground))] opacity-50">-</span>
                      )}
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1.5">
                        <span className="w-1.5 h-1.5 rounded-full" style={{ background: u.active ? 'var(--s-online)' : 'var(--s-offline)' }} />
                        <span className="text-[10px]" style={{ color: 'var(--tx-3)' }}>{u.active ? 'Ativo' : 'Bloqueado'}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <div className="flex items-center gap-1" onClick={e => e.stopPropagation()}>
                        <button onClick={() => { setEditUser(u); setSelectedUserId(u.id); }} className="w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--chart-2))] hover:bg-[hsl(var(--accent))] transition-colors" title="Editar">
                          <Edit2 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => void toggleLock(u.id, !u.active)}
                          className={cn("w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:bg-[hsl(var(--accent))] transition-colors", u.active ? "hover:text-[hsl(var(--destructive))]" : "hover:text-[hsl(var(--status-online))]")}
                          title={u.active ? 'Bloquear usuário' : 'Desbloquear usuário'}
                        >
                          {u.active ? <UserX className="w-3.5 h-3.5" /> : <Unlock className="w-3.5 h-3.5" />}
                        </button>
                        {u.id !== currentUser?.id && (
                          <button
                            onClick={() => setExcluirAlvo({ id: u.id, name: u.name, email: u.email })}
                            className="w-6 h-6 flex items-center justify-center rounded text-[hsl(var(--muted-foreground))] hover:text-[hsl(var(--destructive))] hover:bg-[hsl(var(--accent))] transition-colors"
                            title="Excluir permanentemente"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!filtered.length && (
                <tr>
                  <td colSpan={5} className="py-16 text-center">
                    <div className="flex flex-col items-center justify-center gap-2" style={{ color: 'var(--tx-4)' }}>
                      <MoreHorizontal className="w-8 h-8 opacity-40" />
                      <span className="text-xs">Nenhum usuário encontrado</span>
                    </div>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <Dialog open={addOpen || !!editUser} onOpenChange={(o) => { if (!o) { setAddOpen(false); setEditUser(null); } }}>
        <DialogContent className="max-w-md border-border bg-card max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editUser ? `Editar usuário - ${editUser.name}` : 'Novo usuário'}</DialogTitle>
            <DialogDescription>
              {editUser ? 'Atualize os dados, o perfil de acesso ou a senha.' : 'Preencha os dados para criar uma nova conta de acesso.'}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-2 space-y-3">
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Nome completo</label>
              <input
                value={userForm.name}
                onChange={(event) => setUserForm((current) => ({ ...current, name: event.target.value }))}
                placeholder="Nome do usuário"
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">E-mail</label>
              <input
                value={userForm.email}
                onChange={(event) => setUserForm((current) => ({ ...current, email: event.target.value }))}
                placeholder="cliente@empresa.com"
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">Perfil</label>
              <select
                value={userForm.role}
                onChange={(event) => setUserForm((current) => ({ ...current, role: event.target.value as ApiUserRole }))}
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              >
                {availableRoleOptions.map((role) => <option key={role.value} value={role.value}>{role.label}</option>)}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs font-medium text-muted-foreground">{editUser ? 'Nova senha' : 'Senha inicial'}</label>
              <input
                type="password"
                value={userForm.password}
                onChange={(event) => setUserForm((current) => ({ ...current, password: event.target.value }))}
                placeholder={editUser ? 'Deixe em branco para manter' : PASSWORD_HINT}
                className="h-8 w-full rounded border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
              />
              <p className="mt-1 text-[10px] text-muted-foreground">{editUser ? `Em branco mantém a atual. ${PASSWORD_HINT}` : PASSWORD_HINT}</p>
            </div>
            {editUser ? (
              <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 px-3 py-2.5">
                <span className="text-xs font-medium">Usuário ativo</span>
                <Switch
                  checked={userForm.isActive}
                  onCheckedChange={(value) => setUserForm((current) => ({ ...current, isActive: value }))}
                />
              </div>
            ) : null}

            {editUser && canManageGlobalAccess ? (
              <div className="pt-3 mt-1 border-t border-border">
                <p className="text-xs font-semibold">Acesso por grupo</p>
                <p className="mb-2 text-[11px] text-muted-foreground">O usuário vê apenas as câmeras dos grupos liberados.</p>
                <div className="grid grid-cols-2 gap-2">
                  <select
                    value={selectedGroupId}
                    onChange={(event) => setSelectedGroupId(event.target.value)}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  <select
                    value={selectedLevel}
                    onChange={(event) => setSelectedLevel(event.target.value as PermissionLevel)}
                    className="h-9 rounded-lg border border-border bg-background px-3 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
                  >
                    {(Object.keys(levelLabel) as PermissionLevel[]).map((lvl) => <option key={lvl} value={lvl}>{levelLabel[lvl]}</option>)}
                  </select>
                </div>
                <button
                  onClick={() => void grantGroupAccess()}
                  disabled={accessLoading || !selectedGroup}
                  className="mt-2 inline-flex h-9 w-full items-center justify-center gap-2 rounded-lg border border-border bg-card text-xs hover:bg-accent disabled:opacity-50"
                >
                  <Save className="h-3.5 w-3.5" /> Liberar acesso a grupo
                </button>
                <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
                  {(permissionsByUser.get(editUser.id) ?? []).filter((p) => p.groupId).map((permission) => (
                    <div key={permission.id} className="flex items-center justify-between rounded-lg border border-border bg-background/55 px-3 py-2 text-xs">
                      <div className="min-w-0">
                        <p className="truncate font-medium">{permission.group?.name ?? 'Grupo'}</p>
                        <p className="text-[11px] text-muted-foreground">{levelLabel[permission.level]}</p>
                      </div>
                      <button
                        onClick={() => void revokeAccess(permission.id)}
                        disabled={accessLoading}
                        className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
                        title="Remover acesso"
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                  {!(permissionsByUser.get(editUser.id) ?? []).some((p) => p.groupId) && (
                    <p className="text-[11px] text-muted-foreground">Nenhum grupo liberado ainda.</p>
                  )}
                </div>
              </div>
            ) : null}

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={() => { setAddOpen(false); setEditUser(null); }} className="h-8 rounded border border-border px-4 text-xs hover:bg-accent">Cancelar</button>
              <button
                onClick={() => void saveUser()}
                disabled={userSaving}
                className="h-8 rounded bg-primary px-4 text-xs text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              >
                {editUser ? 'Salvar alterações' : 'Criar usuário'}
              </button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
      {/* Exclusão PERMANENTE: diálogo do sistema, foco preso, ação em vermelho. */}
      {excluirAlvo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div role="alertdialog" aria-modal="true" className="w-full max-w-md rounded-xl border border-[hsl(var(--destructive)_/_0.4)] bg-card p-5 shadow-xl">
            <h2 className="text-sm font-semibold text-[hsl(var(--destructive))]">Excluir permanentemente?</h2>
            <p className="mt-2 text-xs text-muted-foreground">
              A conta de <b className="text-foreground">{excluirAlvo.name}</b> ({excluirAlvo.email}) será
              removida do sistema. <b>Não pode ser desfeito.</b> O histórico de auditoria é preservado
              de forma anonimizada.
            </p>
            <div className="mt-4 flex justify-end gap-2">
              <button type="button" onClick={() => setExcluirAlvo(null)} className="btn btn-primary btn-sm">
                Cancelar
              </button>
              <button
                type="button"
                onClick={() => { const alvo = excluirAlvo; setExcluirAlvo(null); void deleteUser(alvo); }}
                className="btn btn-sm border-[hsl(var(--destructive)_/_0.45)] text-[hsl(var(--destructive))] hover:bg-[hsl(var(--destructive)_/_0.1)]"
              >
                Excluir permanentemente
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
