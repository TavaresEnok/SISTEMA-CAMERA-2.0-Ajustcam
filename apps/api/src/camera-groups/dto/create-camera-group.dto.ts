import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class CreateCameraGroupDto {
  @IsString()
  name!: string;

  @IsOptional()
  @IsString()
  description?: string;

  /// Cota de câmeras privadas do grupo (o "acordado" com o cliente). 0 = nenhuma.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxPrivateCameras?: number;
}
