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
  @IsIn(['include', 'exclude'])
  kind!: 'include' | 'exclude';

  /** Vértices [x, y] normalizados (0..1). Mínimo 3 (triângulo). */
  @IsArray()
  @ArrayMinSize(3)
  @ArrayMaxSize(40)
  points!: number[][];

  @IsOptional()
  @IsString()
  @MaxLength(16)
  color?: string;
}
