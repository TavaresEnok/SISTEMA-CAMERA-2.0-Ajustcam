import { useState } from 'react';
import { useLocation } from 'wouter';
import { Eye, EyeOff, Lock, AlertCircle, CheckCircle2 } from 'lucide-react';
import axios from 'axios';
import { getApiBaseUrl } from '../lib/api-base';

export default function ResetPasswordPage() {
  const [, setLocation] = useLocation();
  const token = new URLSearchParams(window.location.search).get('token') ?? '';

  const [newPassword, setNewPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);

  const getErrorMessage = (err: unknown) => {
    if (!axios.isAxiosError(err)) return 'Não foi possível redefinir a senha agora. Tente novamente.';
    if (!err.response) return 'Não foi possível conectar à API. Verifique a conexão ou recarregue a página.';
    if (err.response.status === 401) return 'Link de redefinição inválido ou expirado. Solicite um novo.';
    const message = (err.response.data as { message?: string | string[] })?.message;
    if (Array.isArray(message)) return message.join(' ');
    if (typeof message === 'string') return message;
    return 'Falha ao redefinir a senha. Tente novamente em instantes.';
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token) { setError('Link de redefinição inválido. Solicite um novo.'); return; }
    if (!newPassword.trim()) { setError('Informe a nova senha.'); return; }
    setLoading(true);
    setError('');
    try {
      await axios.post(`${getApiBaseUrl()}/auth/reset-password`, { token, newPassword });
      setDone(true);
    } catch (err) {
      setError(getErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden overflow-y-auto p-6" style={{ background: 'var(--bg)' }}>
      <div
        className="relative w-full"
        style={{
          maxWidth: 384,
          background: 'var(--surf-1)',
          border: '1px solid var(--bdr)',
          borderRadius: 18,
          boxShadow: 'var(--shadow-lg), 0 0 0 1px hsl(var(--primary) / 0.04)',
          padding: '38px 34px 28px',
        }}
      >
        <h1 className="text-[17px] font-bold mb-1" style={{ color: 'var(--tx)' }}>Redefinir senha</h1>
        <p className="text-[11px] mb-5" style={{ color: 'var(--tx-3)' }}>Defina a nova senha de acesso à sua conta.</p>

        {done ? (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--s-online)', background: 'rgba(72,200,120,.08)', border: '1px solid rgba(72,200,120,.2)', borderRadius: 8, padding: '8px 11px' }}>
              <CheckCircle2 size={13} /> Senha redefinida com sucesso.
            </div>
            <button onClick={() => setLocation('/login')} className="btn btn-primary" style={{ height: 40, fontSize: 12, fontWeight: 700 }}>
              Ir para o login
            </button>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
            <div>
              <label htmlFor="new-password" className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--tx-3)' }}>Nova senha</label>
              <div className="relative">
                <div className="input-wrap">
                  <span className="input-icon"><Lock size={13} /></span>
                  <input
                    id="new-password"
                    autoComplete="new-password"
                    className="input"
                    type={showPassword ? 'text' : 'password'}
                    value={newPassword}
                    onChange={(e) => { setNewPassword(e.target.value); setError(''); }}
                    placeholder="Mínimo 10 caracteres"
                    style={{ paddingRight: 34 }}
                    autoFocus
                  />
                </div>
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 flex"
                  style={{ background: 'none', border: 'none', color: 'var(--tx-3)', cursor: 'pointer' }}
                  aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'}
                >
                  {showPassword ? <EyeOff size={13} /> : <Eye size={13} />}
                </button>
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 text-[11px]" style={{ color: '#E07878', background: 'rgba(200,72,72,.08)', border: '1px solid rgba(200,72,72,.2)', borderRadius: 8, padding: '8px 11px' }}>
                <AlertCircle size={13} /> {error}
              </div>
            )}

            <button type="submit" disabled={loading} className="btn btn-primary" style={{ height: 44, fontSize: 13, fontWeight: 700, borderRadius: 11, marginTop: 6 }}>
              {loading ? 'Redefinindo...' : 'Redefinir senha'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}
