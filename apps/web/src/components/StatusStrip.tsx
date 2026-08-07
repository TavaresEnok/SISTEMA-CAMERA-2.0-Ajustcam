import { useState, useEffect } from 'react';
import { format } from 'date-fns';
import { useAuthStore } from '../store/authStore';
import { useVmsDataStore } from '../store/vmsDataStore';
import { PRODUCT_NAME } from '../lib/product-brand';

export function StatusStrip() {
  const [now, setNow] = useState(new Date());
  const { user } = useAuthStore();
  const alarms = useVmsDataStore((state) => state.alarms);
  const cameras = useVmsDataStore((state) => state.cameras);
  const system = useVmsDataStore((state) => state.system);
  const stale = useVmsDataStore((state) => state.stale);
  const lastUpdatedAt = useVmsDataStore((state) => state.lastUpdatedAt);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const activeAlertas   = alarms.filter(a => a.status === 'active').length;
  const onlineCameras  = cameras.filter(c => c.isOnline).length;
  const totalCameras   = cameras.length;
  const diskCritical   = Boolean(system && system.disk.usagePercent >= 95);
  const systemOk       = !stale && system?.status !== 'error' && !diskCritical;
  const systemLabel    = stale
    ? 'Conexão instável'
    : diskCritical
      ? 'Disco crítico'
      : system?.status === 'error'
        ? 'Serviço com falha'
        : 'Sistema online';

  return (
    <div
      className="h-6 shrink-0 flex items-center px-3 sm:px-4 border-t border-border bg-sidebar select-none"
      style={{ fontSize: '10px' }}
    >
      {/* Left: system status */}
      <div className="flex items-center gap-2 flex-1 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${systemOk ? 'status-online' : 'status-alarm rec-pulse'}`} />
        <span className="text-[hsl(var(--muted-foreground))] truncate">
          {PRODUCT_NAME}
        </span>
        <span className="text-[hsl(var(--border))] hidden sm:block">│</span>
        <span className="text-[hsl(var(--muted-foreground))] hidden sm:block">
          <span className={systemOk ? 'text-[hsl(var(--status-online))]' : 'text-[hsl(var(--destructive))]'}>
            {systemLabel}
          </span>
        </span>
        {system && (
          <>
            <span className="text-[hsl(var(--border))] hidden sm:block">│</span>
            <span className="text-[hsl(var(--muted-foreground))] hidden sm:block truncate">
              Disco {system.disk.usagePercent}%
            </span>
          </>
        )}
      </div>

      {/* Center: active alarms + cameras */}
      <div className="flex items-center gap-4 px-4">
        {activeAlertas > 0 && (
          <span className="text-[hsl(var(--destructive)_/_0.85)]">
            {activeAlertas} Alerta ativo{activeAlertas !== 1 ? 's' : ''}
          </span>
        )}
        <span className="text-[hsl(var(--muted-foreground))]">
          <span className="text-[hsl(var(--status-online))]">{onlineCameras}</span>
          <span>/{totalCameras} online</span>
        </span>
      </div>

      {/* Right: user + timestamp */}
      <div className="flex items-center gap-3 flex-1 justify-end min-w-0">
        {user && (
          <>
            <span className="text-[hsl(var(--muted-foreground))] hidden sm:block truncate">
              {user.name} · <span className="capitalize">{user.role}</span>
            </span>
            <span className="text-[hsl(var(--border))] hidden sm:block">│</span>
          </>
        )}
        <span className="text-[hsl(var(--muted-foreground))] shrink-0 tabular-nums">
          {format(now, 'HH:mm:ss')}
        </span>
        {lastUpdatedAt && (
          <span className="hidden lg:block text-[hsl(var(--muted-foreground))] tabular-nums" title="Última atualização operacional">
            dados {format(new Date(lastUpdatedAt), 'HH:mm:ss')}
          </span>
        )}
      </div>
    </div>
  );
}
