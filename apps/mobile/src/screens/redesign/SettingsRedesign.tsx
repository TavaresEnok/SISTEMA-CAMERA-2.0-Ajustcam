/**
 * Ajustes (redesign) — réplica da tela "Ajustes" do mockup: card de perfil, card do
 * provedor/plano (selo Ativo), preferências (tema escuro, notificações de movimento),
 * armazenamento, lista de ações, sair. Ligado ao usuário/tema reais.
 */
import Constants from 'expo-constants';
import { useState } from 'react';
import { ScrollView, StyleSheet, Switch, Text, TouchableOpacity, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { Icon, type IconName } from '../../components/Icon';
import { AddCameraSheet } from '../../components/AddCameraSheet';

const TITLE = 'Sora';
const UI = 'InstrumentSans';
const MONO = 'JetBrainsMono';

interface Props {
  user: { name?: string | null; email?: string } | null;
  apiUrl: string;
  token?: string | null;
  connected: boolean;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  biometricLabel: string;
  onBiometricChange: (enabled: boolean) => void;
  onLogout: () => void;
  onCamerasChanged?: () => void;
  facilityName?: string;
}

function initials(name?: string | null): string {
  const p = (name ?? '').trim().split(/\s+/).filter(Boolean);
  return (!p.length ? 'U' : (p[0][0] + (p[1]?.[0] ?? ''))).toUpperCase();
}

export function SettingsRedesign(props: Props) {
  const { user, apiUrl, token, connected, biometricAvailable, biometricEnabled, biometricLabel, onBiometricChange, onLogout, onCamerasChanged, facilityName } = props;
  const { theme, themeMode, setThemeMode } = useTheme();
  const [addCameraOpen, setAddCameraOpen] = useState(false);
  const s = makeStyles(theme);
  const isDark = themeMode === 'dark' || (themeMode === 'system' && theme.mode === 'dark');
  const version = Constants.expoConfig?.version ?? '1.0';

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView contentContainerStyle={s.root} showsVerticalScrollIndicator={false}>
        <Text style={s.title}>Ajustes</Text>

        {/* Perfil */}
        <View style={s.card}>
          <View style={s.avatar}><Text style={s.avatarText}>{initials(user?.name)}</Text></View>
          <View style={{ flex: 1 }}>
            <Text style={s.profileName} numberOfLines={1}>{user?.name || 'Usuário'}</Text>
            <Text style={s.profileEmail} numberOfLines={1}>{user?.email || '—'}</Text>
          </View>
        </View>

        {/* Provedor / plano */}
        <View style={[s.card, { marginTop: 12 }]}>
          <View style={s.providerIcon}><Icon name="server" size={18} color={theme.accent} /></View>
          <View style={{ flex: 1 }}>
            <Text style={s.providerName}>{facilityName || 'Grupo Flash'}</Text>
            <Text style={s.providerSub}>Plano de monitoramento</Text>
          </View>
          <View style={s.activeBadge}><Text style={s.activeText}>Ativo</Text></View>
        </View>

        {/* Configuração */}
        <Text style={s.section}>Configuração</Text>
        <View style={s.group}>
          <Prefs theme={theme} s={s} icon="moon" label="Tema escuro" value={isDark} onChange={(v) => setThemeMode(v ? 'dark' : 'light')} />
          {biometricAvailable ? (
            <>
              <View style={s.divider} />
              <Prefs theme={theme} s={s} icon="lock" label={`Entrar com ${biometricLabel}`} value={biometricEnabled} onChange={onBiometricChange} />
            </>
          ) : null}
        </View>

        {/* Minhas câmeras — cadastro de câmera privada do próprio cliente (LGPD). */}
        <Text style={s.section}>Minhas câmeras</Text>
        <View style={s.group}>
          <Item theme={theme} s={s} icon="plus" label="Adicionar câmera" onPress={() => setAddCameraOpen(true)} />
        </View>

        <TouchableOpacity style={s.logout} activeOpacity={0.85} onPress={onLogout}>
          <Icon name="logout" size={18} color={theme.danger} />
          <Text style={s.logoutText}>Sair da conta</Text>
        </TouchableOpacity>

        <View style={s.footer}>
          <View style={[s.statusDot, { backgroundColor: connected ? theme.success : theme.danger }]} />
          <Text style={s.footerText}>{connected ? 'servidor conectado' : 'sem conexão'} · v{version}</Text>
        </View>
      </ScrollView>

      <AddCameraSheet
        visible={addCameraOpen}
        apiUrl={apiUrl}
        token={token ?? null}
        onClose={() => setAddCameraOpen(false)}
        onCreated={onCamerasChanged}
      />
    </View>
  );
}

