/** Revisão (item 2.7): grade de eventos detectados (movimento/objeto/rosto) com
 *  rótulo e confiança; tocar abre a reprodução NO INSTANTE do evento. Consome
 *  GET /review/feed — que já filtra câmera privada no backend, então esta tela
 *  não infere nem expõe nada além do que o feed devolve. */
import { LinearGradient } from 'expo-linear-gradient';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Image, Modal, Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Icon } from '../components/Icon';
import { PlaybackVideo } from '../components/VideoPlayers';
import { useTheme } from '../theme/ThemeProvider';
import { isRedesign } from '../theme/redesign';
import type { Camera } from '../types';
import { areaLabel, tintFor } from '../utils/camera-view';
import {
  REVIEW_LABEL_OPTIONS,
  formatConfidence,
  formatReviewTime,
  labelDisplay,
  matchesReviewFilter,
  reviewThumbnailUrl,
  type ReviewFilters,
  type ReviewItem,
  type ReviewLabelFilter,
} from '../utils/review';

export type ReviewPlayback = { url: string; posterUri: string | null; offsetSeconds: number };

interface ReviewScreenProps {
  items: ReviewItem[];
  total: number;
  unseenCount: number;
  loading: boolean;
  refreshing: boolean;
  error: string | null;
  filters: ReviewFilters;
  cameras: Camera[];
  apiUrl: string;
  token: string;
  canPlayback: boolean;
  reviewPlayback: ReviewPlayback | null;
  onChangeFilters: (next: ReviewFilters) => void;
  onRefresh: () => void;
  /** Carrega a próxima página (paginação). Sem isto, os eventos além do primeiro
   *  lote eram inatingíveis: a lista não tinha onEndReached nem offset. */
  onLoadMore?: () => void;
  loadingMore?: boolean;
  onOpenItem: (item: ReviewItem) => void;
  onCloseReviewPlayback: () => void;
  onMarkSeen: (item: ReviewItem, seen: boolean) => void;
}

/** Miniatura do evento, buscada com o token (endpoint autenticado que respeita
 *  o gate de câmera privada). Sem gravação → placeholder, sem chamada de rede. */
function EventThumb({ apiUrl, token, item, onError }: { apiUrl: string; token: string; item: ReviewItem; onError: () => void }) {
  const { theme } = useTheme();
  if (!item.recordingId) {
    return (
      <View style={[StyleSheet.absoluteFill, thumb.placeholder]}>
        <Icon name="videoOff" size={18} color="rgba(255,255,255,0.35)" strokeWidth={2} />
        <Text style={thumb.placeholderText}>sem gravação</Text>
      </View>
    );
  }
  return (
    <Image
      source={{ uri: reviewThumbnailUrl(apiUrl, item.id), headers: { Authorization: `Bearer ${token}` } }}
      style={StyleSheet.absoluteFill}
      resizeMode="cover"
      onError={onError}
    />
  );
}

