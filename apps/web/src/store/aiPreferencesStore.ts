import axios from 'axios';
import { create } from 'zustand';
import { getApiBaseUrl } from '../lib/api-base';
import { useAuthStore } from './authStore';

/**
 * Preferências de EXIBIÇÃO da IA, compartilhadas por toda a tela.
 *
 * Store e não prop porque o player é renderizado uma vez POR CÂMERA: num mural
 * de 17 tiles, ler a preferência dentro do componente viraria 17 requisições
 * idênticas a cada montagem. Aqui é uma só, e todos os tiles leem do mesmo
 * lugar.
 *
 * O padrão é MOSTRAR: quem nunca abriu a tela de IA continua vendo a marcação
 * exatamente como antes desta configuração existir.
 */
type AiPreferencesState = {
  showObjectBox: boolean;
  carregado: boolean;
  carregar: () => Promise<void>;
  definirCaixa: (valor: boolean) => void;
};

export const useAiPreferencesStore = create<AiPreferencesState>((set, get) => ({
  showObjectBox: true,
  carregado: false,

  carregar: async () => {
    if (get().carregado) return;
    const token = useAuthStore.getState().accessToken;
    if (!token) return;
    try {
      const { data } = await axios.get<{ showObjectBox?: boolean }>(`${getApiBaseUrl()}/ai/settings`, {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 10_000,
      });
      // Ausente = instalação com API antiga: mantém o comportamento de mostrar.
      set({ showObjectBox: data?.showObjectBox !== false, carregado: true });
    } catch {
      // Falha de rede não pode ESCONDER a marcação: o operador acharia que a
      // detecção parou de funcionar. Marca como carregado para não repetir a
      // tentativa a cada tile do mural.
      set({ carregado: true });
    }
  },

  /** Atualização otimista vinda da tela de IA, sem esperar o próximo ciclo. */
  definirCaixa: (valor: boolean) => set({ showObjectBox: valor }),
}));
