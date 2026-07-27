import { IsInt, IsOptional, IsString, Min } from 'class-validator';

/**
 * Corpo (todo opcional) da confirmação visual de uma câmera JÁ SALVA.
 *
 * A tela de edição manda só o que o técnico mexeu. Campo ausente usa o valor
 * guardado — inclusive a SENHA, porque o formulário de edição deixa o campo em
 * branco quando ela não muda. É isso que permite conferir a imagem depois de
 * trocar apenas o IP, ANTES de salvar por cima do cadastro que estava certo.
 */
export class CameraPreviewFrameDto {
  @IsOptional()
  @IsString()
  ip?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  rtspPort?: number;

  @IsOptional()
  @IsString()
  username?: string;

  @IsOptional()
  @IsString()
  password?: string;

  @IsOptional()
  @IsString()
  rtspPath?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  channel?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  subtype?: number;
}
