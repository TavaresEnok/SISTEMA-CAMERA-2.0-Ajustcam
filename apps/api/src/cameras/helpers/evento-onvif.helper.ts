/**
 * CLASSIFICADOR DE EVENTO ONVIF — o que a câmera está dizendo?
 *
 * Até 07/08/2026 o serviço tinha UMA pergunta: "isto casa com /motion/?" — e o
 * que não casasse era descartado em silêncio. Sondando a frota, descobrimos o
 * que estava sendo jogado fora:
 *
 *   Cam-04/05/06 declaram `ruleEngine/lineDetector/crossed` (cruzamento de
 *   linha, COM direção) e `ruleEngine/fieldDetector/objectsInside` (intrusão).
 *   Outras declaram `userAlarm/IVA/humanShapeDetect` — a câmera distinguindo
 *   PESSOA de galho balançando, no próprio chip.
 *
 * Ou seja: a câmera gritava "alguém cruzou a linha" e o sistema desligava na
 * cara dela. Este helper transforma a pergunta única numa classificação, e é
 * função pura porque a alternativa — testar isso com câmera de verdade — não
 * cabe numa suíte.
 */

export type TipoDeEventoOnvif =
  | 'movimento'
  | 'linha-cruzada'
  | 'intrusao'
  | 'forma-humana'
  | 'sabotagem'
  | 'fim-de-movimento'
  | 'ignorado';

export type EventoOnvifClassificado = {
  tipo: TipoDeEventoOnvif;
  /** Tópico bruto, para diagnóstico e para o log. */
  topico: string | null;
  /** Direção informada pela câmera no cruzamento de linha, quando houver. */
  direcao: string | null;
  /** Nome da regra configurada na câmera (ex.: "Portão", "Linha 1"). */
  regra: string | null;
};

/**
 * A ORDEM IMPORTA: o específico vence o genérico.
 *
 * Muita câmera publica o cruzamento de linha num tópico que TAMBÉM contém a
 * palavra "motion" (`ruleEngine/...`), e vários modelos mandam o nome da regra
 * junto. Testando movimento primeiro, todo evento de perímetro viraria
 * "movimento" — exatamente o achatamento que este helper existe para desfazer.
 */
const PADROES: Array<{ tipo: TipoDeEventoOnvif; re: RegExp }> = [
  { tipo: 'linha-cruzada', re: /linedetector|linecross|crossline|tripwire|crossed/i },
  { tipo: 'intrusao', re: /fielddetector|objectsinside|intrusion|intrus|perimeter/i },
  { tipo: 'forma-humana', re: /humanshape|humandetect|persondetect|iva\/human|peopledetect/i },
  { tipo: 'sabotagem', re: /tamper/i },
  { tipo: 'movimento', re: /motion|cellmotion|motionalarm|videomotion|motiondetect/i },
];

/**
 * Estado que significa FIM do evento — não deve disparar gravação.
 *
 * Cobre as DUAS formas em que isso chega: a crua (`State=false`, herdada do
 * filtro original que já funciona em produção há meses) e a serializada em
 * JSON (`"State": "false"`), que é como a biblioteca entrega em vários
 * modelos. Manter só uma delas deixava metade da frota gravando no fim do
 * movimento em vez de no começo.
 */
const FIM_RE = /action=Stop|IsMotion=false|State=false|"(?:State|IsMotion|Value)"\s*:\s*"?false/i;

/** Extrai o primeiro grupo de uma varredura, ou null. */
function primeiro(texto: string, re: RegExp): string | null {
  const m = texto.match(re);
  return m?.[1]?.trim() || null;
}

/**
 * Classifica a mensagem crua da biblioteca onvif.
 *
 * Recebe o objeto inteiro (não só o tópico) porque fabricante nenhum concorda
 * onde colocar as coisas: uns põem a direção em `SimpleItem`, outros no nome da
 * regra, outros no próprio tópico. Varrer o texto todo é mais robusto que
 * apostar num caminho de campo — e o custo é irrelevante contra a rede.
 */
export function classificarEventoOnvif(mensagem: unknown): EventoOnvifClassificado {
  let texto: string;
  try {
    texto = JSON.stringify(mensagem ?? {});
  } catch {
    return { tipo: 'ignorado', topico: null, direcao: null, regra: null };
  }

  const topico = primeiro(texto, /"(?:_|topic|Topic)"\s*:\s*"([^"]+)"/)
    ?? primeiro(texto, /(tns1:[A-Za-z/]+)/)
    ?? null;

  for (const { tipo, re } of PADROES) {
    if (!re.test(texto)) continue;
    // Fim de evento só faz sentido para o que TEM duração (movimento,
    // intrusão). Cruzamento de linha é instantâneo por natureza: um "false"
    // ali é o estado voltando ao normal, não uma travessia.
    if (tipo !== 'linha-cruzada' && FIM_RE.test(texto)) {
      return { tipo: 'fim-de-movimento', topico, direcao: null, regra: null };
    }
    return {
      tipo,
      topico,
      direcao: tipo === 'linha-cruzada'
        ? primeiro(texto, /"(?:Direction|direction)"\s*:\s*"?([A-Za-z]+)"?/)
          ?? primeiro(texto, /Name"\s*:\s*"Direction"[^}]*Value"\s*:\s*"?([A-Za-z]+)"?/)
        : null,
      regra: primeiro(texto, /"(?:Rule|RuleName|rule)"\s*:\s*"([^"]+)"/)
        ?? primeiro(texto, /Name"\s*:\s*"(?:Rule|RuleName)"[^}]*Value"\s*:\s*"([^"]+)"/),
    };
  }

  return { tipo: 'ignorado', topico, direcao: null, regra: null };
}

/** Tipos que representam PERÍMETRO — a novidade que a frota já sabia emitir. */
export const TIPOS_DE_PERIMETRO: readonly TipoDeEventoOnvif[] = ['linha-cruzada', 'intrusao'] as const;

/** O evento deve armar a gravação? */
export function deveGravar(tipo: TipoDeEventoOnvif): boolean {
  return tipo === 'movimento' || tipo === 'linha-cruzada' || tipo === 'intrusao' || tipo === 'forma-humana';
}

/** Tipo de `CameraEvent` correspondente, para o histórico e a Revisão. */
export function tipoDeEventoDoSistema(tipo: TipoDeEventoOnvif): string | null {
  switch (tipo) {
    case 'movimento': return 'MOTION_DETECTED';
    case 'linha-cruzada': return 'LINE_CROSSED';
    case 'intrusao': return 'INTRUSION_DETECTED';
    case 'forma-humana': return 'HUMAN_DETECTED';
    case 'sabotagem': return 'CAMERA_TAMPER';
    default: return null;
  }
}
