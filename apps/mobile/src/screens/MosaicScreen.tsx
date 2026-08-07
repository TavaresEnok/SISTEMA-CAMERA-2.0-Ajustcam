/** MosaicScreen — grade de câmeras organizada por GRUPOS (criáveis pelo usuário). */
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { CameraTile } from '../components/CameraTile';
import { GroupEditorSheet } from '../components/GroupEditorSheet';
import { Icon } from '../components/Icon';
import { CameraGridSkeleton } from '../components/Skeleton';
import { LiveVideo } from '../components/VideoPlayers';
import { useLibrary } from '../state/LibraryProvider';
import { useTheme } from '../theme/ThemeProvider';
import type { Camera, CameraGroup } from '../types';

interface MosaicScreenProps {
  cameras: Camera[];
  streamUrls: Record<string, string | null>;
  streamWhep: Record<string, string | null>;
  streamPosters: Record<string, string | null>;
  refreshing: boolean;
  canLiveView: boolean;
  onRefresh: () => void;
  onOpenCamera: (camera: Camera) => void;
  onRequestStreams: (cameraIds: string[]) => void;
  onRefreshStream: (cameraId: string) => void;
  onPosterError?: (cameraId: string) => void;
}

export function MosaicScreen({
  cameras, streamUrls, streamWhep, streamPosters, refreshing, canLiveView, onRefresh, onOpenCamera, onRequestStreams, onRefreshStream, onPosterError,
}: MosaicScreenProps) {
  const { theme } = useTheme();
  const { groups, isFavorite, toggleFavorite } = useLibrary();

  const [selected, setSelected] = useState<string>('all'); // 'all' | groupId
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingGroup, setEditingGroup] = useState<CameraGroup | null>(null);
  const [liveMode, setLiveMode] = useState(false);

  const activeGroup = groups.find((g) => g.id === selected) || null;
  const list = useMemo(
    () => (selected === 'all' ? cameras : cameras.filter((c) => activeGroup?.cameraIds.includes(c.id))),
    [selected, activeGroup, cameras],
  );
  const liveCameras = useMemo(() => list.filter((camera) => camera.status?.toUpperCase() === 'ONLINE').slice(0, 4), [list]);
  const liveCameraIds = useMemo(() => liveCameras.map((camera) => camera.id), [liveCameras]);
  const requestStreamsRef = useRef(onRequestStreams);

  useEffect(() => {
    requestStreamsRef.current = onRequestStreams;
  }, [onRequestStreams]);

  useEffect(() => {
    if (canLiveView && liveMode && liveCameraIds.length) requestStreamsRef.current(liveCameraIds);
  }, [canLiveView, liveMode, liveCameraIds]);
  useEffect(() => { if (!canLiveView) setLiveMode(false); }, [canLiveView]);

  const openNew = () => { setEditingGroup(null); setEditorOpen(true); };
  const openEdit = () => { if (activeGroup) { setEditingGroup(activeGroup); setEditorOpen(true); } };

  return (
    <ScrollView
      style={{ flex: 1 }}
      contentContainerStyle={styles.content}
      showsVerticalScrollIndicator={false}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.textSub} />}
    >
      <View style={styles.header}>
        <Text style={[styles.title, { color: theme.bgText }]}>Mosaico</Text>
        <View style={styles.headerActions}>
          {canLiveView ? (
            <Pressable
              style={[styles.liveToggle, { backgroundColor: liveMode ? theme.dangerBg : theme.surface, borderColor: liveMode ? theme.danger : theme.border }]}
              onPress={() => setLiveMode((value) => !value)}
              accessibilityRole="switch"
              accessibilityLabel="Reprodução ao vivo no mosaico"
              accessibilityState={{ checked: liveMode }}
            >
              <View style={[styles.liveToggleDot, { backgroundColor: liveMode ? theme.danger : theme.textMuted }]} />
              <Text style={[styles.liveToggleText, { color: liveMode ? theme.danger : theme.textSub }]}>{liveMode ? 'Ao vivo' : 'Prévia'}</Text>
            </Pressable>
          ) : null}
          <Pressable style={[styles.newBtn, { backgroundColor: theme.accent }]} onPress={openNew} accessibilityRole="button">
            <Icon name="plus" size={16} color="#fff" strokeWidth={2.4} />
            <Text style={[styles.newBtnText, { color: theme.textOnAccent }]}>Grupo</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
        {[{ id: 'all', name: 'Todas' }, ...groups].map((g) => {
          const on = g.id === selected;
          return (
            <Pressable
              key={g.id}
              onPress={() => setSelected(g.id)}
              accessibilityRole="tab"
              accessibilityState={{ selected: on }}
              style={[styles.chip, { backgroundColor: on ? theme.accent : theme.surface, borderColor: on ? theme.accent : theme.border }]}
            >
              <Text style={[styles.chipText, { color: on ? theme.textOnAccent : theme.textSub }]}>{g.name}</Text>
            </Pressable>
          );
        })}
        <Pressable style={[styles.chipNew, { borderColor: theme.border }]} onPress={openNew}>
          <Icon name="plus" size={13} color={theme.accent} strokeWidth={2.6} />
          <Text style={[styles.chipNewText, { color: theme.accent }]}>Novo</Text>
        </Pressable>
      </ScrollView>

      {activeGroup ? (
        <View style={styles.groupBar}>
          <Text style={[styles.groupCount, { color: theme.textSub }]}>
            {activeGroup.cameraIds.length} câmera{activeGroup.cameraIds.length === 1 ? '' : 's'} neste grupo
          </Text>
          <Pressable style={styles.editLink} onPress={openEdit}>
            <Icon name="edit" size={13} color={theme.accent} strokeWidth={2} />
            <Text style={[styles.editLinkText, { color: theme.accent }]}>Editar grupo</Text>
          </Pressable>
        </View>
      ) : null}

      {refreshing && cameras.length === 0 ? (
        <CameraGridSkeleton />
      ) : list.length === 0 ? (
        <Text style={[styles.emptyHint, { color: theme.textMuted }]}>
          {selected === 'all' ? 'Nenhuma câmera disponível.' : 'Este grupo está vazio. Toque em "Editar grupo" para adicionar câmeras.'}
        </Text>
      ) : (
        <View style={styles.grid}>
          {list.map((cam) => (
            <View key={cam.id} style={styles.gridItem}>
              {canLiveView && liveMode && liveCameras.some((camera) => camera.id === cam.id) ? (
                <MosaicLiveTile
                  camera={cam}
                  hlsUrl={streamUrls[cam.id] ?? null}
                  whepUrl={streamWhep[cam.id] ?? null}
                  posterUrl={streamPosters[cam.id] ?? null}
                  onPress={() => onOpenCamera(cam)}
                  onRefresh={() => onRefreshStream(cam.id)}
                />
              ) : (
                <CameraTile
                  camera={cam}
                  posterUrl={streamPosters[cam.id]}
                  height={138}
                  onPress={() => onOpenCamera(cam)}
                  onPosterError={onPosterError}
                  favorite={isFavorite(cam.id)}
                  onToggleFavorite={() => toggleFavorite(cam.id)}
                />
              )}
            </View>
          ))}
        </View>
      )}

      {liveMode && list.length > 4 ? (
        <Text style={[styles.liveLimit, { color: theme.textMuted }]}>Até 4 câmeras online são reproduzidas ao mesmo tempo para preservar bateria e dados.</Text>
      ) : null}

      <GroupEditorSheet visible={editorOpen} cameras={cameras} group={editingGroup} onClose={() => setEditorOpen(false)} />
    </ScrollView>
  );
}

