/** LoginScreen — autenticação real (POST /auth/login via App). Visual do redesign. */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { BRANDING, BRAND_LOGO } from '../branding';
import { Icon } from '../components/Icon';
import { useTheme } from '../theme/ThemeProvider';
import Constants from 'expo-constants';
import { withAlpha } from '../services/branding';

interface LoginScreenProps {
  apiUrl: string;
  email: string;
  password: string;
  loading: boolean;
  onApiUrlChange: (value: string) => void;
  onEmailChange: (value: string) => void;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
  onForgotPassword: () => void;
  biometricAvailable?: boolean;
  biometricLabel?: string;
  onBiometric?: () => void;
}

export function LoginScreen({
  apiUrl, email, password, loading,
  onApiUrlChange, onEmailChange, onPasswordChange, onSubmit, onForgotPassword,
  biometricAvailable = false, biometricLabel = 'Biometria', onBiometric,
}: LoginScreenProps) {
  const { theme, branding } = useTheme();
  const [show, setShow] = useState(false);
  // App white-label = servidor embutido no APK (BRANDING.apiUrl). Nesse caso o
  // usuário final NÃO vê nada de servidor/URL (é info interna). Só o app
  // genérico (sem servidor embutido) mostra o campo p/ digitar o endereço.
  const hasBakedServer = !!(BRANDING.apiUrl && BRANDING.apiUrl.trim());
  const [showServer, setShowServer] = useState(!apiUrl);
  // Servidor sem TLS num build que bloqueia tráfego em claro: o Android recusa
  // no nível do SISTEMA e o usuário só veria "erro de rede", sem pista da causa.
  const avisoDeCleartext = /^http:\/\//i.test((apiUrl ?? '').trim())
    && (Constants.expoConfig?.android as { usesCleartextTraffic?: boolean } | undefined)?.usesCleartextTraffic !== true;

  // A logo configurada em Aparência pertence exclusivamente ao aplicativo.
  const logoSource = branding.logoDataUrl ? { uri: branding.logoDataUrl } : BRAND_LOGO;
  const appName = branding.facilityName || BRANDING.appName;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: theme.bg }}
      contentContainerStyle={styles.root}
      keyboardShouldPersistTaps="handled"
      showsVerticalScrollIndicator={false}
    >
      <LinearGradient
        colors={[theme.accentBg, 'transparent']}
        start={{ x: 0.8, y: 0 }}
        end={{ x: 0.3, y: 0.6 }}
        style={styles.glow}
        pointerEvents="none"
      />

      <View style={styles.hero}>
        <Image source={logoSource} style={styles.logo} resizeMode="contain" />
        <Text style={[styles.brand, { color: theme.bgText }]}>{appName}</Text>
        <Text style={[styles.tagline, { color: withAlpha(theme.bgText, 0.72) ?? theme.bgText }]}>Monitoramento inteligente</Text>
      </View>

      <View style={styles.form}>
        <View style={[styles.field, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="mail" size={19} color={theme.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>E-MAIL</Text>
            <TextInput
              value={email}
              onChangeText={onEmailChange}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="email-address"
              placeholder="voce@empresa.com"
              placeholderTextColor={theme.textMuted}
              accessibilityLabel="E-mail"
              textContentType="emailAddress"
              autoComplete="email"
              style={[styles.input, { color: theme.text }]}
            />
          </View>
        </View>

        <View style={[styles.field, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="lock" size={19} color={theme.textMuted} />
          <View style={{ flex: 1 }}>
            <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>SENHA</Text>
            <TextInput
              value={password}
              onChangeText={onPasswordChange}
              secureTextEntry={!show}
              placeholder="••••••••"
              placeholderTextColor={theme.textMuted}
              onSubmitEditing={onSubmit}
              accessibilityLabel="Senha"
              textContentType="password"
              autoComplete="current-password"
              style={[styles.input, { color: theme.text }]}
            />
          </View>
          <Pressable
            onPress={() => setShow((s) => !s)}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel={show ? 'Ocultar senha' : 'Mostrar senha'}
          >
            <Icon name="eye" size={19} color={theme.textMuted} />
          </Pressable>
        </View>

        {!hasBakedServer && showServer ? (
          <View style={[styles.field, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <Icon name="server" size={19} color={theme.textMuted} />
            <View style={{ flex: 1 }}>
              <Text style={[styles.fieldLabel, { color: theme.textMuted }]}>SERVIDOR (URL DA API)</Text>
              <TextInput
                value={apiUrl}
                onChangeText={onApiUrlChange}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                placeholder="https://drac.local/api"
                placeholderTextColor={theme.textMuted}
                style={[styles.input, { color: theme.text }]}
              />
            </View>
          </View>
        ) : null}

        <View style={styles.linksRow}>
          {!hasBakedServer ? (
            <Pressable onPress={() => setShowServer((s) => !s)} hitSlop={8}>
              <Text style={[styles.smallLink, { color: theme.textSub }]}>{showServer ? 'Ocultar servidor' : 'Servidor'}</Text>
            </Pressable>
          ) : <View />}
          <Pressable onPress={onForgotPassword} hitSlop={8}>
            <Text style={[styles.forgot, { color: theme.accent }]}>Esqueci minha senha</Text>
          </Pressable>
        </View>

        {/* Servidor sem TLS num build que bloqueia tráfego em claro: o Android
            recusa a conexão no nível do sistema e o usuário só veria um erro
            genérico de rede, sem pista da causa. Avisar ANTES de tentar. */}
        {avisoDeCleartext ? (
          <View style={[styles.aviso, { borderColor: theme.warning, backgroundColor: theme.surface }]}>
            <Icon name="alert" size={15} color={theme.warning} />
            <Text style={[styles.avisoTexto, { color: theme.textSub }]}>
              Este endereço usa <Text style={{ fontWeight: '700' }}>http://</Text> e esta versão do app
              só aceita conexões seguras (https). Use o endereço https do servidor.
            </Text>
          </View>
        ) : null}

        <Pressable
          onPress={onSubmit}
          disabled={loading}
          accessibilityRole="button"
          accessibilityLabel="Entrar"
          accessibilityState={{ disabled: loading, busy: loading }}
        >
          <LinearGradient colors={[theme.accent, theme.accentDark]} style={[styles.cta, loading && { opacity: 0.7 }]}>
            {loading ? <ActivityIndicator color="#fff" /> : <Text style={styles.ctaText}>Entrar</Text>}
          </LinearGradient>
        </Pressable>

        {biometricAvailable && onBiometric ? (
          <Pressable
            onPress={onBiometric}
            disabled={loading}
            accessibilityRole="button"
            accessibilityLabel={`Entrar com ${biometricLabel.toLowerCase()}`}
            style={[styles.biometricCta, { backgroundColor: theme.surface, borderColor: theme.accent }]}
          >
            <Icon name="lock" size={19} color={theme.accent} />
            <Text style={[styles.biometricText, { color: theme.accent }]}>Entrar com {biometricLabel.toLowerCase()}</Text>
          </Pressable>
        ) : null}

        {!hasBakedServer ? (
          <View style={styles.serverRow}>
            <View style={[styles.dot, { backgroundColor: apiUrl ? theme.success : theme.warning }]} />
            <Text style={[styles.serverText, { color: theme.textSub }]} numberOfLines={1}>
              {apiUrl ? `Servidor · ${apiUrl.replace(/^https?:\/\//, '')}` : 'Defina o servidor para continuar'}
            </Text>
          </View>
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  root: { flexGrow: 1, paddingHorizontal: 30, justifyContent: 'center', paddingVertical: 40 },
  glow: { position: 'absolute', top: 0, left: 0, right: 0, height: 360 },
  hero: { alignItems: 'center', justifyContent: 'center', gap: 16, marginBottom: 40 },
  logo: { width: 84, height: 84, borderRadius: 23 },
  brand: { fontSize: 28, fontWeight: '800', letterSpacing: -0.5, marginTop: 2 },
  tagline: { fontSize: 14, fontWeight: '500', marginTop: -8 },
  form: { gap: 13 },
  field: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 16, paddingVertical: 11 },
  fieldLabel: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  input: { fontSize: 15, fontWeight: '600', padding: 0, marginTop: 1 },
  linksRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  smallLink: { fontSize: 12.5, fontWeight: '700' },
  aviso: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, borderWidth: 1, borderRadius: 11, paddingHorizontal: 12, paddingVertical: 10, marginBottom: 12 },
  avisoTexto: { flex: 1, fontSize: 12, lineHeight: 17 },
  forgot: { textAlign: 'right', fontSize: 12.5, fontWeight: '700' },
  cta: { borderRadius: 15, paddingVertical: 16, alignItems: 'center', marginTop: 4 },
  ctaText: { color: '#fff', fontSize: 16, fontWeight: '800' },
  biometricCta: { borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 14, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 9 },
  biometricText: { fontSize: 14, fontWeight: '800' },
  serverRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 7, marginTop: 4 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  serverText: { fontSize: 11.5, fontWeight: '600', maxWidth: '90%' },
});