export function ReviewScreen({
  items, total, unseenCount, loading, refreshing, loadingMore, onLoadMore, error, filters, cameras, apiUrl, token, canPlayback,
  reviewPlayback, onChangeFilters, onRefresh, onOpenItem, onCloseReviewPlayback, onMarkSeen,
}: ReviewScreenProps) {
  const { theme } = useTheme();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [thumbFailed, setThumbFailed] = useState<Record<string, boolean>>({});

  const selectedCamera = filters.cameraId ? cameras.find((camera) => camera.id === filters.cameraId) ?? null : null;
  // O feed já vem filtrado do backend; o predicado local só mantém a grade
  // coerente sem refetch (ex.: marcar visto com "Só não vistos" ativo).
  const visible = useMemo(() => items.filter((item) => matchesReviewFilter(item, filters)), [items, filters]);

  const setLabel = (label: ReviewLabelFilter) => onChangeFilters({ ...filters, label });
  const toggleConfirmed = () => onChangeFilters({ ...filters, onlyConfirmed: !filters.onlyConfirmed });
  const toggleUnseen = () => onChangeFilters({ ...filters, unseenOnly: !filters.unseenOnly });
  const selectCamera = (cameraId: string | null) => { onChangeFilters({ ...filters, cameraId }); setPickerOpen(false); };

  const header = (
    <View style={styles.headerContent}>
      <View style={styles.titleRow}>
        <View style={{ flex: 1 }}>
          <Text style={[styles.title, { color: theme.bgText }]}>Revisão</Text>
          <Text style={[styles.subtitle, { color: theme.textSub }]}>
            {unseenCount > 0 ? `${unseenCount} não revisado(s)` : 'Tudo revisado'}
            {total > 0 ? ` · ${total} evento(s)` : ''}
          </Text>
        </View>
        <Pressable
          onPress={onRefresh}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel="Atualizar"
          style={[styles.refreshBtn, { backgroundColor: theme.surface, borderColor: theme.border }]}
        >
          <Icon name="clock" size={17} color={theme.textSub} strokeWidth={2} />
        </Pressable>
      </View>

      <Pressable
        style={[styles.selector, { backgroundColor: theme.surface, borderColor: theme.border }]}
        onPress={() => setPickerOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={`Câmera: ${selectedCamera?.name ?? 'todas'}`}
      >
        <View style={styles.selectorLeft}>
          <Icon name="camera" size={16} color={theme.textSub} strokeWidth={2} />
          <Text style={[styles.selectorText, { color: theme.text }]} numberOfLines={1}>
            {selectedCamera?.name ?? 'Todas as câmeras'}
          </Text>
        </View>
        <Icon name="chevronDown" size={18} color={theme.textSub} strokeWidth={2} />
      </Pressable>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filters}>
        {REVIEW_LABEL_OPTIONS.map(({ key, label }) => {
          const selected = (filters.label ?? 'all') === key;
          return (
            <Pressable
              key={key}
              onPress={() => setLabel(key)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              style={[styles.chip, { backgroundColor: selected ? theme.accent : theme.surface, borderColor: selected ? theme.accent : theme.border }]}
            >
              <Text style={[styles.chipText, { color: selected ? theme.textOnAccent : theme.textSub }]}>{label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>

      <View style={styles.toggleRow}>
        <Pressable
          onPress={toggleConfirmed}
          accessibilityRole="button"
          accessibilityState={{ selected: !!filters.onlyConfirmed }}
          style={[styles.toggle, { backgroundColor: filters.onlyConfirmed ? theme.accentBg : theme.surface, borderColor: filters.onlyConfirmed ? theme.accent : theme.border }]}
        >
          {filters.onlyConfirmed ? <Icon name="check" size={14} color={theme.accent} strokeWidth={2.6} /> : <Icon name="aperture" size={14} color={theme.textSub} strokeWidth={2} />}
          <Text style={[styles.toggleText, { color: filters.onlyConfirmed ? theme.accent : theme.textSub }]}>Só com objeto</Text>
        </Pressable>
        <Pressable
          onPress={toggleUnseen}
          accessibilityRole="button"
          accessibilityState={{ selected: !!filters.unseenOnly }}
          style={[styles.toggle, { backgroundColor: filters.unseenOnly ? theme.accentBg : theme.surface, borderColor: filters.unseenOnly ? theme.accent : theme.border }]}
        >
          <Icon name="eye" size={14} color={filters.unseenOnly ? theme.accent : theme.textSub} strokeWidth={2} />
          <Text style={[styles.toggleText, { color: filters.unseenOnly ? theme.accent : theme.textSub }]}>{filters.unseenOnly ? 'Só não vistos' : 'Todos'}</Text>
        </Pressable>
      </View>

      {error && !loading ? (
        <View style={[styles.errorBox, { backgroundColor: theme.surface, borderColor: theme.border }]}>
          <Text style={[styles.errorText, { color: theme.text }]}>{error}</Text>
        </View>
      ) : null}
    </View>
  );

  if (!canPlayback) {
    return (
      <View style={styles.permissionRoot}>
        <Icon name="lock" size={28} color={theme.textMuted} strokeWidth={1.8} />
        <Text style={[styles.permissionText, { color: theme.textSub }]}>Você não possui permissão para revisar eventos.</Text>
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      <FlatList
        data={visible}
        keyExtractor={(item) => item.id}
        numColumns={2}
        columnWrapperStyle={styles.column}
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        ListHeaderComponent={header}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={theme.accent} />}
        onEndReachedThreshold={0.4}
        onEndReached={() => {
          // Só pede mais se ainda há o que buscar e não há carga em voo (senão o
          // FlatList dispara em rajada durante a rolagem).
          if (onLoadMore && !loadingMore && !loading && !refreshing && items.length < total) onLoadMore();
        }}
        renderItem={({ item }) => {
          const confidence = formatConfidence(item);
          const failed = thumbFailed[item.id];
          const openable = !!item.recordingId;
          return (
            <View style={[styles.card, { backgroundColor: theme.surface, borderColor: item.reviewed ? theme.border : theme.accent }, item.reviewed && { opacity: 0.68 }]}>
              <Pressable
                onPress={() => openable && onOpenItem(item)}
                disabled={!openable}
                accessibilityRole="button"
                accessibilityLabel={`${labelDisplay(item)} em ${item.cameraName ?? 'câmera'} às ${formatReviewTime(item.occurredAt)}`}
                accessibilityState={{ disabled: !openable }}
                style={styles.thumbWrap}
              >
                {failed ? (
                  <View style={[StyleSheet.absoluteFill, thumb.placeholder]}>
                    <Text style={thumb.placeholderText}>sem prévia</Text>
                  </View>
                ) : (
                  <EventThumb apiUrl={apiUrl} token={token} item={item} onError={() => setThumbFailed((prev) => ({ ...prev, [item.id]: true }))} />
                )}
                <View style={styles.thumbShade} />
                <View style={[styles.labelBadge, { backgroundColor: 'rgba(0,0,0,0.66)' }]}>
                  <Text style={styles.labelText} numberOfLines={1}>{labelDisplay(item)}</Text>
                  {confidence ? <Text style={styles.confText}>{confidence}</Text> : null}
                </View>
                {item.reviewed ? (
                  <View style={[styles.seenDot, { backgroundColor: theme.success }]}>
                    <Icon name="check" size={11} color="#fff" strokeWidth={3} />
                  </View>
                ) : null}
                {openable ? (
                  <View style={styles.playHint}>
                    <Icon name="play" size={14} color="#fff" fill />
                  </View>
                ) : null}
              </Pressable>
              <View style={styles.cardFooter}>
                <View style={{ flex: 1 }}>
                  <Text style={[styles.cameraName, { color: theme.text }]} numberOfLines={1}>{item.cameraName ?? 'Câmera'}</Text>
                  <Text style={[styles.timeText, { color: theme.textMuted }]}>{formatReviewTime(item.occurredAt)}</Text>
                </View>
                <Pressable
                  onPress={() => onMarkSeen(item, !item.reviewed)}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel={item.reviewed ? 'Marcar como não visto' : 'Marcar como visto'}
                  style={[styles.seenBtn, { borderColor: theme.border }]}
                >
                  <Icon name={item.reviewed ? 'eye' : 'check'} size={14} color={theme.textSub} strokeWidth={2.2} />
                </Pressable>
              </View>
            </View>
          );
        }}
        ListEmptyComponent={loading ? (
          <View style={styles.stateRow}>
            <ActivityIndicator color={theme.accent} />
            <Text style={[styles.stateText, { color: theme.textSub }]}>Carregando eventos…</Text>
          </View>
        ) : !error ? (
          <View style={[styles.empty, { borderColor: theme.border }]}>
            <Icon name="eye" size={26} color={theme.textMuted} strokeWidth={1.6} />
            <Text style={[styles.emptyText, { color: theme.textSub }]}>Nenhum evento para revisar.</Text>
            <Text style={[styles.emptyHint, { color: theme.textMuted }]}>Ajuste os filtros ou aguarde novas detecções.</Text>
          </View>
        ) : null}
        ListFooterComponent={loadingMore ? (
          <View style={styles.footerLoading}>
            <ActivityIndicator color={theme.accent} />
          </View>
        ) : <View style={{ height: 14 }} />}
      />

      <Modal visible={pickerOpen} transparent animationType="slide" onRequestClose={() => setPickerOpen(false)}>
        <View style={styles.pickerRoot}>
          <Pressable style={styles.backdrop} onPress={() => setPickerOpen(false)} accessibilityLabel="Fechar seleção de câmera" />
          <View style={[styles.sheet, { backgroundColor: theme.bg, borderColor: theme.border }]}>
            <View style={[styles.grabber, { backgroundColor: theme.border }]} />
            <Text style={[styles.sheetTitle, { color: theme.bgText }]}>Filtrar por câmera</Text>
            <ScrollView style={{ maxHeight: 440 }} contentContainerStyle={{ gap: 8 }} showsVerticalScrollIndicator={false}>
              <Pressable
                onPress={() => selectCamera(null)}
                accessibilityRole="button"
                accessibilityState={{ selected: !filters.cameraId }}
                style={[styles.pickRow, { backgroundColor: !filters.cameraId ? theme.accentBg : theme.surface, borderColor: !filters.cameraId ? theme.accent : theme.border }]}
              >
                <View style={[styles.pickThumb, { backgroundColor: theme.surfaceAlt, alignItems: 'center', justifyContent: 'center' }]}>
                  <Icon name="grid" size={18} color={theme.textSub} strokeWidth={2} />
                </View>
                <Text style={[styles.pickName, { color: theme.text, flex: 1 }]} numberOfLines={1}>Todas as câmeras</Text>
                {!filters.cameraId ? <Icon name="check" size={18} color={theme.accent} strokeWidth={2.6} /> : null}
              </Pressable>
              {cameras.map((cam) => {
                const selected = cam.id === filters.cameraId;
                return (
                  <Pressable
                    key={cam.id}
                    onPress={() => selectCamera(cam.id)}
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

      <Modal visible={!!reviewPlayback} transparent animationType="fade" onRequestClose={onCloseReviewPlayback}>
        <View style={styles.playerRoot}>
          {reviewPlayback ? (
            <PlaybackVideo
              uri={reviewPlayback.url}
              posterUri={reviewPlayback.posterUri}
              initialPositionSeconds={reviewPlayback.offsetSeconds}
              style={styles.playerVideo}
            />
          ) : null}
          <Pressable
            style={styles.playerClose}
            onPress={onCloseReviewPlayback}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Fechar reprodução"
          >
            <Icon name="close" size={18} color="#fff" strokeWidth={2.2} />
          </Pressable>
        </View>
      </Modal>
    </View>
  );
}

const thumb = StyleSheet.create({
  placeholder: { alignItems: 'center', justifyContent: 'center', gap: 4, backgroundColor: 'rgba(0,0,0,0.5)' },
  placeholderText: { color: 'rgba(255,255,255,0.4)', fontSize: 10, fontWeight: '600' },
});

const styles = StyleSheet.create({
  content: { paddingHorizontal: 18, paddingTop: 6, paddingBottom: 24 },
  column: { gap: 10 },
  headerContent: { gap: 12, marginBottom: 12 },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, marginTop: 10 },
  title: { fontSize: 27, fontWeight: '800', letterSpacing: -0.5 },
  subtitle: { fontSize: 12.5, fontWeight: '600', marginTop: 3 },
  refreshBtn: { width: 40, height: 40, borderRadius: 12, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  footerLoading: { paddingVertical: 20, alignItems: 'center' },
  selector: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 12, paddingHorizontal: 15 },
  selectorLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flex: 1 },
  selectorText: { fontSize: 14, fontWeight: '700', flex: 1 },
  filters: { gap: 7, paddingRight: 4 },
  chip: { borderRadius: 999, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 7, paddingHorizontal: 13 },
  chipText: { fontSize: 11.5, fontWeight: '800' },
  toggleRow: { flexDirection: 'row', gap: 8 },
  toggle: { flex: 1, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 6, borderRadius: 11, borderWidth: StyleSheet.hairlineWidth, paddingVertical: 9 },
  toggleText: { fontSize: 11.5, fontWeight: '800' },
  errorBox: { borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 14 },
  errorText: { fontSize: 12.5, fontWeight: '600', lineHeight: 18 },
  card: { flex: 1, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, overflow: 'hidden' },
  thumbWrap: { aspectRatio: 16 / 10, width: '100%', backgroundColor: '#070809', position: 'relative' },
  thumbShade: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.12)' },
  labelBadge: { position: 'absolute', left: 6, top: 6, flexDirection: 'row', alignItems: 'center', gap: 5, borderRadius: 6, paddingVertical: 3, paddingHorizontal: 7, maxWidth: '85%' },
  labelText: { color: 'rgba(255,255,255,0.95)', fontSize: 10.5, fontWeight: '800' },
  confText: { color: 'rgba(255,255,255,0.6)', fontSize: 10, fontWeight: '700' },
  seenDot: { position: 'absolute', right: 6, top: 6, width: 18, height: 18, borderRadius: 9, alignItems: 'center', justifyContent: 'center' },
  playHint: { position: 'absolute', right: 6, bottom: 6, width: 26, height: 26, borderRadius: 13, backgroundColor: 'rgba(0,0,0,0.45)', alignItems: 'center', justifyContent: 'center' },
  cardFooter: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 9, paddingVertical: 8 },
  cameraName: { fontSize: 12, fontWeight: '700' },
  timeText: { fontSize: 10, fontWeight: '600', marginTop: 2, fontVariant: ['tabular-nums'] },
  seenBtn: { width: 30, height: 30, borderRadius: 9, borderWidth: StyleSheet.hairlineWidth, alignItems: 'center', justifyContent: 'center' },
  stateRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 40 },
  stateText: { fontSize: 12.5, fontWeight: '600' },
  empty: { borderWidth: 1, borderStyle: 'dashed', borderRadius: 16, paddingVertical: 34, paddingHorizontal: 20, alignItems: 'center', gap: 8, marginTop: 6 },
  emptyText: { fontSize: 13, fontWeight: '700', textAlign: 'center' },
  emptyHint: { fontSize: 11.5, fontWeight: '600', textAlign: 'center' },
  permissionRoot: { flex: 1, alignItems: 'center', justifyContent: 'center', gap: 12, paddingHorizontal: 40 },
  permissionText: { fontSize: 13, fontWeight: '600', textAlign: 'center', lineHeight: 20 },
  pickerRoot: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(0,0,0,0.5)' },
  sheet: { borderTopLeftRadius: 28, borderTopRightRadius: 28, borderWidth: StyleSheet.hairlineWidth, paddingHorizontal: 22, paddingTop: 8, paddingBottom: 34 },
  grabber: { width: 40, height: 5, borderRadius: 3, alignSelf: 'center', marginTop: 6, marginBottom: 12 },
  sheetTitle: { fontSize: 18, fontWeight: '800', marginBottom: 14 },
  pickRow: { flexDirection: 'row', alignItems: 'center', gap: 12, borderRadius: 14, borderWidth: StyleSheet.hairlineWidth, padding: 10 },
  pickThumb: { width: 42, height: 42, borderRadius: 11 },
  pickName: { fontSize: 13.5, fontWeight: '700' },
  pickArea: { fontSize: 11.5, fontWeight: '600', marginTop: 1 },
  playerRoot: { flex: 1, backgroundColor: '#000', alignItems: 'center', justifyContent: 'center' },
  playerVideo: { width: '100%', aspectRatio: 16 / 9, backgroundColor: '#000' },
  playerClose: { position: 'absolute', top: 40, right: 18, width: 38, height: 38, borderRadius: 12, backgroundColor: 'rgba(0,0,0,0.55)', alignItems: 'center', justifyContent: 'center' },
});
