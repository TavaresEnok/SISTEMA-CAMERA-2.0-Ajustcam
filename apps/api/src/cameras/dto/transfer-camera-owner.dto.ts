import { IsString, MaxLength, MinLength } from 'class-validator';

export class TransferCameraOwnerDto {
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  ownerUserId!: string;
}
