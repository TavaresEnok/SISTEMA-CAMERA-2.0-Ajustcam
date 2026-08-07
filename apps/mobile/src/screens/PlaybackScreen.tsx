/** Reprodução paginada: player, filtros e lista virtualizada de gravações. */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { SkeletonBlock } from '../components/Skeleton';
import { PlaybackVideo } from '../components/VideoPlayers';
import { useTheme } from '../theme/ThemeProvider';
import type { ActivePlayback, Camera, Recording } from '../types';
import { areaLabel, isOnlineStatus, tintFor } from '../utils/camera-view';
import { formatBytes, formatDateLabel, formatDuration, formatTime, localDateKey } from '../utils/format';
import { matchesPlaybackFilter, recordingKind, timelineRange, type PlaybackFilter } from '../utils/playback';

const FILTERS: Array<{ key: PlaybackFilter; label: string }> = [
  { key: 'all', label: 'Todas' },
  { key: 'motion', label: 'Movimento' },
  { key: 'continuous', label: 'Contínuas' },
  { key: 'unavailable', label: 'Indisponíveis' },
];

interface PlaybackScreenProps {
  cameras: Camera[];
  selectedCamera: Camera | null;
  recordings: Recording[];
  recordingsTotal: number;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  activePlayback: ActivePlayback | null;
  recordingDate: string;
  canPlayback: boolean;
  canDownload: boolean;
  downloadingIds: string[];
  onSelectCamera: (cameraId: string) => void;
  onOpenPlayback: (recording: Recording) => void;
  onClosePlayback: () => void;
  onRetryPlayback: () => void;
  /** Degrau de codec: pede a versão compatível quando o original não decodifica. */
  onNaoDecodificou: () => boolean;
  /** Posição corrente, para retomar o ponto ao trocar a URL. */
  onProgressoPlayback: (segundos: number) => void;
  onDownloadRecording: (recording: Recording) => void;
  onPreviousDate: () => void;
  onNextDate: () => void;
  onLoadMore: () => void;
  onRetry: () => void;
  onThumbnailError?: (recording: Recording) => void;
}

