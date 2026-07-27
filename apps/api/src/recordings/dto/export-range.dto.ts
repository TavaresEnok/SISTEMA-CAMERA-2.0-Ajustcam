import { IsIn, IsISO8601, IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Exportação por INTERVALO — o pedido é (câmera, from, to), não (gravação,
 * offsets). Um evento de 3 minutos que cruza a borda do segmento não cabe em
 * um arquivo só, e a borda é acidente do gravador, não do fato.
 */
export class ExportRangeDto {
  @IsISO8601()
  from!: string;

  @IsISO8601()
  to!: string;

  /**
   * `auto` (padrão) = stream-copy quando os codecs permitem, transcode só quando
   * obrigatório. `compatible` = sempre H.264, para quem vai abrir o arquivo num
   * navegador/celular sem decodificador HEVC.
   */
  @IsOptional()
  @IsIn(['auto', 'compatible'])
  profile?: 'auto' | 'compatible';

  @IsOptional()
  @IsString()
  investigationId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(240)
  label?: string;

  /** Motivo da exportação — obrigatório (mesma regra do clipe por gravação). */
  @IsOptional()
  @IsString()
  @MaxLength(4000)
  notes?: string;
}
