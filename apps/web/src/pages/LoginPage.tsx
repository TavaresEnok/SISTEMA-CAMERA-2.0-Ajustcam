import { useState, useEffect } from 'react';
import { useLocation } from 'wouter';
import { Eye, EyeOff, Lock, Mail, User, AlertCircle, ShieldCheck, X } from 'lucide-react';
import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { getApiBaseUrl } from '../lib/api-base';
import { useBrandingStore } from '../store/brandingStore';
import { PRODUCT_NAME } from '../lib/product-brand';

function ForgotPasswordModal({ onClose }: { onClose: () => void }) {
  const [email, setEmail] = useState('');
  const [sending, setSending] = useState(false);
  const [done, setDone] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim()) return;
    setSending(true);
    try {
      await axios.post(`${getApiBaseUrl()}/auth/forgot-password`, { email: email.trim() });
    } catch {
      // resposta é sempre genérica para não revelar se o e-mail existe
    } finally {
      setSending(false);
      setDone(true);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-6"
      style={{ background: 'rgba(0,0,0,.5)' }}
      onClick={onClose}
    >
      <div
        className="relative w-full"
        style={{ maxWidth: 360, background: 'var(--surf-1)', border: '1px solid var(--bdr)', borderRadius: 16, padding: '24px 22px' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          onClick={onClose}
          className="absolute right-3 top-3"
          style={{ background: 'none', border: 'none', color: 'var(--tx-3)', cursor: 'pointer' }}
          aria-label="Fechar"
        >
          <X size={15} />
        </button>
        <h2 className="text-[15px] font-bold mb-1" style={{ color: 'var(--tx)' }}>Esqueci minha senha</h2>
        {done ? (
          <p className="text-[12px] mt-3" style={{ color: 'var(--tx-3)' }}>
            Se o e-mail informado estiver cadastrado, enviamos um link para redefinição de senha. Verifique sua caixa de entrada.
          </p>
        ) : (
          <form onSubmit={submit} className="flex flex-col gap-3 mt-3">
            <p className="text-[11px]" style={{ color: 'var(--tx-3)' }}>
              Informe o e-mail da sua conta para receber um link de redefinição de senha.
            </p>
            <div className="input-wrap">
              <span className="input-icon"><Mail size={13} /></span>
              <input
                className="input"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="email@exemplo.com"
                autoFocus
                required
              />
            </div>
            <button type="submit" disabled={sending} className="btn btn-primary" style={{ height: 38, fontSize: 12, fontWeight: 700 }}>
              {sending ? 'Enviando...' : 'Enviar link de redefinição'}
            </button>
          </form>
        )}
      </div>
    </div>
  );
}

function LogoAjustCam({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" style={{ color: 'var(--acc)', flexShrink: 0 }}>
      <rect x="4.5" y="7" width="23" height="18" rx="5" stroke="currentColor" strokeWidth="1.5" opacity="0.75" />
      <circle cx="16" cy="16" r="6" stroke="currentColor" strokeWidth="1.25" opacity="0.7" />
      <circle cx="16" cy="16" r="3" fill="currentColor" opacity="0.95" />
      <circle cx="17.2" cy="14.8" r="0.8" fill="white" opacity="0.45" />
      <path d="M9 7V5.5h5L15.5 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" opacity="0.75" />
    </svg>
  );
}

export default function LoginPage() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const { login, isAuthenticated } = useAuthStore();
  const [, setLocation] = useLocation();
  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const facilityName = useBrandingStore((state) => state.facilityName);
  const logoDataUrl = useBrandingStore((state) => state.logoDataUrl);

  const getLoginErrorMessage = (err: unknown) => {
    if (!axios.isAxiosError(err)) return 'Não foi possível autenticar agora. Tente novamente.';
    if (!err.response) return 'Não foi possível conectar à API. Verifique a conexão ou recarregue a página.';
    // A MENSAGEM DO SERVIDOR VEM PRIMEIRO. A API responde 401 com texto
    // específico quando a conta está BLOQUEADA por excesso de tentativas
    // ("tente novamente em X min") — e ele era descartado em favor de
    // "Credenciais inválidas". O operador continuava tentando achando que
    // digitou errado, e cada tentativa ESTENDIA o próprio bloqueio.
    const doServidor = (err.response.data as { message?: string | string[] } | undefined)?.message;
    const texto = Array.isArray(doServidor) ? doServidor.join(' ') : doServidor;
    if (typeof texto === 'string' && texto.trim()) return texto.trim();
    // Limite de tentativas por minuto: virava "falha no servidor" e o usuário
    // abria chamado reportando o sistema fora do ar.
    if (err.response.status === 429) return 'Muitas tentativas seguidas. Aguarde um minuto e tente novamente.';
    if (err.response.status === 401) return 'Credenciais inválidas ou usuário inativo';
    return 'Falha no servidor de autenticação. Tente novamente em instantes.';
  };

  useEffect(() => {
    if (isAuthenticated) setLocation('/live');
  }, [isAuthenticated, setLocation]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) { setError('Usuário é obrigatório'); return; }
    if (!password.trim()) { setError('Senha é obrigatória'); return; }
    setLoading(true);
    setError('');
    try {
      await login(username, password);
      setLocation('/live');
    } catch (err) {
      setError(getLoginErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative flex min-h-[100dvh] w-full items-center justify-center overflow-x-hidden overflow-y-auto p-6" style={{ background: 'var(--bg)' }}>
      {/* Camadas decorativas de fundo */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          backgroundImage:
            'linear-gradient(var(--bdr-lo) 1px, transparent 1px), linear-gradient(90deg, var(--bdr-lo) 1px, transparent 1px)',
          backgroundSize: '44px 44px',
          maskImage: 'radial-gradient(circle at 50% 38%, #000 0%, transparent 72%)',
          WebkitMaskImage: 'radial-gradient(circle at 50% 38%, #000 0%, transparent 72%)',
        }}
      />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(620px circle at 50% -8%, hsl(var(--primary) / 0.18), transparent 60%), radial-gradient(480px circle at 50% 108%, hsl(var(--primary) / 0.07), transparent 60%)',
        }}
      />

      {/* Cartão */}
      <div
        className="relative w-full"
        style={{
          maxWidth: 384,
          background: 'var(--surf-1)',
          border: '1px solid var(--bdr)',
          borderRadius: 18,
          boxShadow: 'var(--shadow-lg), 0 0 0 1px hsl(var(--primary) / 0.04)',
          padding: '38px 34px 28px',
          animation: 'loginIn .5s cubic-bezier(.2,.7,.2,1) both',
        }}
      >
        {/* Faixa de acento no topo */}
        <div
          style={{
            position: 'absolute', top: 0, left: 24, right: 24, height: 2, borderRadius: 2,
            background: 'linear-gradient(90deg, transparent, var(--acc), transparent)', opacity: 0.85,
          }}
        />

        {/* Marca */}
        <div className="text-center" style={{ marginBottom: 28 }}>
          <div className="relative mx-auto" style={{ width: 60, height: 60, marginBottom: 16 }}>
            <div style={{ position: 'absolute', inset: -6, borderRadius: 20, background: 'radial-gradient(circle, hsl(var(--primary) / 0.22), transparent 70%)', filter: 'blur(2px)' }} />
            <div
              className="relative flex h-full w-full items-center justify-center overflow-hidden"
              style={{ borderRadius: 17, background: 'linear-gradient(150deg, var(--acc-dim), transparent)', border: '1px solid var(--acc-bdr)' }}
            >
              {logoDataUrl ? <img src={logoDataUrl} alt={facilityName} className="h-[30px] w-[30px] object-contain" /> : <LogoAjustCam size={30} />}
            </div>
          </div>
          <h1 className="text-[23px] font-bold" style={{ color: 'var(--tx)', letterSpacing: '-0.01em' }}>{facilityName}</h1>
          <p className="mt-1 font-mono text-[9px] uppercase" style={{ color: 'var(--tx-4)', letterSpacing: '0.22em' }}>{PRODUCT_NAME} · Central de Monitoramento</p>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-3.5">
          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--tx-3)' }} htmlFor="username">Usuário</label>
            <div className="input-wrap">
              <span className="input-icon"><User size={13} /></span>
              <input
                id="username"
                className="input"
                type="text"
                value={username}
                onChange={(e) => { setUsername(e.target.value); setError(''); }}
                placeholder="seu@email.com"
                autoFocus
                name="username"
                autoComplete="username"
                data-testid="input-username"
              />
            </div>
          </div>

          <div>
            <label className="mb-1.5 block text-[10px] font-semibold uppercase tracking-[0.08em]" style={{ color: 'var(--tx-3)' }} htmlFor="password">Senha</label>
            <div className="relative">
              <div className="input-wrap">
                <span className="input-icon"><Lock size={13} /></span>
                <input
                  id="password"
                  className="input"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => { setPassword(e.target.value); setError(''); }}
                  placeholder="••••••••"
                  style={{ paddingRight: 34 }}
                  name="password"
                  autoComplete="current-password"
                  data-testid="input-password"
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
            <div className="mt-1.5 text-right">
              <button
                type="button"
                onClick={() => setShowForgotPassword(true)}
                className="text-[10.5px] font-medium"
                style={{ background: 'none', border: 'none', color: 'var(--tx-3)', cursor: 'pointer', textDecoration: 'underline' }}
              >
                Esqueci minha senha
              </button>
            </div>
          </div>

          {error && (
            // `role="alert"`: sem isto, quem usa leitor de tela apertava Enter e
            // não recebia nenhuma informação de que a senha foi rejeitada.
            // Cor pelo token de TEXTO (--s-alarm-tx): o hex #E07878 dava 2,6:1
            // sobre o fundo claro — passava no tema escuro, por isso ninguém viu.
            <div role="alert" className="flex items-center gap-2 text-[11px]" style={{ color: 'var(--s-alarm-tx)', background: 'rgba(200,72,72,.08)', border: '1px solid rgba(200,72,72,.2)', borderRadius: 8, padding: '8px 11px' }}>
              <AlertCircle size={13} /> {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="btn btn-primary"
            style={{
              height: 44, width: '100%', fontSize: 13, fontWeight: 700, borderRadius: 11, marginTop: 6,
              boxShadow: '0 8px 20px -6px hsl(var(--primary) / 0.45)',
            }}
            data-testid="button-login"
          >
            {loading ? (
              <span className="flex items-center gap-2">
                <span style={{ width: 14, height: 14, border: '2px solid rgba(255,255,255,.3)', borderTopColor: '#fff', borderRadius: '50%', animation: 'spin 0.7s linear infinite', display: 'inline-block' }} />
                Autenticando...
              </span>
            ) : 'Entrar no Sistema'}
          </button>
        </form>

        {/* Rodapé */}
        <div className="mt-7 flex items-center justify-between border-t pt-4" style={{ borderColor: 'var(--bdr-lo)' }}>
          <span className="flex items-center gap-1.5 text-[10px]" style={{ color: 'var(--tx-3)' }}>
            <ShieldCheck size={12} style={{ color: 'var(--s-online)' }} />
            Conexão local segura
          </span>
          <span className="font-mono text-[9px]" style={{ color: 'var(--tx-4)' }}>{PRODUCT_NAME}</span>
        </div>
      </div>

      {showForgotPassword && <ForgotPasswordModal onClose={() => setShowForgotPassword(false)} />}

      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @keyframes loginIn { from { opacity: 0; transform: translateY(14px) scale(.98); } to { opacity: 1; transform: none; } }
      `}</style>
    </div>
  );
}
