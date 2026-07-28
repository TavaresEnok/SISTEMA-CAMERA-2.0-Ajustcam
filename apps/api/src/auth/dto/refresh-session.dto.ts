import { IsOptional, IsString, MinLength } from 'class-validator';

export class RefreshSessionDto {
  @IsOptional()
  @IsString()
  @MinLength(32)
  refreshToken?: string;
}
