import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

export class UpdateCameraGroupDto {
  @IsOptional()
  @IsString()
  name?: string;

  @IsOptional()
  @IsString()
  description?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /// Bloqueio COMERCIAL do grupo — como o dono da instalação corta um cliente
  /// final em atraso. ACTIVE = normal; RESTRICTED = vê o ao vivo mas perde o
  /// histórico; SUSPENDED = não vê nada. Whitelist explícita: valor fora da
  /// lista é rejeitado em vez de virar um estado desconhecido no banco.
  @IsOptional()
  @IsIn(['ACTIVE', 'RESTRICTED', 'SUSPENDED'])
  accessStatus?: 'ACTIVE' | 'RESTRICTED' | 'SUSPENDED';

  /// Motivo mostrado ao cliente final quando o grupo está restrito/suspenso.
  @IsOptional()
  @IsString()
  @MaxLength(300)
  accessMessage?: string;

  /// Cota de câmeras privadas do grupo (o "acordado" com o cliente). 0 = nenhuma.
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  maxPrivateCameras?: number;
}
