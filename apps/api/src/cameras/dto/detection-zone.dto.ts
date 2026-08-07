import { ArrayMaxSize, ArrayMinSize, IsArray, IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Zona de detecção de movimento de uma câmera.
 *
 * Os pontos são NORMALIZADOS (0..1) para não dependerem da resolução do stream
 * de análise — a mesma zona vale se a câmera trocar de 640×360 para 1080p.
 *
 * - `exclude`: movimento dentro do polígono é IGNORADO (árvore, rua pública, céu).
 * - `include`: havendo ao menos uma, só conta movimento DENTRO delas.
 * Nenhuma zona = câmera inteira monitorada.
 */
export class DetectionZoneDto {
  @IsString()
  @MaxLength(64)
  id!: string;

  @IsString()
  @MaxLength(64)
  name!: string;

  @IsString()
  @IsIn(['include', 'exclude', 'line'])
  kind!: 'include' | 'exclude' | 'line';

  /**
   * Vértices [x, y] normalizados (0..1).
   *
   * Polígono: mínimo 3 (triângulo). LINHA: exatamente 2 — por isso o mínimo
   * aqui caiu para 2, e a validação de "linha tem 2 pontos, polígono tem 3+"
   * é feita no serviço, onde o `kind` é conhecido. Aceitar 2 pontos num
   * polígono seria uma área de espessura zero: nada dentro, nunca dispara.
   */
  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(40)
  points!: number[][];

  /**
   * Só para `kind: 'line'` — o sentido PROIBIDO da travessia.
   * `ab`/`ba` referem-se a caminhar sobre a linha do primeiro ponto ao
   * segundo; a seta na tela mostra qual é qual. `ambos` = qualquer travessia.
   */
  @IsOptional()
  @IsString()
  @IsIn(['ambos', 'ab', 'ba'])
  sentido?: 'ambos' | 'ab' | 'ba';

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;
}
