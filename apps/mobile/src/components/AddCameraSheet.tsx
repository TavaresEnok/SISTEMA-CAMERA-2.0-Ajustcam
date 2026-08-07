/**
 * AddCameraSheet — "+ Adicionar câmera" do cliente (câmera PRIVADA/LGPD).
 *
 * A câmera cadastrada aqui pertence exclusivamente ao usuário: nem o provedor,
 * nem o dono do sistema, nem operadores/admins veem o conteúdo — só quem
 * cadastrou. O cadastro é enviado a `POST /cameras/mine`, que marca isPrivate,
 * vincula ao grupo do responsável e aplica a cota do grupo (maxPrivateCameras).
 * A cota é lida de `GET /cameras/mine/quota` para orientar o usuário antes de
 * tentar (mas o backend é a autoridade final e barra o excedente com 400).
 */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { ActivityIndicator, KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { request } from '../services/api';
import { useTheme } from '../theme/ThemeProvider';
import { Icon } from './Icon';

interface AddCameraSheetProps {
  visible: boolean;
  apiUrl: string;
  token: string | null;
  onClose: () => void;
  /** Chamado após cadastro bem-sucedido (para o App recarregar a biblioteca). */
  onCreated?: () => void;
}

type Quota = { used: number; limit: number; canAdd: boolean };

const RTSP_PORT_DEFAULT = '554';

export function AddCameraSheet({ visible, apiUrl, token, onClose, onCreated }: AddCameraSheetProps) {
  const { theme } = useTheme();

  const [name, setName] = useState('');
  const [ip, setIp] = useState('');
  const [rtspPort, setRtspPort] = useState(RTSP_PORT_DEFAULT);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [rtspPath, setRtspPath] = useState('');
  const [showPass, setShowPass] = useState(false);

  const [quota, setQuota] = useState<Quota | null>(null);
  const [quotaLoading, setQuotaLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Reset + carrega a cota sempre que a folha abre.
  useEffect(() => {
    if (!visible) return;
    setName(''); setIp(''); setRtspPort(RTSP_PORT_DEFAULT);
    setUsername(''); setPassword(''); setRtspPath('');
    setShowPass(false); setError(null); setSuccess(false);
    setQuota(null); setQuotaLoading(true);
    let cancelled = false;
    void request<Quota>(apiUrl, '/cameras/mine/quota', token ?? undefined)
      .then((q) => { if (!cancelled) setQuota(q); })
      .catch(() => { if (!cancelled) setQuota(null); })
      .finally(() => { if (!cancelled) setQuotaLoading(false); });
    return () => { cancelled = true; };
  }, [visible, apiUrl, token]);

  const quotaFull = !!quota && !quota.canAdd;
  const canSubmit =
    !submitting && !quotaFull &&
    name.trim().length > 0 && ip.trim().length > 0 &&
    username.trim().length > 0 && password.length > 0 &&
    Number(rtspPort) > 0;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      await request(apiUrl, '/cameras/mine', token ?? undefined, {
        method: 'POST',
        body: JSON.stringify({
          name: name.trim(),
          ip: ip.trim(),
          rtspPort: Number(rtspPort) || 554,
          username: username.trim(),
          password,
          ...(rtspPath.trim() ? { rtspPath: rtspPath.trim() } : {}),
        }),
      });
      setSuccess(true);
      onCreated?.();
      // Fecha após um instante mostrando o sucesso.
      setTimeout(() => onClose(), 900);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível cadastrar a câmera.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.root}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
      >
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
          <View style={[styles.grabber, { backgroundColor: theme.border }]} />

          <View style={styles.headerRow}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.title, { color: theme.text }]}>Adicionar câmera</Text>
              <Text style={[styles.subtitle, { color: theme.textSub }]} numberOfLines={2}>
                Sua câmera privada — só você vê as imagens e gravações.
              </Text>
            </View>
            <Pressable style={[styles.closeBtn, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={onClose}>
              <Icon name="close" size={16} color={theme.textSub} strokeWidth={2.2} />
            </Pressable>
          </View>

          {/* Cota do grupo */}
          {quotaLoading ? (
            <View style={[styles.quota, { backgroundColor: theme.surface, borderColor: theme.border }]}>
              <ActivityIndicator size="small" color={theme.textSub} />
              <Text style={[styles.quotaText, { color: theme.textSub }]}>Verificando limite…</Text>
            </View>
          ) : quota ? (
            <View style={[styles.quota, { backgroundColor: quotaFull ? theme.dangerBg : theme.surface, borderColor: quotaFull ? 'rgba(239,68,68,0.28)' : theme.border }]}>
              <Icon name={quotaFull ? 'alert' : 'camera'} size={16} color={quotaFull ? theme.danger : theme.accent} strokeWidth={2} />
              <Text style={[styles.quotaText, { color: quotaFull ? theme.danger : theme.textSub }]}>
                {quota.limit === 0
                  ? 'Cadastro de câmeras não habilitado para sua conta.'
                  : quotaFull
                    ? `Limite atingido — ${quota.used} de ${quota.limit} câmera(s).`
                    : `${quota.used} de ${quota.limit} câmera(s) usada(s).`}
              </Text>
            </View>
          ) : null}

          <ScrollView style={{ maxHeight: 380 }} contentContainerStyle={{ gap: 12 }} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
            <Field label="NOME" theme={theme}>
              <TextInput value={name} onChangeText={setName} placeholder="Ex.: Portão de casa" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} />
            </Field>
            <Field label="ENDEREÇO (IP OU HOST)" theme={theme}>
              <TextInput value={ip} onChangeText={setIp} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="192.168.0.100" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} />
            </Field>
            <View style={{ flexDirection: 'row', gap: 12 }}>
              <View style={{ width: 120 }}>
                <Field label="PORTA RTSP" theme={theme}>
                  <TextInput value={rtspPort} onChangeText={(t) => setRtspPort(t.replace(/[^0-9]/g, ''))} keyboardType="number-pad" placeholder="554" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} />
                </Field>
              </View>
              <View style={{ flex: 1 }}>
                <Field label="CAMINHO RTSP (OPCIONAL)" theme={theme}>
                  <TextInput value={rtspPath} onChangeText={setRtspPath} autoCapitalize="none" autoCorrect={false} placeholder="/onvif1 · deixe vazio se não souber" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} />
                </Field>
              </View>
            </View>
            <Field label="USUÁRIO" theme={theme}>
              <TextInput value={username} onChangeText={setUsername} autoCapitalize="none" autoCorrect={false} placeholder="admin" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text }]} />
            </Field>
            <Field label="SENHA" theme={theme}>
              <View style={{ flexDirection: 'row', alignItems: 'center', flex: 1 }}>
                <TextInput value={password} onChangeText={setPassword} secureTextEntry={!showPass} placeholder="••••••••" placeholderTextColor={theme.textMuted} style={[styles.inputText, { color: theme.text, flex: 1 }]} />
                <Pressable onPress={() => setShowPass((s) => !s)} hitSlop={10}>
                  <Icon name="eye" size={18} color={theme.textMuted} />
                </Pressable>
              </View>
            </Field>
          </ScrollView>

          {error ? (
            <View style={[styles.banner, { backgroundColor: theme.dangerBg }]}>
              <Icon name="alert" size={15} color={theme.danger} strokeWidth={2} />
              <Text style={[styles.bannerText, { color: theme.danger }]} numberOfLines={3}>{error}</Text>
            </View>
          ) : null}
          {success ? (
            <View style={[styles.banner, { backgroundColor: theme.accentBg }]}>
              <Icon name="check" size={15} color={theme.accent} strokeWidth={2.5} />
              <Text style={[styles.bannerText, { color: theme.accent }]}>Câmera cadastrada com sucesso!</Text>
            </View>
          ) : null}

          <Pressable onPress={submit} disabled={!canSubmit} style={{ marginTop: 14, opacity: canSubmit ? 1 : 0.5 }}>
            <LinearGradient colors={[theme.accent, theme.accentDark]} style={styles.saveBtn}>
              {submitting ? <ActivityIndicator color="#fff" /> : (
                <>
                  <Icon name="plus" size={18} color="#fff" strokeWidth={2.6} />
                  <Text style={[styles.saveText, { color: theme.textOnAccent }]}>Cadastrar câmera</Text>
                </>
              )}
            </LinearGradient>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function Field({ label, theme, children }: { label: string; theme: any; children: React.ReactNode }) {
  return (
    <View>
      <Text style={[styles.label, { color: theme.textMuted }]}>{label}</Text>
      <View style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border }]}>{children}</View>
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 22, paddingTop: 8, paddingBottom: 34 },
  grabber: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 6, marginBottom: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginBottom: 14 },
  title: { fontSize: 18, fontWeight: '800' },
  subtitle: { fontSize: 12.5, fontWeight: '600', marginTop: 3, lineHeight: 17 },
  closeBtn: { width: 32, height: 32, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  quota: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 13, paddingVertical: 10, marginBottom: 14 },
  quotaText: { fontSize: 12.5, fontWeight: '700', flex: 1 },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5, marginBottom: 6 },
  input: { borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 15, paddingVertical: 12 },
  inputText: { fontSize: 15, fontWeight: '700', padding: 0 },
  banner: { flexDirection: 'row', alignItems: 'center', gap: 9, borderRadius: 12, paddingHorizontal: 13, paddingVertical: 11, marginTop: 14 },
  bannerText: { fontSize: 12.5, fontWeight: '700', flex: 1 },
  saveBtn: { borderRadius: 14, paddingVertical: 15, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 8 },
  // cor vem do tema no uso (`textOnAccent`): branco fixo sobre a cor da marca
  // fica ilegível quando o cliente usa uma primária clara.
  saveText: { fontSize: 15, fontWeight: '800' },
});
