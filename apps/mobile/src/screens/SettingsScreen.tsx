/**
 * SettingsScreen — perfil real, conexão, aparência e logout.
 */
import { LinearGradient } from 'expo-linear-gradient';
import Constants from 'expo-constants';
import React, { useEffect, useState } from 'react';
import { Linking, Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { AddCameraSheet } from '../components/AddCameraSheet';
import { Icon, type IconName } from '../components/Icon';
import { avaliarAtualizacao, baseDoApk, urlDoBuildInfo, type AtualizacaoDisponivel } from '../utils/atualizacao';
import { useTheme } from '../theme/ThemeProvider';
import type { User } from '../types';

interface SettingsScreenProps {
  user: User | null;
  apiUrl: string;
  token?: string | null;
  connected: boolean;
  biometricAvailable: boolean;
  biometricEnabled: boolean;
  biometricLabel: string;
  onBiometricChange: (enabled: boolean) => void;
  onLogout: () => void;
  /** Recarrega a biblioteca de câmeras após cadastrar uma nova. */
  onCamerasChanged?: () => void;
}

const ROLE_LABEL: Record<string, string> = {
  SUPER_ADMIN: 'SUPER ADMIN',
  ADMIN: 'ADMIN',
  OPERATOR: 'OPERADOR',
  VIEWER: 'VIEWER',
};

function initialsOf(name?: string): string {
  if (!name) return 'DR';
  const parts = name.trim().split(/\s+/);
  return ((parts[0]?.[0] ?? '') + (parts[1]?.[0] ?? '')).toUpperCase() || 'DR';
}

export function SettingsScreen({
  user, apiUrl, token, connected, biometricAvailable, biometricEnabled, biometricLabel, onBiometricChange, onLogout, onCamerasChanged,
}: SettingsScreenProps) {
  const { theme, themeMode, setThemeMode } = useTheme();
  const [addCameraOpen, setAddCameraOpen] = useState(false);
  // Consulta silenciosa: falha (offline, manifesto ausente) não vira erro na
  // tela — aviso de atualização que aparece por engano é pior que nenhum.
  const [atualizacao, setAtualizacao] = useState<AtualizacaoDisponivel | null>(null);
  useEffect(() => {
    const slug = String(Constants.expoConfig?.extra?.client ?? 'default');
    const base = baseDoApk(apiUrl);
    if (!base) return;
    let cancelado = false;
    void (async () => {
      try {
        const resposta = await fetch(urlDoBuildInfo(base, slug));
        if (!resposta.ok) return;
        const info = await resposta.json();
        const atual = Number(Constants.expoConfig?.android?.versionCode ?? NaN);
        const novidade = avaliarAtualizacao(info, atual, base);
        if (!cancelado) setAtualizacao(novidade);
      } catch {
        // silencioso de propósito
      }
    })();
    return () => { cancelado = true; };
  }, [apiUrl]);

  return (
    <ScrollView style={{ flex: 1 }} contentContainerStyle={styles.content} showsVerticalScrollIndicator={false}>
      <Text style={[styles.title, { color: theme.bgText }]}>Ajustes</Text>

      {/* Perfil */}
      <View style={[styles.profile, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <LinearGradient colors={[theme.accent, theme.accentDark]} style={styles.avatar}>
          <Text style={[styles.avatarText, { color: theme.textOnAccent }]}>{initialsOf(user?.name)}</Text>
        </LinearGradient>
        <View style={{ flex: 1 }}>
          <Text style={[styles.name, { color: theme.text }]} numberOfLines={1}>{user?.name ?? 'Usuário'}</Text>
          <Text style={[styles.email, { color: theme.textSub }]} numberOfLines={1}>{user?.email ?? ''}</Text>
        </View>
        {user ? <Text style={[styles.roleChip, { color: theme.accent, backgroundColor: theme.accentBg }]}>{ROLE_LABEL[user.role] ?? user.role}</Text> : null}
      </View>

      <Text style={[styles.groupLabel, { color: theme.textMuted }]}>APARÊNCIA</Text>
      <View style={[styles.group, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={styles.themeRow}>
          {([
            { id: 'system' as const, label: 'Sistema', icon: 'settings' as const },
            { id: 'dark' as const, label: 'Escuro', icon: 'moon' as const },
            { id: 'light' as const, label: 'Claro', icon: 'sun' as const },
          ]).map((item) => {
            const selected = themeMode === item.id;
            return (
              <Pressable
                key={item.id}
                onPress={() => setThemeMode(item.id)}
                accessibilityRole="radio"
                accessibilityLabel={`Tema ${item.label.toLowerCase()}`}
                accessibilityState={{ checked: selected }}
                style={[
                  styles.themeOption,
                  { backgroundColor: selected ? theme.accentBg : theme.surfaceAlt, borderColor: selected ? theme.accent : theme.border },
                ]}
              >
                <Icon name={item.icon} size={17} color={selected ? theme.accent : theme.textSub} strokeWidth={2} />
                <Text style={[styles.themeOptionText, { color: selected ? theme.accent : theme.textSub }]}>{item.label}</Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      <Text style={[styles.groupLabel, { color: theme.textMuted }]}>SEGURANÇA</Text>
      <View style={[styles.group, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Row
          icon="lock"
          iconBg={theme.accentBg}
          iconColor={theme.accent}
          title="Acesso por biometria"
          subtitle={biometricAvailable ? biometricLabel : 'Cadastre a biometria nos ajustes do aparelho'}
          theme={theme}
          right={(
            <Switch
              value={biometricEnabled}
              onValueChange={onBiometricChange}
              accessibilityLabel="Ativar acesso por biometria"
              trackColor={{ false: theme.border, true: theme.accent }}
              thumbColor={theme.surface}
            />
          )}
        />
      </View>

      {/* Minhas câmeras — cadastro de câmera privada do próprio cliente (LGPD). */}
      <Text style={[styles.groupLabel, { color: theme.textMuted }]}>MINHAS CÂMERAS</Text>
      <Pressable
        onPress={() => setAddCameraOpen(true)}
        accessibilityRole="button"
        accessibilityLabel="Adicionar câmera"
        style={[styles.addCamera, { backgroundColor: theme.surface, borderColor: theme.border }]}
      >
        <View style={[styles.addCameraIcon, { backgroundColor: theme.accentBg }]}>
          <Icon name="plus" size={19} color={theme.accent} strokeWidth={2.6} />
        </View>
        <View style={{ flex: 1 }}>
          <Text style={[styles.rowTitle, { color: theme.text }]}>Adicionar câmera</Text>
          <Text style={[styles.rowSubtitle, { color: theme.textSub }]} numberOfLines={1}>Câmera privada — só você vê as imagens</Text>
        </View>
        <Icon name="camera" size={18} color={theme.textMuted} />
      </Pressable>

      {/* Conexão */}
      <Text style={[styles.groupLabel, { color: theme.textMuted }]}>CONEXÃO</Text>
      <View style={[styles.group, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <Row
          icon={connected ? 'check' : 'alert'}
          iconBg={connected ? 'rgba(34,197,94,0.14)' : theme.dangerBg}
          iconColor={connected ? theme.success : theme.danger}
          title="Conexão"
          subtitle={connected ? 'Conectado' : 'Servidor indisponível'}
          subtitleColor={connected ? theme.success : theme.danger}
          theme={theme}
        />
      </View>

      {/* Preferências: "Notificações push" removido até o recurso funcionar de
          verdade (evita mostrar um botão que não faz nada — e pergunta do
          revisor da Play Store). Voltará quando o push (FCM) estiver ativo. */}

      {/* Logout */}
      <Pressable
        onPress={onLogout}
        accessibilityRole="button"
        accessibilityLabel="Sair da conta"
        style={[styles.logout, { backgroundColor: theme.dangerBg, borderColor: 'rgba(239,68,68,0.28)' }]}
      >
        <Icon name="logout" size={18} color={theme.danger} strokeWidth={2} />
        <Text style={[styles.logoutText, { color: theme.danger }]}>Sair da conta</Text>
      </Pressable>
      <Text style={[styles.version, { color: theme.textMuted }]}>DRAC VMS · versão {Constants.expoConfig?.version ?? '—'}</Text>

      {/* AVISO DE VERSÃO NOVA. O APK é distribuído por link, não pela Play:
          não há atualização automática nem aviso, e a frota fica com versões
          misturadas sem ninguém saber. O `build-client.sh` já publica o
          manifesto ao lado do APK — aqui só se compara e se oferece o link. */}
      {atualizacao ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Baixar a versão ${atualizacao.versionName}`}
          onPress={() => { void Linking.openURL(atualizacao.url); }}
          style={[styles.atualizacao, { borderColor: theme.accent, backgroundColor: theme.surface }]}
        >
          <Icon name="download" size={16} color={theme.accent} strokeWidth={2} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.atualizacaoTitulo, { color: theme.text }]}>Nova versão disponível</Text>
            <Text style={[styles.atualizacaoSub, { color: theme.textSub }]}>
              Versão {atualizacao.versionName} — toque para baixar o APK.
            </Text>
          </View>
        </Pressable>
      ) : null}

      <AddCameraSheet
        visible={addCameraOpen}
        apiUrl={apiUrl}
        token={token ?? null}
        onClose={() => setAddCameraOpen(false)}
        onCreated={onCamerasChanged}
      />
    </ScrollView>
  );
}

function Row({
  icon, iconBg, iconColor, title, subtitle, subtitleColor, right, theme, divider,
}: {
  icon: IconName; iconBg: string; iconColor: string; title: string;
  subtitle?: string; subtitleColor?: string; right?: React.ReactNode; theme: ReturnType<typeof useTheme>['theme']; divider?: boolean;
}) {
  return (
    <View style={[styles.row, divider && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}>
      <View style={[styles.rowIcon, { backgroundColor: iconBg }]}>
        <Icon name={icon} size={18} color={iconColor} strokeWidth={1.9} />
      </View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.rowTitle, { color: theme.text }]}>{title}</Text>
        {subtitle ? <Text style={[styles.rowSubtitle, { color: subtitleColor ?? theme.textSub }]} numberOfLines={1}>{subtitle}</Text> : null}
      </View>
      {right}
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 24 },
  title: { fontSize: 27, fontWeight: '800', letterSpacing: -0.5, marginTop: 10, marginBottom: 16 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 20, borderWidth: StyleSheet.hairlineWidth, padding: 16, marginBottom: 18 },
  avatar: { width: 56, height: 56, borderRadius: 18, alignItems: 'center', justifyContent: 'center' },
  avatarText: { fontSize: 20, fontWeight: '800' },
  name: { fontSize: 16, fontWeight: '800' },
  email: { fontSize: 12.5, fontWeight: '600', marginTop: 1 },
  roleChip: { fontSize: 10, fontWeight: '800', paddingVertical: 5, paddingHorizontal: 10, borderRadius: 8, overflow: 'hidden', letterSpacing: 0.4 },
  groupLabel: { fontSize: 11, fontWeight: '800', letterSpacing: 0.6, marginLeft: 4, marginBottom: 8 },
  group: { borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden', marginBottom: 18 },
  themeRow: { flexDirection: 'row', gap: 9, padding: 10 },
  themeOption: { flex: 1, height: 42, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7 },
  themeOptionText: { fontSize: 12.5, fontWeight: '800' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 13, paddingVertical: 14, paddingHorizontal: 15 },
  rowIcon: { width: 34, height: 34, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  rowTitle: { fontSize: 13.5, fontWeight: '700' },
  rowSubtitle: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
  addCamera: { flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 13, paddingHorizontal: 15, marginBottom: 18 },
  addCameraIcon: { width: 38, height: 38, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  logout: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 9, borderRadius: 16, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 15, marginBottom: 14 },
  logoutText: { fontSize: 14, fontWeight: '800' },
  atualizacao: { flexDirection: 'row', alignItems: 'center', gap: 11, borderWidth: 1, borderRadius: 13, paddingHorizontal: 14, paddingVertical: 12, marginTop: 14 },
  atualizacaoTitulo: { fontSize: 14, fontWeight: '700' },
  atualizacaoSub: { fontSize: 12, marginTop: 1 },
  version: { textAlign: 'center', fontSize: 11.5, fontWeight: '600' },
});
