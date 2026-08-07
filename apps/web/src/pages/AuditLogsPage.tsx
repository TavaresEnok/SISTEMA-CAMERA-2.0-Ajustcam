import { useMemo, useState } from 'react';
import { ClipboardList, Filter, Search } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useVmsDataStore } from '../store/vmsDataStore';

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString('pt-BR');
}

export default function AuditLogsPage() {
  const logs = useVmsDataStore((state) => state.auditLogs);
  const [filterUser, setFilterUser] = useState('all');
  const [filterAction, setFilterAction] = useState('all');
  const [search, setSearch] = useState('');

  const users = useMemo(() => ['all', ...Array.from(new Set(logs.map((log) => log.userId ?? 'system'))).sort()], [logs]);
  const actionTypes = useMemo(() => ['all', ...Array.from(new Set(logs.map((log) => log.action))).sort()], [logs]);

  const filtered = useMemo(() => {
    const query = search.trim().toLowerCase();
    return logs.filter((log) => {
      const resource = `${log.entityType}${log.entityId ? `:${log.entityId}` : ''}`;
      const user = log.userId ?? 'system';
      if (filterUser !== 'all' && user !== filterUser) return false;
      if (filterAction !== 'all' && log.action !== filterAction) return false;
      if (query && !`${log.action} ${resource} ${user} ${log.ipAddress ?? ''}`.toLowerCase().includes(query)) return false;
      return true;
    });
  }, [filterAction, filterUser, logs, search]);

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-border px-6 py-5">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-border bg-card text-primary">
              <ClipboardList className="h-4 w-4" />
            </span>
            <div>
              <h1 className="text-lg font-semibold tracking-tight">Auditoria</h1>
              <p className="mt-0.5 text-xs text-muted-foreground">Ações administrativas e operacionais registradas pelo backend.</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Buscar"
                className="h-9 w-52 rounded-md border border-border bg-card pl-8 pr-3 text-xs outline-none focus:border-primary/50 focus:ring-1 focus:ring-primary/30"
              />
            </div>
            <Select value={filterUser} onValueChange={setFilterUser}>
              <SelectTrigger className="h-9 w-40 text-xs">
                <SelectValue placeholder="Usuário" />
              </SelectTrigger>
              <SelectContent>
                {users.map((user) => (
                  <SelectItem key={user} value={user} className="text-xs">
                    {user === 'all' ? 'Todos usuários' : user === 'system' ? 'Sistema' : user}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Select value={filterAction} onValueChange={setFilterAction}>
              <SelectTrigger className="h-9 w-44 text-xs">
                <SelectValue placeholder="Ação" />
              </SelectTrigger>
              <SelectContent>
                {actionTypes.map((action) => (
                  <SelectItem key={action} value={action} className="text-xs">
                    {action === 'all' ? 'Todas ações' : action}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-auto p-6">
        <div className="overflow-hidden rounded-lg border border-border bg-card shadow-sm">
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <div className="flex items-center gap-2 text-xs font-semibold">
              <Filter className="h-3.5 w-3.5 text-primary" />
              {filtered.length} registro(s)
            </div>
            <div className="text-[11px] text-muted-foreground">Atualizado em {new Date().toLocaleString('pt-BR')}</div>
          </div>

          <table className="w-full text-sm">
            <thead className="bg-background/70">
              <tr>
                {/* Sem coluna "Resultado": o modelo AuditLog do banco não guarda
                    resultado nenhum, e a tela carimbava o literal "Sucesso" em
                    TODA linha — auditoria que afirma sucesso numa ação que
                    falhou é pior que auditoria nenhuma. */}
                {['Data/hora', 'Usuário', 'Ação', 'Recurso', 'IP'].map((heading) => (
                  <th key={heading} className="px-4 py-2.5 text-left text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                    {heading}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/70">
              {filtered.map((log) => (
                <tr key={log.id} className="transition-colors hover:bg-accent/35">
                  <td className="whitespace-nowrap px-4 py-3 font-mono text-[11px] text-muted-foreground">{formatDate(log.createdAt)}</td>
                  <td className="px-4 py-3 text-xs font-medium">{log.userId ?? 'Sistema'}</td>
                  <td className="px-4 py-3 text-xs">{log.action}</td>
                  <td className="max-w-xs truncate px-4 py-3 font-mono text-[11px] text-muted-foreground">
                    {log.entityType}{log.entityId ? ` / ${log.entityId}` : ''}
                  </td>
                  <td className="px-4 py-3 font-mono text-[11px] text-muted-foreground">{log.ipAddress ?? '-'}</td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-4 py-12 text-center text-sm text-muted-foreground">
                    Nenhum registro corresponde aos filtros atuais.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
