/**
 * Tab bar do redesign — flutuante, 4 abas (Início/Câmeras/Eventos/Ajustes), como o mockup.
 * Mapeia para as abas existentes do app (central/mosaico/alarmes/ajustes) para não mudar
 * a lógica de navegação. Reprodução continua acessível de dentro das telas.
 */
import { StyleSheet, Text, TouchableOpacity, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { Icon, type IconName } from './Icon';
import type { Tab } from '../types';

interface Props {
  active: Tab;
  onChange: (tab: Tab) => void;
  alarmCount?: number;
  reviewCount?: number;
}

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'central', label: 'Início', icon: 'home' },
  { id: 'mosaico', label: 'Câmeras', icon: 'camera' },
  { id: 'revisao', label: 'Revisão', icon: 'eye' },
  { id: 'alarmes', label: 'Eventos', icon: 'bell' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings' },
];

export function BottomTabsRedesign({ active, onChange, alarmCount = 0, reviewCount = 0 }: Props) {
  const { theme } = useTheme();
  // edge-to-edge: o app desenha atrás da barra de navegação do Android; o inset
  // empurra a barra flutuante para cima dos botões do sistema (gesto ou 3 botões).
  const insets = useSafeAreaInsets();
  return (
    <View style={[styles.wrap, { paddingBottom: 10 + insets.bottom }]} pointerEvents="box-none">
      <View style={[styles.bar, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        {TABS.map((tab) => {
          const on = active === tab.id;
          const color = on ? theme.accent : theme.textMuted;
          return (
            <TouchableOpacity key={tab.id} style={styles.item} activeOpacity={0.7} onPress={() => onChange(tab.id)}>
              <View>
                <Icon name={tab.icon} size={21} color={color} />
                {(tab.id === 'alarmes' && alarmCount > 0) || (tab.id === 'revisao' && reviewCount > 0) ? <View style={[styles.dot, { backgroundColor: theme.danger, borderColor: theme.surface }]} /> : null}
              </View>
              <Text style={[styles.label, { color, fontFamily: on ? 'InstrumentSans-SemiBold' : 'InstrumentSans-Medium' }]}>{tab.label}</Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: 14 },
  bar: { height: 62, borderRadius: 23, borderWidth: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', paddingHorizontal: 6,
    shadowColor: '#000', shadowOpacity: 0.35, shadowRadius: 24, shadowOffset: { width: 0, height: 12 }, elevation: 16 },
  item: { alignItems: 'center', justifyContent: 'center', gap: 4, flex: 1, paddingVertical: 6 },
  label: { fontSize: 10, fontWeight: '600' },
  dot: { position: 'absolute', top: -2, right: -3, width: 7, height: 7, borderRadius: 4, borderWidth: 1.5 },
});