function MosaicLiveTile({ camera, hlsUrl, whepUrl, posterUrl, onPress, onRefresh }: {
  camera: Camera;
  hlsUrl: string | null;
  whepUrl: string | null;
  posterUrl: string | null;
  onPress: () => void;
  onRefresh: () => void;
}) {
  return (
    <Pressable style={styles.liveTile} onPress={onPress} accessibilityRole="button" accessibilityLabel={`${camera.name}, ao vivo`}>
      <LiveVideo
        uri={hlsUrl}
        whepUri={whepUrl}
        posterUri={posterUrl}
        videoStyle={StyleSheet.absoluteFill}
        muted
        contentFit="cover"
        emptyStyle={styles.liveEmpty}
        posterStyle={StyleSheet.absoluteFill}
        emptyTitleStyle={styles.liveEmptyTitle}
        emptyTextStyle={styles.liveEmptyText}
        onNeedRefresh={onRefresh}
      />
      <View style={styles.liveBadge}><View style={styles.liveBadgeDot} /><Text style={styles.liveBadgeText}>AO VIVO</Text></View>
      <Text style={styles.liveName} numberOfLines={1}>{camera.name}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 24 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 10, marginBottom: 16 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  title: { fontSize: 27, fontWeight: '800', letterSpacing: -0.5 },
  newBtn: { flexDirection: 'row', alignItems: 'center', gap: 6, height: 40, paddingHorizontal: 14, borderRadius: 13 },
  // cor aplicada em linha a partir do tema (ver uso) — `#fff` fixo ficava
  // ilegível em instalação com marca de cor clara.
  newBtnText: { fontSize: 12.5, fontWeight: '800' },
  liveToggle: { height: 40, flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 11, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth },
  liveToggleDot: { width: 7, height: 7, borderRadius: 4 },
  liveToggleText: { fontSize: 11.5, fontWeight: '800' },
  chips: { gap: 8, paddingBottom: 14, alignItems: 'center' },
  chip: { paddingVertical: 9, paddingHorizontal: 16, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  chipText: { fontSize: 12.5, fontWeight: '700' },
  chipNew: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingVertical: 9, paddingHorizontal: 15, borderRadius: 11, borderWidth: 1, borderStyle: 'dashed' },
  chipNewText: { fontSize: 12.5, fontWeight: '700' },
  groupBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 13, paddingHorizontal: 2 },
  groupCount: { fontSize: 12, fontWeight: '600' },
  editLink: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  editLinkText: { fontSize: 12, fontWeight: '700' },
  emptyHint: { fontSize: 12.5, fontWeight: '600', textAlign: 'center', paddingVertical: 40, paddingHorizontal: 20, lineHeight: 18 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', marginHorizontal: -5.5 },
  gridItem: { width: '50%', paddingHorizontal: 5.5, marginBottom: 11 },
  liveTile: { height: 138, borderRadius: 18, overflow: 'hidden', backgroundColor: '#070809' },
  liveEmpty: { backgroundColor: '#070809' },
  liveEmptyTitle: { color: '#fff', fontSize: 11, fontWeight: '700' },
  liveEmptyText: { color: 'rgba(255,255,255,0.65)', fontSize: 9.5, textAlign: 'center', paddingHorizontal: 10 },
  liveBadge: { position: 'absolute', top: 9, left: 9, flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(239,68,68,0.9)', borderRadius: 7, paddingVertical: 3, paddingHorizontal: 6 },
  liveBadgeDot: { width: 5, height: 5, borderRadius: 3, backgroundColor: '#fff' },
  liveBadgeText: { color: '#fff', fontSize: 8, fontWeight: '800' },
  liveName: { position: 'absolute', left: 10, right: 10, bottom: 9, color: '#fff', fontSize: 12, fontWeight: '800', textShadowColor: '#000', textShadowRadius: 4 },
  liveLimit: { fontSize: 11, lineHeight: 16, textAlign: 'center', marginTop: 2, marginBottom: 12, paddingHorizontal: 12 },
});
