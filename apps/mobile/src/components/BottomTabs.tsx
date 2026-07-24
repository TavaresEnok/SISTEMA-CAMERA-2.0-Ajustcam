/**
 * BottomTabs — navegação inferior com blur/translucidez e badge de alarmes.
 * Espelha apps/mobile/src/components/BottomTabs.tsx, mas usa o tema dinâmico.
 */
import React from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import type { Tab } from '../types';
import { Icon, type IconName } from './Icon';

interface BottomTabsProps {
  active: Tab;
  onChange: (tab: Tab) => void;
  alarmCount?: number;
  reviewCount?: number;
}

const TABS: Array<{ id: Tab; label: string; icon: IconName }> = [
  { id: 'central', label: 'Central', icon: 'home' },
  { id: 'mosaico', label: 'Mosaico', icon: 'grid' },
  { id: 'reproducao', label: 'Reprodução', icon: 'play' },
  { id: 'revisao', label: 'Revisão', icon: 'eye' },
  { id: 'alarmes', label: 'Alarmes', icon: 'bell' },
  { id: 'ajustes', label: 'Ajustes', icon: 'settings' },
];

export function BottomTabs({ active, onChange, alarmCount = 0, reviewCount = 0 }: BottomTabsProps) {
  const { theme } = useTheme();

  // edge-to-edge: o app desenha atrás da barra de navegação do Android. O inset
  // inferior real (gesture nav ou 3 botões) garante que as abas fiquem acima dela.
  const insets = useSafeAreaInsets();

  return (
    <View
      style={[
        styles.bar,
        { backgroundColor: theme.menu, borderTopColor: theme.border, paddingBottom: 12 + insets.bottom },
      ]}
    >
      {TABS.map((tab) => {
        const on = active === tab.id;
        const color = on ? theme.accent : theme.menuText;
        const badgeCount = tab.id === 'alarmes' ? alarmCount : tab.id === 'revisao' ? reviewCount : 0;
        const showBadge = badgeCount > 0;
        const filled = tab.icon === 'play';
        return (
          <Pressable
            key={tab.id}
            style={styles.tab}
            onPress={() => onChange(tab.id)}
            accessibilityRole="tab"
            accessibilityLabel={tab.label}
            accessibilityState={{ selected: on }}
          >
            <View style={styles.iconWrap}>
              <Icon name={tab.icon} size={tab.icon === 'home' ? 23 : 22} color={color} fill={filled} />
              {showBadge ? (
                <View style={[styles.badge, { backgroundColor: theme.danger, borderColor: theme.menu }]}>
                  <Text style={styles.badgeText}>{badgeCount > 9 ? '9+' : badgeCount}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.label, { color }]}>{tab.label}</Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    alignItems: 'flex-start',
    paddingTop: 11,
    paddingBottom: 14, // sobrescrito dinamicamente com navBarHeight
    paddingHorizontal: 12,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  tab: { flex: 1, alignItems: 'center', gap: 5 },
  iconWrap: { height: 24, alignItems: 'center', justifyContent: 'center' },
  label: { fontSize: 9.5, fontWeight: '800', letterSpacing: 0.2 },
  badge: {
    position: 'absolute',
    top: -5,
    right: -9,
    minWidth: 16,
    height: 16,
    borderRadius: 8,
    paddingHorizontal: 4,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  badgeText: { color: '#fff', fontSize: 9, fontWeight: '800' },
});
