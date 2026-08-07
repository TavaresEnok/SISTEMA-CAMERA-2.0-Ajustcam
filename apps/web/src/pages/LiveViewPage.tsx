import { useEffect, useMemo, useRef, useState, useCallback, type ReactNode } from 'react';
import axios from 'axios';
import { useLocation } from 'wouter';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Circle,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Filter,
  FolderOpen,
  Grid2X2,
  Grid3X3,
  LayoutGrid,
  Maximize2,
  Monitor,
  PanelRightClose,
  PanelRightOpen,
  Pencil,
  Save,
  Search,
  ShieldCheck,
  Trash2,
  Video,
  X,
} from 'lucide-react';
import { CameraTile } from '../components/CameraTile';
import { Camera, SavedLayout, useVmsDataStore } from '../store/vmsDataStore';
import { useGridStore, GridSize } from '../store/gridStore';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from '../store/authStore';
import { useToast } from '../hooks/use-toast';
import { useAutoHideControls } from '../hooks/use-auto-hide-controls';
import { ToastAction } from '@/components/ui/toast';

// Presets (atalhos rápidos). Qualquer CxL livre também é aceito via campo custom.
const GRID_PRESETS: { size: GridSize; icon: ReactNode }[] = [
  { size: '1x1', icon: <Monitor className="w-3.5 h-3.5" /> },
  { size: '2x2', icon: <Grid2X2 className="w-3.5 h-3.5" /> },
  { size: '3x3', icon: <Grid3X3 className="w-3.5 h-3.5" /> },
  { size: '4x4', icon: <Grid3X3 className="w-3.5 h-3.5" /> },
  { size: '5x5', icon: <LayoutGrid className="w-3.5 h-3.5" /> },
];

const GRID_MIN = 1;
const GRID_MAX = 8; // limite por dimensão
const GRID_CELL_WARN = 16; // acima disso, avisa sobre CPU (transcode H.265)
const LIVE_PANEL_AUTO_COLLAPSE_WIDTH = 1100;

/** Colunas × linhas de uma grade "CxL", com limites (1..8). */
function gridDims(size: string): { cols: number; rows: number } {
  const m = /^(\d+)x(\d+)$/.exec(String(size));
  const clamp = (n: number) => Math.min(GRID_MAX, Math.max(GRID_MIN, n || GRID_MIN));
  return { cols: clamp(m ? parseInt(m[1], 10) : 2), rows: clamp(m ? parseInt(m[2], 10) : 2) };
}
function makeGridSize(cols: number, rows: number): GridSize {
  const c = Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(cols) || GRID_MIN));
  const r = Math.min(GRID_MAX, Math.max(GRID_MIN, Math.round(rows) || GRID_MIN));
  return `${c}x${r}`;
}

const STATUS_FILTERS = ['all', 'online', 'recording', 'motion', 'alarm', 'offline', 'no_signal', 'maintenance'] as const;
type StatusFilter = (typeof STATUS_FILTERS)[number];
const STATUS_FILTER_LABEL: Record<StatusFilter, string> = {
  all: 'Todos',
  online: 'Online',
  recording: 'Gravando',
  motion: 'Movimento',
  alarm: 'Alarme',
  offline: 'Offline',
  no_signal: 'Sem sinal',
  maintenance: 'Manutenção',
};

const LIVE_LAYOUTS_STORAGE_KEY = 'drac.live.layouts.v1';
const streamStartDelay = (slotIndex: number, totalSlots: number) => {
  if (totalSlots < 4) return 0;
  // Distribui a emissão de tokens e os handshakes. O limite antigo de 1,5 s
  // fazia dezenas de câmeras iniciarem juntas em grades grandes.
  const stepMs = totalSlots >= 16 ? 200 : totalSlots >= 9 ? 150 : 100;
  return slotIndex * stepMs;
};

type ApiLiveLayout = {
  id: string;
  name: string;
  gridSize: string;
  cameraIds: unknown;
  lastUsedAt?: string;
  createdAt?: string;
};

function mapApiLiveLayout(layout: ApiLiveLayout): SavedLayout | null {
  if (!/^[1-8]x[1-8]$/.test(layout.gridSize) || !Array.isArray(layout.cameraIds)) return null;
  return {
    id: layout.id,
    name: layout.name,
    gridSize: layout.gridSize as GridSize,
    cameraIds: layout.cameraIds.map(String),
    createdBy: useAuthStore.getState().user?.name ?? 'Operador',
    lastUsed: layout.lastUsedAt ?? layout.createdAt ?? new Date().toISOString(),
  };
}

function loadSavedLayouts(): SavedLayout[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(LIVE_LAYOUTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as SavedLayout[];
    return Array.isArray(parsed)
      ? parsed.filter((layout) => layout && typeof layout.id === 'string' && Array.isArray(layout.cameraIds))
      : [];
  } catch {
    return [];
  }
}

function persistSavedLayouts(layouts: SavedLayout[]) {
  if (typeof window === 'undefined') return;
  window.localStorage.setItem(LIVE_LAYOUTS_STORAGE_KEY, JSON.stringify(layouts));
}