export function PlaybackScreen({
  cameras, selectedCamera, recordings, recordingsTotal, loading, loadingMore, error,
  activePlayback, recordingDate, canPlayback, canDownload, downloadingIds,
  onSelectCamera, onOpenPlayback, onClosePlayback, onRetryPlayback, onNaoDecodificou, onProgressoPlayback, onDownloadRecording,
  onPreviousDate, onNextDate, onLoadMore, onRetry, onThumbnailError,
}: PlaybackScreenProps) {
  const { theme } = useTheme();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [filter, setFilter] = useState<PlaybackFilter>('all');
  const isToday = recordingDate >= localDateKey();
  const playerPoster = activePlayback?.recording.thumbnailUrl ?? recordings[0]?.thumbnailUrl ?? null;
  const filteredRecordings = useMemo(() => recordings.filter((recording) => matchesPlaybackFilter(recording, filter)), [recordings, filter]);
  const filterCounts = useMemo(() => Object.fromEntries(FILTERS.map(({ key }) => [key, recordings.filter((recording) => matchesPlaybackFilter(recording, key)).length])), [recordings]);

  const header = (
    <View style={styles.headerContent}>
      <Text style={[styles.title, { color: theme.bgText }]}>Reprodução</Text>

      <Pressable
        style={[styles.selector, { backgroundColor: theme.surface, borderColor: theme.border }]}
        onPress={() => setPickerOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Câmera selecionada: ${selectedCamera?.name ?? 'nenhuma'}`}
      >
        <View style={styles.selectorLeft}>
          <View style={[styles.dot, { backgroundColor: selectedCamera && isOnlineStatus(selectedCamera.status) ? theme.success : theme.textMuted }]} />
          <Text style={[styles.selectorText, { color: theme.text }]} numberOfLines={1}>
            {selectedCamera?.name ?? 'Selecione uma câmera'}
          </Text>
        </View>
        <Icon name="chevronDown" size={18} color={theme.textSub} strokeWidth={2} />
      </Pressable>

      <View style={[styles.player, { borderColor: theme.border }]}>
        {activePlayback ? (
          <>
            <PlaybackVideo uri={activePlayback.url} posterUri={playerPoster} onRetry={onRetryPlayback} onNaoDecodificou={onNaoDecodificou} onProgresso={onProgressoPlayback} initialPositionSeconds={activePlayback.retomarEm ?? null} style={StyleSheet.absoluteFill} />
            <Pressable
              style={styles.closePlayback}
              onPress={onClosePlayback}
              hitSlop={8}
              accessibilityRole="button"
              accessibilityLabel="Fechar reprodução"
            >
              <Icon name="close" size={16} color="#fff" strokeWidth={2.2} />
            </Pressable>
          </>
        ) : (
          <>
            {playerPoster ? (
              <Image source={{ uri: playerPoster }} style={StyleSheet.absoluteFill} resizeMode="cover" />
            ) : (
              <LinearGradient colors={['#1f2937', '#0b1018']} start={{ x: 0.2, y: 0 }} end={{ x: 0.8, y: 1 }} style={StyleSheet.absoluteFill} />
            )}
            <View style={styles.playerShade} />
            <View style={styles.playerEmpty}>
              <Icon name="play" size={26} color="rgba(255,255,255,0.5)" fill />
              <Text style={styles.playerEmptyText}>Toque numa gravação para reproduzir</Text>
            </View>
          </>
        )}
      </View>

      <View style={styles.daysRow}>
        <Pressable
          style={[styles.dayNav, { backgroundColor: theme.surface, borderColor: theme.border }]}
          onPress={onPreviousDate}
          accessibilityRole="button"
          accessibilityLabel="Dia anterior"
        >
          <Icon name="chevronLeft" size={16} color={theme.textSub} strokeWidth={2.2} />
        </Pressable>
        <View style={[styles.dayPill, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Icon name="clock" size={14} color={theme.textSub} strokeWidth={2} />
          <Text style={[styles.dayPillText, { color: theme.text }]}>{formatDateLabel(recordingDate)}</Text>
        </View>
        <Pressable
          style={[styles.dayNav, { backgroundColor: theme.surface, borderColor: theme.border }, isToday && { opacity: 0.4 }]}
          onPress={isToday ? undefined : onNextDate}
          disabled={isToday}
          accessibilityRole="button"
          accessibilityLabel="Próximo dia"
          accessibilityState={{ disabled: isToday }}
        >
          <Icon name="chevronRight" size={16} color={theme.textSub} strokeWidth={2.2} />
        </Pressable>
      </View>

      <View style={[styles.timelineCard, { backgroundColor: theme.surface, borderColor: theme.border }]}>
        <View style={styles.timelineHeader}>
          {/* A régua desenha SÓ as gravações já carregadas (página de 50, mais
              recentes primeiro). Rotulá-la "24 horas" fazia a madrugada de um
              dia movimentado parecer vazia — o operador concluía que não houve
              gravação. Enquanto houver página pendente, o título diz a verdade
              e a dica convida a carregar o resto. */}
          <Text style={[styles.timelineTitle, { color: theme.text }]}>
            {recordingsTotal > recordings.length ? 'Linha do tempo · trecho carregado' : 'Linha do tempo · 24 horas'}
          </Text>
          <Text style={[styles.timelineHint, { color: theme.textSub }]}>
            {recordingsTotal > recordings.length
              ? `${recordings.length} de ${recordingsTotal} — role a lista para carregar mais`
              : 'toque no trecho para abrir'}
          </Text>
        </View>
        <View style={[styles.timelineTrack, { backgroundColor: theme.surfaceAlt }]}>
          {[25, 50, 75].map((left) => <View key={left} style={[styles.timelineGridLine, { left: `${left}%`, backgroundColor: theme.border }]} />)}
          {recordings.map((recording) => {
            const range = timelineRange(recording);
            const kind = recordingKind(recording);
            const usable = recording.fileUsable !== false && recording.fileExists !== false;
            const color = !usable ? theme.textMuted : kind === 'motion' ? theme.danger : kind === 'continuous' ? theme.accent : theme.warning;
            return (
              <Pressable
                key={recording.id}
                onPress={() => usable && onOpenPlayback(recording)}
                disabled={!usable}
                accessibilityRole="button"
                accessibilityLabel={`Gravação às ${formatTime(recording.startedAt)}`}
                style={[styles.timelineSegment, { left: `${range.left}%`, width: `${range.width}%`, backgroundColor: color }]}
              />
            );
          })}
        </View>
        <View style={styles.timelineLabels}>
          {['00h', '06h', '12h', '18h', '24h'].map((label) => <Text key={label} style={[styles.timelineLabel, { color: theme.textMuted }]}>{label}</Text>)}
        </View>
      </View>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {FILTERS.map(({ key, label }) => {
          const selected = filter === key;
          return (
            <Pressable
              key={key}
              onPress={() => setFilter(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[styles.filterChip, { backgroundColor: selected ? theme.accent : theme.surface, borderColor: selected ? theme.accent : theme.border }]}
            >
              <Text style={[styles.filterText, { color: selected ? theme.textOnAccent : theme.textSub }]}>{label}</Text>
              <Text style={[styles.filterCount, { color: selected ? theme.textOnAccent : theme.textMuted }]}>{filterCounts[key] ?? 0}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.listHeading}>
        <Text style={[styles.listTitle, { color: theme.bgText }]}>Gravações</Text>
        <Text style={[styles.listCount, { color: theme.textSub }]}>
          {filter === 'all' && recordingsTotal > recordings.length ? `${recordings.length} de ${recordingsTotal}` : filteredRecordings.length}
        </Text>
      </View>

      {loading && recordings.length === 0 ? (
        <View style={styles.loadingSkeleton}>
          <SkeletonBlock style={{ height: 68 }} />
          <SkeletonBlock style={{ height: 68 }} />
          <SkeletonBlock style={{ height: 68 }} />
        </View>
      ) : null}
      {error && !loading ? (
        <View style={[styles.errorBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
          {canPlayback ? (
            <Pressable style={[styles.retryButton, { backgroundColor: theme.accent }]} onPress={onRetry} accessibilityRole="button">
              <Text style={[styles.retryText, { color: theme.textOnAccent }]}>Tentar novamente</Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={filteredRecordings}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={header}
        ItemSeparatorComponent={() => <View style={{ height: 9 }} />}
        onEndReached={() => {
          if (!loading && !loadingMore && recordings.length < recordingsTotal) onLoadMore();
        }}
        onEndReachedThreshold={0.45}
        renderItem={({ item: rec }) => {
          const active = activePlayback?.recording.id === rec.id;
          const usable = rec.fileUsable !== false && rec.fileExists !== false;
          const downloading = downloadingIds.includes(rec.id);
          return (
            <Pressable
              onPress={() => usable && onOpenPlayback(rec)}
              disabled={!usable}
              accessibilityRole="button"
              accessibilityLabel={`Gravação de ${formatTime(rec.startedAt)}`}
              accessibilityState={{ disabled: !usable, selected: active }}
              style={[styles.recRow, { backgroundColor: active ? theme.accentBg : theme.surface, borderColor: active ? theme.accent : theme.border }, !usable && { opacity: 0.5 }]}
            >
              <View style={styles.recThumb}>
                {rec.thumbnailUrl ? (
                  <Image source={{ uri: rec.thumbnailUrl }} style={StyleSheet.absoluteFill} resizeMode="cover" onError={() => onThumbnailError?.(rec)} />
                ) : (
                  <LinearGradient colors={selectedCamera ? tintFor(selectedCamera) : ['#243044', '#101826']} style={StyleSheet.absoluteFill} />
                )}
                <View style={styles.recThumbShade} />
                <Icon name="play" size={16} color="#fff" fill />
              </View>
              <View style={{ flex: 1 }}>
                <Text style={[styles.recRange, { color: theme.text }]}>
                  {formatTime(rec.startedAt)} – {rec.endedAt ? formatTime(rec.endedAt) : 'agora'}
                </Text>
                <View style={styles.recMeta}>
                  <Text style={[styles.recDuration, { color: theme.textSub }]}>{formatDuration(rec.durationSeconds)}</Text>
                  <Text style={[styles.recDuration, { color: theme.textMuted }]}>{formatBytes(rec.actualSizeBytes ?? rec.sizeBytes)}</Text>
                  {!usable ? <Text style={[styles.recTag, { color: theme.warning, backgroundColor: 'rgba(245,158,11,0.14)' }]}>indisponível</Text> : null}
                </View>
              </View>
              {canDownload ? (
                <Pressable
                  onPress={(event) => { event.stopPropagation(); if (!downloading) onDownloadRecording(rec); }}
                  hitSlop={8}
                  disabled={!usable || downloading}
                  accessibilityRole="button"
                  accessibilityLabel={downloading ? 'Baixando gravação' : 'Baixar gravação'}
                  accessibilityState={{ disabled: !usable || downloading, busy: downloading }}
                >
                  {downloading ? <ActivityIndicator size="small" color={theme.accent} /> : <Icon name="download" size={19} color={theme.accent} strokeWidth={2} />}
                </Pressable>
              ) : null}
            </Pressable>
          );
        }}
        ListEmptyComponent={!loading && !error ? (
          <View style={[styles.empty, { borderColor: theme.border }]}>
            <Text style={[styles.emptyText, { color: theme.textSub }]}>
              {selectedCamera ? (filter === 'all' ? 'Nenhuma gravação neste dia.' : 'Nenhuma gravação corresponde a este filtro.') : 'Selecione uma câmera para ver as gravações.'}
            </Text>
          </View>
        ) : null}
        ListFooterComponent={loadingMore ? <ActivityIndicator style={styles.footerLoader} color={theme.accent} /> : <View style={{ height: 8 }} />}
      />

      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.pickerRoot}>
          <Pressable style={styles.backdrop} onPress={() => setPickerOpen(false)} accessibilityLabel="Fechar seleção de câmera" />
          <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
            <View style={[styles.grabber, { backgroundColor: theme.border }]} />
            <Text style={[styles.sheetTitle, { color: theme.bgText }]}>Selecionar câmera</Text>
            <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
              {cameras.map((cam) => {
                const selected = cam.id === selectedCamera?.id;
                return (
                  <Pressable
                    key={cam.id}
                    onPress={() => { onSelectCamera(cam.id); setPickerOpen(false); }}
                    accessibilityRole="button"
                    accessibilityState={{ selected }}
                    style={[styles.pickRow, { backgroundColor: selected ? theme.accentBg : theme.surface, borderColor: selected ? theme.accent : theme.border }]}
                  >
                    <LinearGradient colors={tintFor(cam)} style={styles.pickThumb} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.pickName, { color: theme.text }]} numberOfLines={1}>{cam.name}</Text>
                      <Text style={[styles.pickArea, { color: theme.textSub }]} numberOfLines={1}>{areaLabel(cam)}</Text>
                    </View>
                    {selected ? <Icon name="check" size={18} color={theme.accent} strokeWidth={2.6} /> : null}
                  </Pressable>
                );
              })}
            </ScrollView>
          </View>
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 22, paddingTop: 6, paddingBottom: 24 },
  headerContent: { gap: 14, marginBottom: 9 },
  title: { fontSize: 27, fontWeight: '800', letterSpacing: -0.5, marginTop: 10 },
  selector: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 12, paddingHorizontal: 15 },
  selectorLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  selectorText: { fontSize: 14, fontWeight: '700', flex: 1 },
  player: { height: 200, borderRadius: 18, overflow: 'hidden', borderWidth: StyleSheet.hairlineWidth, position: 'relative', backgroundColor: '#070809' },
  playerEmpty: { ...StyleSheet.absoluteFillObject, alignItems: 'center', justifyContent: 'center', gap: 10 },
  playerShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.28)' },
  playerEmptyText: { color: 'rgba(255,255,255,0.65)', fontSize: 12.5, fontWeight: '600' },
  closePlayback: { position: 'absolute', top: 10, right: 10, width: 30, height: 30, borderRadius: 10, backgroundColor: 'rgba(0,0,0,0.5)', alignItems: 'center', justifyContent: 'center' },
  daysRow: { flexDirection: 'row', gap: 8, alignItems: 'stretch' },
  dayNav: { width: 46, height: 44, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  dayPill: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, borderRadius: 13, borderWidth: StyleSheet.hairlineWidth },
  dayPillText: { fontSize: 14, fontWeight: '800' },
  timelineCard: { borderRadius: 15, borderWidth: StyleSheet.hairlineWidth, padding: 13 },
  timelineHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 10 },
  timelineTitle: { fontSize: 11.5, fontWeight: '800' },
  timelineHint: { fontSize: 9.5, fontWeight: '600' },
  timelineTrack: { height: 22, borderRadius: 7, overflow: 'hidden', position: 'relative' },
  timelineGridLine: { position: 'absolute', top: 0, bottom: 0, width: StyleSheet.hairlineWidth },
  timelineSegment: { position: 'absolute', top: 3, bottom: 3, borderRadius: 4, minWidth: 2 },
  timelineLabels: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 5 },
  timelineLabel: { fontSize: 8.5, fontWeight: '700' },
  filters: { gap: 7, paddingRight: 4 },
  filterChip: { flexDirection: 'row', alignItems: 'center', gap: 6, borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 7, paddingHorizontal: 11 },
  filterText: { fontSize: 11, fontWeight: '800' },
  filterCount: { fontSize: 9.5, fontWeight: '900' },
  listHeading: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  listTitle: { fontSize: 14, fontWeight: '800' },
  listCount: { fontSize: 11.5, fontWeight: '700' },
  stateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 16 },
  stateText: { fontSize: 12.5, fontWeight: '600' },
  loadingSkeleton: { gap: 9 },
  errorBox: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14, gap: 12, alignItems: 'flex-start' },
  errorText: { fontSize: 12.5, fontWeight: '600', lineHeight: 18 },
  retryButton: { borderRadius: 10, paddingHorizontal: 13, paddingVertical: 8 },
  retryText: { fontSize: 12, fontWeight: '800' },
  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 16, paddingVertical: 28, paddingHorizontal: 20, alignItems: 'center' },
  emptyText: { fontSize: 12.5, fontWeight: '600', textAlign: 'center' },
  recRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 11, paddingHorizontal: 13 },
  recThumb: { width: 44, height: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
  recThumbShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.2)' },
  recRange: { fontSize: 13.5, fontWeight: '700' },
  recMeta: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 3, flexWrap: 'wrap' },
  recDuration: { fontSize: 11, fontWeight: '600' },
  recTag: { fontSize: 9.5, fontWeight: '800', paddingVertical: 2, paddingHorizontal: 7, borderRadius: 6, overflow: 'hidden' },
  footerLoader: { paddingVertical: 18 },
  pickerRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 22, paddingTop: 8, paddingBottom: 34 },
  grabber: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 6, marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: '800', marginBottom: 14 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  pickThumb: { width: 42, height: 42, borderRadius: 11 },
  pickName: { fontSize: 13.5, fontWeight: '700' },
  pickArea: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
});
