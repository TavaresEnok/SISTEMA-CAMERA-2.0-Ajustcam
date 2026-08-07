/**
 * GroupEditorSheet — modal de criar/editar grupo de câmeras (organização pessoal).
 * Nome + seleção de câmeras (checkbox) + excluir (no modo edição).
 * Salva via useLibrary().createGroup/updateGroup/deleteGroup (AsyncStorage).
 */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useEffect, useState } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import { useLibrary } from '../state/LibraryProvider';
import { useTheme } from '../theme/ThemeProvider';
import type { Camera, CameraGroup } from '../types';
import { areaLabel, tintFor } from '../utils/camera-view';
import { Icon } from './Icon';

interface GroupEditorSheetProps {
  visible: boolean;
  cameras: Camera[];
  /** grupo a editar; ausente = criar novo */
  group?: CameraGroup | null;
  onClose: () => void;
}

export function GroupEditorSheet({ visible, cameras, group, onClose }: GroupEditorSheetProps) {
  const { theme } = useTheme();
  const { createGroup, updateGroup, deleteGroup } = useLibrary();
  const editing = !!group;

  const [name, setName] = useState('');
  const [selected, setSelected] = useState<string[]>([]);

  useEffect(() => {
    if (visible) {
      setName(group?.name ?? '');
      setSelected(group ? [...group.cameraIds] : []);
    }
  }, [visible, group]);

  const toggle = (id: string) =>
    setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const save = () => {
    if (editing && group) updateGroup(group.id, { name, cameraIds: selected });
    else createGroup(name, selected);
    onClose();
  };

  const remove = () => {
    if (editing && group) deleteGroup(group.id);
    onClose();
  };

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={styles.root}>
        <Pressable style={styles.backdrop} onPress={onClose} />
        <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
          <View style={[styles.grabber, { backgroundColor: theme.border }]} />

          <View style={styles.headerRow}>
            <Text style={[styles.title, { color: theme.text }]}>{editing ? 'Editar grupo' : 'Novo grupo'}</Text>
            <Pressable style={[styles.closeBtn, { backgroundColor: theme.surface, borderColor: theme.border }]} onPress={onClose}>
              <Icon name="close" size={16} color={theme.textSub} strokeWidth={2.2} />
            </Pressable>
          </View>

          <Text style={[styles.label, { color: theme.textMuted }]}>NOME DO GRUPO</Text>
          <View style={[styles.input, { backgroundColor: theme.surface, borderColor: theme.border }]}>
            <TextInput
              value={name}
              onChangeText={setName}
              placeholder="Ex.: 1º andar"
              placeholderTextColor={theme.textMuted}
              style={[styles.inputText, { color: theme.text }]}
            />
          </View>

          <View style={styles.camHeader}>
            <Text style={[styles.label, { color: theme.textMuted, marginBottom: 0 }]}>CÂMERAS</Text>
            <Text style={[styles.count, { color: theme.accent }]}>{selected.length} selecionada{selected.length === 1 ? '' : 's'}</Text>
          </View>

          <ScrollView style={{ maxHeight: 320 }} contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
            {cameras.map((cam) => {
              const checked = selected.includes(cam.id);
              return (
                <Pressable
                  key={cam.id}
                  onPress={() => toggle(cam.id)}
                  style={[
                    styles.camRow,
                    { backgroundColor: checked ? theme.accentBg : theme.surface, borderColor: checked ? theme.accent : theme.border },
                  ]}
                >
                  <LinearGradient colors={tintFor(cam)} style={styles.camThumb} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.camName, { color: theme.text }]} numberOfLines={1}>{cam.name}</Text>
                    <Text style={[styles.camArea, { color: theme.textSub }]} numberOfLines={1}>{areaLabel(cam)}</Text>
                  </View>
                  <View style={[styles.checkbox, { backgroundColor: checked ? theme.accent : 'transparent', borderColor: checked ? theme.accent : theme.border }]}>
                    {checked ? <Icon name="check" size={15} color="#fff" strokeWidth={3} /> : null}
                  </View>
                </Pressable>
              );
            })}
          </ScrollView>

          <View style={styles.footer}>
            {editing ? (
              <Pressable style={[styles.deleteBtn, { backgroundColor: theme.dangerBg, borderColor: 'rgba(239,68,68,0.28)' }]} onPress={remove}>
                <Icon name="trash" size={19} color={theme.danger} strokeWidth={2} />
              </Pressable>
            ) : null}
            <Pressable style={{ flex: 1 }} onPress={save}>
              <LinearGradient colors={[theme.accent, theme.accentDark]} style={styles.saveBtn}>
                <Text style={[styles.saveText, { color: theme.textOnAccent }]}>{editing ? 'Salvar alterações' : 'Criar grupo'}</Text>
              </LinearGradient>
            </Pressable>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 22, paddingTop: 8, paddingBottom: 34 },
  grabber: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 6, marginBottom: 12 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 },
  title: { fontSize: 18, fontWeight: '800' },
  closeBtn: { width: 32, height: 32, borderRadius: 10, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 10.5, fontWeight: '800', letterSpacing: 0.5, marginBottom: 7 },
  input: { borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 15, paddingVertical: 12, marginBottom: 16 },
  inputText: { fontSize: 15, fontWeight: '700', padding: 0 },
  camHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 9 },
  count: { fontSize: 11.5, fontWeight: '700' },
  camRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  camThumb: { width: 42, height: 42, borderRadius: 11 },
  camName: { fontSize: 13.5, fontWeight: '700' },
  camArea: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
  checkbox: { width: 26, height: 26, borderRadius: 8, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  footer: { flexDirection: 'row', gap: 10, marginTop: 16 },
  deleteBtn: { width: 50, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  saveBtn: { borderRadius: 14, paddingVertical: 15, alignItems: 'center' },
  // cor vem do tema no uso (`textOnAccent`): branco fixo sobre a cor da marca
  // fica ilegível quando o cliente usa uma primária clara.
  saveText: { fontSize: 15, fontWeight: '800' },
});