export default function LiveViewPage() {
  const API_URL = getApiBaseUrl();
  const accessToken = useAuthStore((state) => state.accessToken);
  const allCameras = useVmsDataStore((state) => state.cameras);
  // Câmeras desativadas não aparecem no ao vivo (continuam na página Câmeras p/ reativar).
  const cameras = useMemo(() => allCameras.filter((camera) => camera.enabled !== false), [allCameras]);
  const loadData = useVmsDataStore((state) => state.load);
  const generatedLayouts = useVmsDataStore((state) => state.layouts);
  const { gridSize, cameraIds, wallMode, prevLayout, setGridSize, setCameraIds, toggleWallMode, savePrevLayout, clearPrevLayout } = useGridStore();
  const [, setLocation] = useLocation();
  // Selo e botão do mural somem sozinhos depois de 3s parado.
  const muralControles = useAutoHideControls(wallMode);
  const { toast } = useToast();
  const [selectedCam, setSelectedCam] = useState<string | null>(null);
  const [panelOpen, setPanelOpen] = useState(true);
  const [search, setSearch] = useState('');
  const [zoneFilter, setZoneFilter] = useState('__all__');
  const [statusFilter, setStatusFilter] = useState<(typeof STATUS_FILTERS)[number]>('all');
  const [recordingActionLoading, setRecordingActionLoading] = useState<'start' | 'stop' | null>(null);
  const [recordingOverrides, setRecordingOverrides] = useState<Record<string, boolean>>({});
  const [savedLayouts, setSavedLayouts] = useState<SavedLayout[]>(() => loadSavedLayouts());
  const [selectedSlotIndex, setSelectedSlotIndex] = useState<number | null>(null);
  const [layoutSelectValue, setLayoutSelectValue] = useState('');
  const [layoutDialog, setLayoutDialog] = useState<{ mode: 'save' | 'rename'; id?: string; name: string } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedLayout | null>(null);

  useEffect(() => {
    if (!accessToken) return;
    let cancelled = false;
    const headers = { Authorization: `Bearer ${accessToken}` };

    void (async () => {
      try {
        const response = await axios.get<ApiLiveLayout[]>(`${API_URL}/live-layouts`, { headers });
        if (cancelled) return;
        const remoteLayouts = response.data.map(mapApiLiveLayout).filter((layout): layout is SavedLayout => Boolean(layout));
        if (remoteLayouts.length) {
          setSavedLayouts(remoteLayouts);
          persistSavedLayouts(remoteLayouts);
          return;
        }

        const localLayouts = loadSavedLayouts();
        if (!localLayouts.length) return;
        // Trava de migração ÚNICA (sessionStorage cobre duas abas do mesmo
        // navegador): sem ela, duas abas de /live abertas com o servidor ainda
        // vazio migravam as duas — layouts duplicados no servidor.
        const TRAVA = 'drac-live-layouts-migrando';
        if (window.sessionStorage.getItem(TRAVA)) return;
        window.sessionStorage.setItem(TRAVA, String(Date.now()));
        const migrated = await Promise.all(localLayouts.map(async (layout) => {
          const created = await axios.post<ApiLiveLayout>(`${API_URL}/live-layouts`, {
            name: layout.name,
            gridSize: layout.gridSize,
            cameraIds: layout.cameraIds,
          }, { headers });
          return mapApiLiveLayout(created.data);
        }));
        if (cancelled) return;
        const valid = migrated.filter((layout): layout is SavedLayout => Boolean(layout));
        setSavedLayouts(valid);
        persistSavedLayouts(valid);
      } catch {
        // O cache local continua funcional durante indisponibilidade da API.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [API_URL, accessToken]);

  const zoneFilters = useMemo(
    () => ['__all__', ...Array.from(new Set(cameras.map((camera) => camera.zone)))],
    [cameras],
  );
  const selectedCameraObj = useMemo(
    () => (selectedCam ? cameras.find((camera) => camera.id === selectedCam) ?? null : null),
    [cameras, selectedCam],
  );
  const availableLayouts = savedLayouts.length ? savedLayouts : generatedLayouts;

  const isCameraRecording = useCallback((camera: Camera | null | undefined) => {
    if (!camera) return false;
    const override = recordingOverrides[camera.id];
    if (typeof override === 'boolean') return override;
    return camera.status === 'recording';
  }, [recordingOverrides]);

  const isRecording = isCameraRecording(selectedCameraObj);

  useEffect(() => {
    if (!cameraIds.length && cameras.length) {
      const onlineFirst = [...cameras].sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
      setCameraIds(onlineFirst.slice(0, 4).map((camera) => camera.id));
    }
  }, [cameraIds.length, cameras, setCameraIds]);

  useEffect(() => {
    // Colapsa só ao CRUZAR o limiar (largo→estreito). A versão anterior rodava
    // em todo resize e, com a janela já estreita, fechava o painel que o
    // operador tinha acabado de abrir para escolher câmera — abrir DevTools ou
    // girar a tela bastava para perder o painel no meio da ação.
    let estavaLargo = window.innerWidth >= LIVE_PANEL_AUTO_COLLAPSE_WIDTH;
    const collapseWhenTight = () => {
      const estreitoAgora = window.innerWidth < LIVE_PANEL_AUTO_COLLAPSE_WIDTH;
      if (estreitoAgora && estavaLargo) setPanelOpen(false);
      estavaLargo = !estreitoAgora;
    };
    if (window.innerWidth < LIVE_PANEL_AUTO_COLLAPSE_WIDTH) setPanelOpen(false);
    window.addEventListener('resize', collapseWhenTight);
    return () => window.removeEventListener('resize', collapseWhenTight);
  }, []);

  // Reconcilia o override otimista de gravação com o estado real do servidor: assim
  // que camera.status reflete o valor esperado, o override é removido. Sem isso, um
  // override antigo teria precedência permanente e mostraria "Gravando" para sempre.
  useEffect(() => {
    setRecordingOverrides((current) => {
      if (!Object.keys(current).length) return current;
      let changed = false;
      const next = { ...current };
      for (const camera of cameras) {
        if (camera.id in next && next[camera.id] === (camera.status === 'recording')) {
          delete next[camera.id];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [cameras]);

  const { cols: gridCols, rows: gridRows } = gridDims(gridSize);
  const count = gridCols * gridRows;
  const cameraById = useMemo(() => new Map(cameras.map((camera) => [camera.id, camera])), [cameras]);
  const displayedCams = useMemo<(Camera | null)[]>(() => {
    // Dedupe: layouts antigos podem repetir a mesma câmera; a 2ª ocorrência vira
    // slot vazio (as keys da grade são por id — duplicado quebraria o React).
    const seen = new Set<string>();
    const slots: (Camera | null)[] = cameraIds.slice(0, count).map((id) => {
      const cam = cameraById.get(id) ?? null;
      if (!cam || seen.has(cam.id)) return null;
      seen.add(cam.id);
      return cam;
    });
    while (slots.length < count) slots.push(null);
    return slots;
  }, [cameraIds, count, cameraById]);

  // "Preencher": escolhe a MENOR grade que cabe todas as câmeras (até 5x5) e
  // preenche os quadros — online primeiro. Otimiza o espaço automaticamente.
  const fillGrid = useCallback(() => {
    const ordered = [...cameras].sort((a, b) => Number(b.isOnline) - Number(a.isOnline));
    const n = ordered.length;
    const size: GridSize = n <= 1 ? '1x1' : n <= 4 ? '2x2' : n <= 9 ? '3x3' : n <= 16 ? '4x4' : n <= 25 ? '5x5' : '6x6';
    const { cols, rows } = gridDims(size);
    setGridSize(size);
    setCameraIds(ordered.slice(0, cols * rows).map((c) => c.id));
  }, [cameras, setGridSize, setCameraIds]);

  const onlineCount = useMemo(() => cameras.filter((c) => c.isOnline).length, [cameras]);
  const recordingCount = useMemo(() => cameras.filter((c) => c.status === 'recording').length, [cameras]);
  const alarmCount = useMemo(() => cameras.filter((c) => c.status === 'alarm').length, [cameras]);

  const filteredList = useMemo(() => {
    const q = search.toLowerCase();
    return cameras.filter((c) => {
      const matchSearch = !q || c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q) || c.ipAddress.includes(q);
      const matchZona = zoneFilter === '__all__' || c.zone === zoneFilter;
      const matchStatus = statusFilter === 'all' || c.status === statusFilter;
      return matchSearch && matchZona && matchStatus;
    });
  }, [cameras, search, zoneFilter, statusFilter]);

  // Zoom para 1x1 guardando o layout anterior, para poder VOLTAR à grade.
  // prevLayout agora vem do Zustand store (gridStore) com persistência em
  // sessionStorage — sobrevive re-renders, re-mounts e page refresh.

  const zoomToCamera = useCallback((cameraId: string) => {
    if (gridSize !== '1x1') savePrevLayout({ gridSize, cameraIds });
    setGridSize('1x1');
    setCameraIds([cameraId]);
  }, [gridSize, cameraIds, setGridSize, setCameraIds, savePrevLayout]);

  const restoreLayout = useCallback(() => {
    if (!prevLayout) return;
    setGridSize(prevLayout.gridSize);
    setCameraIds(prevLayout.cameraIds);
    clearPrevLayout();
  }, [prevLayout, setGridSize, setCameraIds, clearPrevLayout]);

  // Esc volta para a grade anterior — exceto digitando num campo ou com diálogo
  // aberto (nesses casos o Esc pertence ao campo/diálogo).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (layoutDialog || deleteTarget) return;
      // No mural em tela cheia, Esc é a primeira tecla que todo operador tenta
      // — e não fazia nada (o botão "Sair" é pequeno e fica no canto).
      if (wallMode) { toggleWallMode(); return; }
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
      // Esc com um popover/menu/diálogo Radix aberto pertence a ELE (fechá-lo),
      // não à página: sem esta guarda, fechar o popover "Layouts" também tirava
      // o operador do zoom 1×1 — dois efeitos para uma tecla.
      if (document.querySelector('[data-radix-popper-content-wrapper], [role="dialog"][data-state="open"]')) return;
      restoreLayout();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [restoreLayout, layoutDialog, deleteTarget, wallMode, toggleWallMode]);

  const handleCamAction = useCallback((action: string, camera: Camera) => {
    if (action === 'playback') setLocation(`/playback?cameraId=${encodeURIComponent(camera.id)}`);
    if (action === 'ptz') setLocation(`/cameras/${camera.id}?tab=ptz`);
    if (action === 'info') setLocation(`/cameras/${camera.id}`);
    if (action === 'record-start') {
      void (async () => {
        if (!accessToken) return;
        setRecordingOverrides((current) => ({ ...current, [camera.id]: true }));
        try {
          await axios.post(`${API_URL}/cameras/${camera.id}/recording/start`, {}, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          void loadData();
          toast({ title: 'Gravação iniciada', description: camera.name });
        } catch (error) {
          setRecordingOverrides((current) => ({ ...current, [camera.id]: camera.status === 'recording' }));
          toast({ title: 'Erro ao iniciar gravação', description: error instanceof Error ? error.message : 'Falha ao iniciar gravação manual.', variant: 'destructive' });
        }
      })();
    }
    if (action === 'record-stop') {
      void (async () => {
        if (!accessToken) return;
        setRecordingOverrides((current) => ({ ...current, [camera.id]: false }));
        try {
          await axios.post(`${API_URL}/cameras/${camera.id}/recording/stop`, {}, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          void loadData();
          toast({ title: 'Gravação parada', description: camera.name });
        } catch (error) {
          setRecordingOverrides((current) => ({ ...current, [camera.id]: camera.status === 'recording' }));
          toast({ title: 'Erro ao parar gravação', description: error instanceof Error ? error.message : 'Falha ao parar gravação manual.', variant: 'destructive' });
        }
      })();
    }
    if (action === 'fullscreen') {
      zoomToCamera(camera.id);
    }
  }, [API_URL, accessToken, loadData, setLocation, zoomToCamera, toast]);

  const handleCamClick = useCallback((id: string) => {
    setSelectedCam(s => s === id ? null : id);
  }, []);

  const handleCamDoubleClick = useCallback((camera: Camera) => {
    // Já ampliado (1x1) com layout salvo → duplo-clique VOLTA para a grade.
    if (gridSize === '1x1' && prevLayout) { restoreLayout(); return; }
    zoomToCamera(camera.id);
  }, [gridSize, prevLayout, restoreLayout, zoomToCamera]);

  const loadLayout = (layoutId: string) => {
    const layout = availableLayouts.find(l => l.id === layoutId);
    // Reseta o valor do Select para '' para que re-selecionar o mesmo layout
    // dispare onValueChange novamente (Radix não reemite o valor atual).
    setLayoutSelectValue('');
    if (!layout) return;
    setGridSize(layout.gridSize);
    setCameraIds(layout.cameraIds.slice(0, (() => { const d = gridDims(layout.gridSize); return d.cols * d.rows; })()));
    setSelectedSlotIndex(null);
  };

  // Trocar o tamanho da grade invalida o slot selecionado: o índice aponta
  // para outro quadro (ou para fora da grade) na geometria nova.
  useEffect(() => {
    setSelectedSlotIndex(null);
  }, [gridSize]);

  const addCameraToGrid = (camId: string) => {
    const newIds = [...cameraIds.slice(0, count)];
    while (newIds.length < count) newIds.push('');
    const previousIdx = newIds.findIndex((id) => id === camId);
    if (previousIdx >= 0) newIds[previousIdx] = '';
    // O slot selecionado pode ter ficado FORA da grade (operador selecionou o
    // quadro 15 numa 5×5 e depois trocou para 2×2): escrever nele criaria um
    // array esparso e a câmera "sumia" sem nenhum feedback — o slice(0, count)
    // do render cortava o índice fantasma.
    const slotValido = selectedSlotIndex != null && selectedSlotIndex < count ? selectedSlotIndex : null;
    const targetIdx = slotValido != null
      ? slotValido
      : newIds.findIndex(id => !id || !cameras.find(c => c.id === id));
    // GRADE CHEIA SEM QUADRO ESCOLHIDO: `targetIdx` vira -1 e o código escrevia
    // no ÚLTIMO quadro, apagando a câmera que estava lá sem aviso nem desfazer.
    // Agora o operador é avisado de quem saiu (e por quê), com como voltar.
    const indiceFinal = targetIdx >= 0 ? targetIdx : count - 1;
    const substituida = targetIdx >= 0 ? null : newIds[indiceFinal];
    newIds[indiceFinal] = camId;
    setCameraIds(newIds);
    setSelectedSlotIndex(null);
    if (substituida) {
      const anterior = cameras.find((camera) => camera.id === substituida);
      const idsAntes = [...cameraIds.slice(0, count)];
      toast({
        title: 'A grade estava cheia',
        description: `"${anterior?.name ?? 'A câmera do último quadro'}" saiu para abrir espaço. Escolha um quadro antes de clicar para decidir onde entra.`,
        action: (
          <ToastAction altText="Desfazer" onClick={() => setCameraIds(idsAntes)}>
            Desfazer
          </ToastAction>
        ),
      });
    }
  };

  const removeCameraFromSlot = (slotIndex: number) => {
    const newIds = [...cameraIds.slice(0, count)];
    while (newIds.length < count) newIds.push('');
    newIds[slotIndex] = '';
    setCameraIds(newIds);
    if (selectedSlotIndex === slotIndex) setSelectedSlotIndex(null);
  };

  const selectSlotForCamera = (slotIndex: number, camera?: Camera | null) => {
    setSelectedSlotIndex(slotIndex);
    setPanelOpen(true);
    setSelectedCam(camera?.id ?? null);
  };

  const saveCurrentLayout = () => {
    setLayoutDialog({ mode: 'save', name: `Layout ${savedLayouts.length + 1}` });
  };

  const renameLayout = (layoutId: string) => {
    const layout = savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    setLayoutDialog({ mode: 'rename', id: layoutId, name: layout.name });
  };

  const deleteLayout = (layoutId: string) => {
    const layout = savedLayouts.find((item) => item.id === layoutId);
    if (!layout) return;
    setDeleteTarget(layout);
  };

  const commitLayoutDialogRef = useRef(false);
  const commitLayoutDialog = async () => {
    if (!layoutDialog) return;
    // Reentrância: Enter duplo (ou Enter + clique em "Salvar") disparava dois
    // POSTs antes de o diálogo fechar — dois layouts idênticos no servidor.
    if (commitLayoutDialogRef.current) return;
    commitLayoutDialogRef.current = true;
    try {
    const name = layoutDialog.name.trim();
    if (!name) return;
    const headers = accessToken ? { Authorization: `Bearer ${accessToken}` } : undefined;

    if (layoutDialog.mode === 'rename' && layoutDialog.id) {
      const previousLayouts = savedLayouts;
      const nextLayouts = savedLayouts.map((item) => (item.id === layoutDialog.id ? { ...item, name } : item));
      setSavedLayouts(nextLayouts);
      persistSavedLayouts(nextLayouts);
      try {
        // Layout salvo offline (id `local-...`) não existe no servidor: o PATCH
        // respondia 404 para sempre e o rename revertia — o delete já tinha
        // esta guarda, o rename não. Localmente, renomear é só persistir.
        if (!layoutDialog.id.startsWith('local-')) {
          if (!headers) throw new Error('Sessão inválida.');
          await axios.patch(`${API_URL}/live-layouts/${layoutDialog.id}`, { name }, { headers });
        }
        toast({ title: 'Layout renomeado', description: name });
      } catch {
        setSavedLayouts(previousLayouts);
        persistSavedLayouts(previousLayouts);
        toast({ title: 'Não foi possível renomear', description: 'O layout foi restaurado.', variant: 'destructive' });
        return;
      }
    } else {
      const draft: SavedLayout = {
        id: `local-live-layout-${Date.now()}`,
        name,
        gridSize,
        cameraIds: cameraIds.slice(0, count),
        createdBy: useAuthStore.getState().user?.name ?? 'Operador',
        lastUsed: new Date().toISOString(),
      };
      while (draft.cameraIds.length < count) draft.cameraIds.push('');
      let nextLayout = draft;
      try {
        if (!headers) throw new Error('Sessão inválida.');
        const response = await axios.post<ApiLiveLayout>(`${API_URL}/live-layouts`, {
          name: draft.name,
          gridSize: draft.gridSize,
          cameraIds: draft.cameraIds,
        }, { headers });
        nextLayout = mapApiLiveLayout(response.data) ?? draft;
      } catch {
        toast({
          title: 'Layout salvo somente neste navegador',
          description: 'A sincronização com o servidor falhou.',
          variant: 'destructive',
        });
      }
      const nextLayouts = [nextLayout, ...savedLayouts];
      setSavedLayouts(nextLayouts);
      persistSavedLayouts(nextLayouts);
      toast({ title: 'Layout salvo', description: name });
    }
    setLayoutDialog(null);
    } finally {
      commitLayoutDialogRef.current = false;
    }
  };

  const confirmDeleteLayout = async () => {
    if (!deleteTarget) return;
    const previousLayouts = savedLayouts;
    const nextLayouts = savedLayouts.filter((item) => item.id !== deleteTarget.id);
    setSavedLayouts(nextLayouts);
    persistSavedLayouts(nextLayouts);
    try {
      if (accessToken && !deleteTarget.id.startsWith('local-')) {
        await axios.delete(`${API_URL}/live-layouts/${deleteTarget.id}`, {
          headers: { Authorization: `Bearer ${accessToken}` },
        });
      }
      toast({ title: 'Layout apagado', description: deleteTarget.name });
    } catch {
      setSavedLayouts(previousLayouts);
      persistSavedLayouts(previousLayouts);
      toast({ title: 'Não foi possível apagar', description: 'O layout foi restaurado.', variant: 'destructive' });
    }
    setDeleteTarget(null);
  };

  const startManualRecording = async () => {
    if (!selectedCameraObj?.id || !accessToken) return;
    setRecordingActionLoading('start');
    setRecordingOverrides((current) => ({ ...current, [selectedCameraObj.id]: true }));
    try {
      await axios.post(`${API_URL}/cameras/${selectedCameraObj.id}/recording/start`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      void loadData();
      toast({ title: 'Gravação iniciada', description: selectedCameraObj.name });
    } catch (error) {
      setRecordingOverrides((current) => ({ ...current, [selectedCameraObj.id]: selectedCameraObj.status === 'recording' }));
      toast({ title: 'Erro ao iniciar gravação', description: error instanceof Error ? error.message : 'Falha ao iniciar gravação manual.', variant: 'destructive' });
    } finally {
      setRecordingActionLoading(null);
    }
  };

  const stopManualRecording = async () => {
    if (!selectedCameraObj?.id || !accessToken) return;
    setRecordingActionLoading('stop');
    setRecordingOverrides((current) => ({ ...current, [selectedCameraObj.id]: false }));
    try {
      await axios.post(`${API_URL}/cameras/${selectedCameraObj.id}/recording/stop`, {}, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      void loadData();
      toast({ title: 'Gravação parada', description: selectedCameraObj.name });
    } catch (error) {
      setRecordingOverrides((current) => ({ ...current, [selectedCameraObj.id]: selectedCameraObj.status === 'recording' }));
      toast({ title: 'Erro ao parar gravação', description: error instanceof Error ? error.message : 'Falha ao parar gravação manual.', variant: 'destructive' });
    } finally {
      setRecordingActionLoading(null);
    }
  };

  // ── MODO MURAL SEM DERRUBAR NENHUM PLAYER ─────────────────────────────────
  //
  // O mural era um `return` separado com uma árvore JSX própria. Alternar
  // desmontava a grade INTEIRA na reconciliação: todas as sessões WHEP eram
  // encerradas e renegociadas em rajada — a piscada em massa que o projeto
  // declara como invariante proibido ("live saudável nunca pisca"), além do
  // estresse no MediaMTX de cortar e reabrir ~30 leitores de uma vez.
  //
  // Agora o mural é a MESMA árvore com classes condicionais: o caminho do nó
  // raiz até cada <CameraTile> não muda, então o React só re-estiliza — nenhum
  // player desmonta, nenhum stream cai. Toolbar e painel ficam com `hidden`
  // (montados, invisíveis) para não deslocar os irmãos na reconciliação.
  return (
    <div className={wallMode ? 'fixed inset-0 z-50 flex bg-black' : 'live-workspace relative flex h-full min-h-0'}>
      <div className="flex-1 flex flex-col min-w-0 min-h-0">
        <div className={wallMode ? 'hidden' : 'toolbar'}>
          <div className="segment">
            {GRID_PRESETS.map(({ size, icon }) => (
              <Tooltip key={size} delayDuration={0}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => setGridSize(size)}
                    className={`seg-btn ${gridSize === size ? 'active' : ''}`}
                    data-testid={`button-grid-${size}`}
                  >
                    {icon}
                    <span className="grid-label">{size}</span>
                  </button>
                </TooltipTrigger>
                <TooltipContent className="text-xs">Grade {size}</TooltipContent>
              </Tooltip>
            ))}
          </div>

          {/* Grade LIVRE: colunas × linhas (ex.: 4x6, 6x4). Aplica ao digitar. */}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <div className="live-grid-custom flex items-center gap-1 rounded-md border border-[hsl(var(--border))] bg-[hsl(var(--card))] px-1.5 py-0.5" data-testid="grid-custom">
                <input
                  type="number"
                  min={GRID_MIN}
                  max={GRID_MAX}
                  value={gridCols}
                  onChange={(e) => setGridSize(makeGridSize(Number(e.target.value), gridRows))}
                  className="w-9 bg-transparent text-center text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label="Colunas"
                />
                <span className="text-[10px] text-[hsl(var(--muted-foreground))]">×</span>
                <input
                  type="number"
                  min={GRID_MIN}
                  max={GRID_MAX}
                  value={gridRows}
                  onChange={(e) => setGridSize(makeGridSize(gridCols, Number(e.target.value)))}
                  className="w-9 bg-transparent text-center text-xs outline-none [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none"
                  aria-label="Linhas"
                />
              </div>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Grade livre: colunas × linhas (1 a {GRID_MAX})</TooltipContent>
          </Tooltip>

          {count > GRID_CELL_WARN ? (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <span className="hidden sm:inline-flex items-center gap-1 rounded-md bg-[hsl(var(--status-warning)_/_0.14)] px-2 py-1 text-[10px] font-semibold text-[hsl(var(--status-warning))]" data-testid="grid-cpu-warn">
                  ⚠ {count} câmeras
                </span>
              </TooltipTrigger>
              <TooltipContent className="text-xs max-w-56">Muitas câmeras ao vivo ao mesmo tempo podem sobrecarregar a CPU do servidor (transcode). Reduza a grade se ficar lento.</TooltipContent>
            </Tooltip>
          ) : null}

          {gridSize === '1x1' && prevLayout ? (
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <button onClick={restoreLayout} className="btn btn-secondary btn-sm" data-testid="button-restore-grid">
                  <ChevronLeft className="w-3.5 h-3.5" />
                  Voltar à grade
                </button>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Volta para a grade anterior (ou tecle Esc / dê duplo-clique)</TooltipContent>
            </Tooltip>
          ) : null}
          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button onClick={fillGrid} className="btn btn-secondary btn-sm" data-testid="button-fill-grid">
                <LayoutGrid className="w-3.5 h-3.5" />
                <span className="toolbar-label">Preencher</span>
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Preenche a grade com todas as câmeras (ajusta o tamanho)</TooltipContent>
          </Tooltip>

          <Popover>
            <Tooltip delayDuration={0}>
              <TooltipTrigger asChild>
                <PopoverTrigger asChild>
                  <button className="btn btn-secondary btn-sm" data-testid="button-layouts">
                    <FolderOpen className="w-3.5 h-3.5" />
                    <span className="toolbar-label">Layouts</span>
                    <ChevronDown className="w-3 h-3 text-[hsl(var(--muted-foreground))]" />
                  </button>
                </PopoverTrigger>
              </TooltipTrigger>
              <TooltipContent className="text-xs">Carregar e gerenciar layouts</TooltipContent>
            </Tooltip>
            <PopoverContent align="start" className="w-72 p-2">
              <div className="flex items-center justify-between px-2 py-1.5">
                <span className="text-[10px] font-mono uppercase tracking-wide text-[hsl(var(--muted-foreground))]">
                  Layouts
                </span>
                <button onClick={saveCurrentLayout} className="btn btn-secondary btn-xs">
                  <Save className="w-3 h-3" />
                  Salvar atual
                </button>
              </div>
              <Select value={layoutSelectValue} onValueChange={loadLayout}>
                <SelectTrigger className="mb-2 h-8 w-full text-xs">
                  <SelectValue placeholder="Carregar layout" />
                </SelectTrigger>
                <SelectContent>
                  {availableLayouts.map(l => (
                    <SelectItem key={l.id} value={l.id} className="text-xs">{l.name}</SelectItem>
                  ))}
                  {!availableLayouts.length && (
                    <SelectItem value="__empty__" disabled className="text-xs">Nenhum layout salvo</SelectItem>
                  )}
                </SelectContent>
              </Select>
              <div className="max-h-64 overflow-y-auto border-t border-border pt-1">
                {savedLayouts.length ? savedLayouts.map((layout) => (
                  <div key={layout.id} className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-[hsl(var(--accent))]">
                    <button className="min-w-0 flex-1 text-left" onClick={() => loadLayout(layout.id)}>
                      <span className="block truncate text-xs font-medium">{layout.name}</span>
                      <span className="block font-mono text-[9px] text-[hsl(var(--muted-foreground))]">
                        {layout.gridSize} / {layout.cameraIds.filter(Boolean).length} câmeras
                      </span>
                    </button>
                    <button onClick={() => renameLayout(layout.id)} className="h-7 w-7 rounded border border-border inline-flex items-center justify-center hover:bg-background" title="Renomear">
                      <Pencil className="w-3 h-3" />
                    </button>
                    <button onClick={() => deleteLayout(layout.id)} className="h-7 w-7 rounded border border-border inline-flex items-center justify-center hover:bg-[hsl(var(--destructive)_/_0.1)] hover:text-[hsl(var(--destructive))]" title="Apagar">
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </div>
                )) : (
                  <div className="px-2 py-3 text-xs text-[hsl(var(--muted-foreground))]">
                    Salve o layout atual para reutilizá-lo.
                  </div>
                )}
              </div>
            </PopoverContent>
          </Popover>

          <div className="live-status-summary ml-auto flex min-w-0 items-center gap-1.5">
            {selectedCameraObj ? (
              <>
                <button
                  onClick={() => void (isRecording ? stopManualRecording() : startManualRecording())}
                  disabled={recordingActionLoading !== null}
                  className={`btn btn-secondary btn-sm ${
                    isRecording
                      ? 'border-[hsl(var(--destructive)_/_0.7)] text-[hsl(var(--destructive))] bg-[hsl(var(--destructive)_/_0.1)]'
                      : 'border-[hsl(var(--status-online)_/_0.7)] text-[hsl(var(--status-online))] bg-[hsl(var(--status-online)_/_0.1)] hover:bg-[hsl(var(--status-online)_/_0.2)]'
                  }`}
                  title={isRecording ? 'Parar gravação manual' : 'Iniciar gravação manual'}
                >
                  {recordingActionLoading ? (
                    <span className="w-2 h-2 rounded-full bg-current animate-pulse" />
                  ) : isRecording ? (
                    <span className="w-2 h-2 rounded-full bg-[hsl(var(--destructive))] rec-pulse" />
                  ) : (
                    <Circle className="w-3 h-3" />
                  )}
                  {isRecording ? 'Gravando' : 'Gravar'}
                </button>
              </>
            ) : null}
            <span className="hdr-chip">
              <span className="hdr-chip-dot status-online" />
              {onlineCount}/{cameras.length} online
            </span>
            {recordingCount > 0 && (
              <span className="hdr-chip">
                <span className="hdr-chip-dot status-recording rec-pulse" />
                {recordingCount} REC
              </span>
            )}
            {alarmCount > 0 && (
              <span className="hdr-chip">
                <span className="hdr-chip-dot status-alarm alarm-glow" />
                {alarmCount} ALM
              </span>
            )}
          </div>

          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                onClick={toggleWallMode}
                className="btn btn-secondary btn-sm btn-icon"
                data-testid="button-wall-mode"
              >
                <Maximize2 className="w-3.5 h-3.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">Abrir modo mural</TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={0}>
            <TooltipTrigger asChild>
              <button
                onClick={() => setPanelOpen(o => !o)}
                className="btn btn-secondary btn-sm btn-icon"
              >
                {panelOpen ? <PanelRightClose className="w-3.5 h-3.5" /> : <PanelRightOpen className="w-3.5 h-3.5" />}
              </button>
            </TooltipTrigger>
            <TooltipContent className="text-xs">{panelOpen ? 'Ocultar painel de câmeras' : 'Mostrar painel de câmeras'}</TooltipContent>
          </Tooltip>
        </div>

        <div
          className={wallMode ? 'flex-1 grid gap-0.5 bg-black p-0.5 min-h-0' : 'cam-grid-bg flex-1 p-1 grid gap-1 min-h-0'}
          style={{ gridTemplateColumns: `repeat(${gridCols}, 1fr)`, gridTemplateRows: `repeat(${gridRows}, 1fr)` }}
        >
          {displayedCams.map((cam, i) => (
            <div
              // Key por id de câmera: mover uma câmera de quadro MOVE o nó no DOM
              // (stream preservado) em vez de desmontar/remontar o player.
              key={cam ? `cam-${cam.id}` : `empty-${i}`}
              className={`group relative min-h-0 rounded-md ${!wallMode && selectedSlotIndex === i ? 'ring-2 ring-[hsl(var(--primary))]' : ''}`}
              style={{ minHeight: 80 }}
            >
              {cam ? (
                <>
                  <CameraTile
                    camera={{
                      ...cam,
                      status: isCameraRecording(cam)
                        ? 'recording'
                        : (cam.status === 'recording' ? 'online' : cam.status),
                    }}
                    selected={selectedCam === cam.id}
                    showDetectionOverlay={!wallMode || selectedCam === cam.id}
                    // Full HD só quando há exatamente 1 câmera na tela.
                    // Em grade 2x2 ou maior, até a câmera selecionada permanece
                    // no perfil reduzido para preservar CPU/banda.
                    liveViewMode={count === 1 ? 'selected' : 'grid'}
                    onClick={() => {
                      handleCamClick(cam.id);
                      setSelectedSlotIndex(i);
                    }}
                    onDoubleClick={() => handleCamDoubleClick(cam)}
                    onAction={handleCamAction}
                    streamStartDelayMs={streamStartDelay(i, count)}
                  />
                  <div // Aparecem também quando o quadro está SELECIONADO: em tela sensível
                    // ao toque não existe hover, e "Trocar"/"Remover" ficavam
                    // inalcançáveis — montar a grade era impossível no hardware
                    // típico de sala de operação.
                    className={wallMode
                      ? 'hidden'
                      : `absolute top-9 right-1.5 z-40 flex items-center gap-1.5 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100 group-focus-within:pointer-events-auto group-focus-within:opacity-100 ${
                          selectedCam === cam.id ? 'pointer-events-auto opacity-100' : 'pointer-events-none opacity-0'
                        }`}>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        selectSlotForCamera(i, cam);
                      }}
                      className="h-7 rounded-md border border-white/15 bg-black/70 px-2 text-[10px] font-mono text-white backdrop-blur hover:bg-black"
                      title="Trocar câmera deste quadrado"
                    >
                      Trocar
                    </button>
                    <button
                      onClick={(event) => {
                        event.stopPropagation();
                        removeCameraFromSlot(i);
                      }}
                      className="h-7 w-7 rounded-md border border-white/15 bg-black/70 text-white backdrop-blur hover:bg-[hsl(var(--destructive)_/_0.8)]"
                      title="Remover câmera deste quadrado"
                    >
                      <X className="w-3.5 h-3.5 mx-auto" />
                    </button>
                  </div>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => selectSlotForCamera(i)}
                  className="cam-empty"
                  style={{ minHeight: 80 }}
                  aria-label={`Escolher câmera para o quadro ${i + 1}`}
                >
                  <Video className="w-4 h-4" />
                  <span style={{ fontFamily: 'var(--ff-mono)', fontSize: 10 }}>
                    {selectedSlotIndex === i ? 'Escolha uma câmera' : 'Slot vazio'}
                  </span>
                </button>
              )}
            </div>
          ))}
        </div>
      </div>

      <AnimatePresence>
        {panelOpen && !wallMode && (
          <motion.aside
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: 224, opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 300, damping: 32 }}
            className="border-l border-border bg-card flex flex-col overflow-hidden shrink-0"
          >
            <div className="px-2 py-2.5 border-b border-border shrink-0 space-y-2.5">
              <div className="flex items-center justify-between">
                <div>
                  <h2 className="text-[12px] font-semibold">Câmeras</h2>
                  <p className="text-[10px] text-[hsl(var(--muted-foreground))] mt-0.5">
                    {selectedSlotIndex != null ? `Quadro ${selectedSlotIndex + 1}` : 'Abrir na grade'}
                  </p>
                </div>
                <ShieldCheck className="w-4 h-4 text-[hsl(var(--status-online))]" />
              </div>

              <div className="input-wrap">
                <span className="input-icon"><Search className="w-3 h-3" /></span>
                <input
                  className="input"
                  style={{ height: 30, fontSize: 11 }}
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Buscar câmera..."
                />
              </div>

              <div className="grid grid-cols-2 gap-1.5">
                <Select value={zoneFilter} onValueChange={setZoneFilter}>
                  <SelectTrigger className="h-8 min-w-0 px-2 text-[10px]">
                    <Filter className="mr-1.5 h-3 w-3 shrink-0 text-[hsl(var(--muted-foreground))]" />
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {zoneFilters.map(z => <SelectItem key={z} value={z} className="text-xs">{z === '__all__' ? 'Todas as zonas' : z}</SelectItem>)}
                  </SelectContent>
                </Select>
                <Select value={statusFilter} onValueChange={(value) => setStatusFilter(value as StatusFilter)}>
                  <SelectTrigger className="h-8 min-w-0 px-2 text-[10px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STATUS_FILTERS.map((status) => (
                      <SelectItem key={status} value={status} className="text-xs">
                        {STATUS_FILTER_LABEL[status]}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto divide-y divide-border/80">
              {filteredList.map(cam => {
                const isInGrid = cameraIds.includes(cam.id);
                const statusClass =
                  cam.status === 'alarm' ? 'status-alarm rec-pulse' :
                  cam.status === 'motion' ? 'status-motion' :
                  cam.isOnline ? 'status-online' : 'status-offline';
                return (
                  <button
                    key={cam.id}
                    className={`w-full text-left grid grid-cols-[10px_1fr_auto] items-center gap-2 px-2 py-2 hover:bg-[hsl(var(--accent)_/_0.7)] transition-colors ${
                      isInGrid ? 'bg-[hsl(var(--primary)_/_0.06)]' : ''
                    }`}
                    onClick={() => addCameraToGrid(cam.id)}
                  >
                    <span className={`w-2 h-2 rounded-full ${statusClass}`} />
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium truncate">{cam.name}</span>
                      <span className="block text-[9px] text-[hsl(var(--muted-foreground))] truncate">
                        {cam.code !== cam.name ? cam.code : `${cam.zone} · ${cam.ipAddress}`}
                      </span>
                    </span>
                    <span className={`max-w-[42px] truncate text-[9px] shrink-0 ${isInGrid ? 'text-[hsl(var(--primary))]' : 'text-[hsl(var(--muted-foreground)_/_0.55)]'}`}>
                      {selectedSlotIndex != null ? 'Usar' : isInGrid ? 'Grade' : STATUS_FILTER_LABEL[cam.status as (typeof STATUS_FILTERS)[number]] ?? cam.status.replace('_', ' ')}
                    </span>
                  </button>
                );
              })}
            </div>

            <div className="px-2.5 py-2 border-t border-border shrink-0 flex items-center justify-between">
              <span className="text-[10px] text-[hsl(var(--muted-foreground))]">{filteredList.length} câmeras</span>
              <button
                onClick={() => setPanelOpen(false)}
                className="flex items-center gap-1 text-[10px] text-[hsl(var(--muted-foreground))] hover:text-foreground transition-colors"
              >
                Recolher <ChevronRight className="w-3 h-3" />
              </button>
            </div>
          </motion.aside>
        )}
      </AnimatePresence>

      {!panelOpen && (
        <button
          onClick={() => setPanelOpen(true)}
          className="btn btn-secondary btn-sm btn-icon absolute right-3 top-[104px] z-10"
          aria-label="Mostrar painel de câmeras"
          title="Mostrar painel de câmeras"
        >
          <ChevronLeft className="w-3.5 h-3.5" />
        </button>
      )}

      <Dialog open={layoutDialog !== null} onOpenChange={(open) => { if (!open) setLayoutDialog(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{layoutDialog?.mode === 'rename' ? 'Renomear layout' : 'Salvar layout'}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={layoutDialog?.name ?? ''}
            onChange={(e) => setLayoutDialog((current) => (current ? { ...current, name: e.target.value } : current))}
            onKeyDown={(e) => { if (e.key === 'Enter') commitLayoutDialog(); }}
            placeholder="Nome do layout"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setLayoutDialog(null)}>Cancelar</Button>
            <Button onClick={commitLayoutDialog} disabled={!layoutDialog?.name.trim()}>
              {layoutDialog?.mode === 'rename' ? 'Renomear' : 'Salvar'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={deleteTarget !== null} onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Apagar layout</AlertDialogTitle>
            <AlertDialogDescription>
              Apagar o layout "{deleteTarget?.name}"? Esta ação não pode ser desfeita.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancelar</AlertDialogCancel>
            <AlertDialogAction onClick={confirmDeleteLayout}>Apagar</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {wallMode && (
        <>
          {/* Somem após 3s sem interação e voltam ao primeiro movimento. O mural
              fica horas numa TV, e dois selos fixos por cima do vídeo são ruído
              permanente — em painel OLED, imagem parada sobre imagem parada é
              retenção de tela. Esconder não prende ninguém: Esc já sai do mural.
              `pointer-events-none` enquanto invisível para o botão não ser
              clicado às cegas. */}
          <div
            {...muralControles.propsDoControle}
            className={`absolute top-3 left-3 z-50 flex items-center gap-2 rounded-md border border-white/10 bg-black/72 px-3 py-1.5 text-xs font-medium text-white transition-opacity duration-300 motion-reduce:transition-none ${
              muralControles.visivel ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <Video className="w-3.5 h-3.5 text-[hsl(var(--status-online))]" />
            Ao Vivo / Modo Mural
          </div>
          <button
            onClick={toggleWallMode}
            {...muralControles.propsDoControle}
            className={`ops-button fixed top-3 right-3 z-50 flex items-center gap-1.5 border-white/10 bg-black/72 px-3 text-xs text-white transition-opacity duration-300 motion-reduce:transition-none ${
              muralControles.visivel ? 'opacity-100' : 'opacity-0 pointer-events-none'
            }`}
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Sair do Modo Mural
          </button>
        </>
      )}
    </div>
  );
}