function Prefs({ theme, s, icon, label, value, onChange }: { theme: any; s: any; icon: IconName; label: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={s.pref}>
      <View style={s.prefIcon}><Icon name={icon} size={17} color={theme.textSub} /></View>
      <Text style={s.prefLabel}>{label}</Text>
      <Switch
        value={value}
        onValueChange={onChange}
        trackColor={{ true: theme.accent, false: theme.surfaceAlt }}
        thumbColor="#fff"
      />
    </View>
  );
}

function Item({ theme, s, icon, label, onPress }: { theme: any; s: any; icon: IconName; label: string; onPress?: () => void }) {
  return (
    <TouchableOpacity style={s.pref} activeOpacity={0.7} onPress={onPress}>
      <View style={s.prefIcon}><Icon name={icon} size={17} color={theme.textSub} /></View>
      <Text style={s.prefLabel}>{label}</Text>
      <Icon name="forward" size={16} color={theme.textMuted} />
    </TouchableOpacity>
  );
}

function makeStyles(t: any) {
  return StyleSheet.create({
    root: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 132 },
    title: { fontFamily: TITLE, fontSize: 26, fontWeight: '800', color: t.text, letterSpacing: -0.5, marginBottom: 16 },
    card: { flexDirection: 'row', alignItems: 'center', gap: 13, backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, padding: 15 },
    avatar: { width: 50, height: 50, borderRadius: 16, backgroundColor: t.accent, alignItems: 'center', justifyContent: 'center' },
    avatarText: { fontFamily: TITLE, fontSize: 17, fontWeight: '700', color: '#fff' },
    profileName: { fontFamily: TITLE, fontSize: 17, fontWeight: '700', color: t.text },
    profileEmail: { fontFamily: UI, fontSize: 13, color: t.textSub, marginTop: 2 },
    providerIcon: { width: 44, height: 44, borderRadius: 14, backgroundColor: t.accentBg, alignItems: 'center', justifyContent: 'center' },
    providerName: { fontFamily: UI, fontSize: 15, fontWeight: '700', color: t.text },
    providerSub: { fontFamily: UI, fontSize: 12.5, color: t.textSub, marginTop: 2 },
    activeBadge: { backgroundColor: 'rgba(51,196,129,0.16)', paddingHorizontal: 11, paddingVertical: 5, borderRadius: 999 },
    activeText: { fontFamily: UI, fontSize: 12, fontWeight: '700', color: t.success },

    section: { fontFamily: MONO, fontSize: 11, fontWeight: '600', letterSpacing: 1, color: t.textMuted, marginTop: 24, marginBottom: 10, marginLeft: 2 },
    group: { backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, overflow: 'hidden' },
    pref: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingHorizontal: 15, paddingVertical: 14 },
    prefIcon: { width: 34, height: 34, borderRadius: 10, backgroundColor: t.surfaceAlt, alignItems: 'center', justifyContent: 'center' },
    prefLabel: { flex: 1, fontFamily: UI, fontSize: 14.5, fontWeight: '500', color: t.text },
    divider: { height: 1, backgroundColor: t.border, marginLeft: 62 },

    logout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, marginTop: 24, height: 54, borderRadius: 16, borderWidth: 1, borderColor: t.dangerBg, backgroundColor: t.dangerBg },
    logoutText: { fontFamily: UI, fontSize: 15, fontWeight: '700', color: t.danger },
    footer: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 22 },
    statusDot: { width: 6, height: 6, borderRadius: 3 },
    footerText: { fontFamily: MONO, fontSize: 11, color: t.textMuted },
  });
}
