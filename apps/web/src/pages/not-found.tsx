import { Link } from 'wouter';
import { AlertCircle, Monitor } from 'lucide-react';
import { useBrandingStore } from '../store/brandingStore';

export default function NotFound() {
  const facilityName = useBrandingStore((state) => state.facilityName);
  return (
    <div className="app-main flex min-h-screen w-full items-center justify-center p-4">
      <div className="ops-card w-full max-w-md p-8 text-center">
        <div className="mx-auto mb-5 flex h-12 w-12 items-center justify-center rounded-lg border border-[hsl(var(--destructive)_/_0.22)] bg-[hsl(var(--destructive)_/_0.10)]">
          <AlertCircle className="h-5 w-5 text-[hsl(var(--destructive))]" />
        </div>
        <div className="mx-auto mb-3 inline-flex items-center rounded-full border border-[hsl(var(--border)_/_0.75)] bg-[hsl(var(--background)_/_0.36)] px-2.5 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
          {facilityName}
        </div>
        <h1 className="text-[18px] font-semibold tracking-normal">Página não encontrada</h1>
        <p className="mx-auto mt-2 max-w-xs text-[12px] leading-relaxed text-muted-foreground">
          A página que você procura não existe ou foi movida.
        </p>
        <Link href="/live">
          <a className="mt-6 inline-flex h-9 items-center justify-center gap-2 rounded-md bg-[hsl(var(--primary))] px-4 text-xs font-semibold text-[hsl(var(--primary-foreground))] transition-opacity hover:opacity-90">
            <Monitor className="h-3.5 w-3.5" />
            Voltar ao Ao Vivo
          </a>
        </Link>
      </div>
    </div>
  );
}
