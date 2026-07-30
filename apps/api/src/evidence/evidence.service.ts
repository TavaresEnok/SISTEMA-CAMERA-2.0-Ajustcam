import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, createHmac, timingSafeEqual } from 'crypto';

@Injectable()
export class EvidenceService {
  private readonly hmacSecret: string;
  private readonly hmacKeyId: string;

  constructor(private readonly configService: ConfigService) {
    this.hmacSecret = this.configService.get<string>('evidenceHmacSecret') ?? '';
    this.hmacKeyId = this.configService.get<string>('evidenceHmacKeyId') ?? 'local-v1';
  }

  signPackage(payload: Record<string, unknown>) {
    this.assertSecretConfigured();

    const payloadCanonical = this.stableStringify(payload);
    if (payloadCanonical.length > 10_000_000) {
      throw new ServiceUnavailableException('Payload de evidência excede o tamanho permitido para assinatura.');
    }

    const packageHashValue = this.sha256Hex(payloadCanonical);
    const signatureValue = this.hmacSha256Hex(packageHashValue);

    return {
      packageHash: {
        algorithm: 'SHA-256',
        value: packageHashValue,
      },
      signature: {
        algorithm: 'HMAC-SHA-256',
        value: signatureValue,
        keyId: this.hmacKeyId,
      },
      signedAt: new Date().toISOString(),
    };
  }

  verifyPackage(evidencePackage: Record<string, unknown>) {
    this.assertSecretConfigured();

    const packageHashEntry = this.extractObject(evidencePackage.packageHash);
    const signatureEntry = this.extractObject(evidencePackage.signature);

    const payloadBase = this.omitInternalFields(evidencePackage);
    const canonical = this.stableStringify(payloadBase);
    const computedHash = this.sha256Hex(canonical);
    const computedSignature = this.hmacSha256Hex(computedHash);

    const providedHash = typeof packageHashEntry?.value === 'string' ? packageHashEntry.value : null;
    const providedSignature = typeof signatureEntry?.value === 'string' ? signatureEntry.value : null;

    const hashValid = this.safeCompareHex(providedHash, computedHash);
    const signatureValid = this.safeCompareHex(providedSignature, computedSignature);

    return {
      ok: hashValid && signatureValid,
      hashValid,
      signatureValid,
      details: [
        hashValid ? 'Hash SHA-256 válido.' : 'Hash SHA-256 inválido.',
        signatureValid ? 'Assinatura HMAC válida.' : 'Assinatura HMAC inválida ou ausente.',
      ],
      // ORÁCULO DE ASSINATURA — removido de propósito.
      //
      // Este endpoint devolvia `expected.signature` com o HMAC CALCULADO para o
      // conteúdo enviado. Qualquer usuário com acesso à verificação podia então
      // forjar prova em dois passos: manda o pacote adulterado, lê a assinatura
      // que o servidor diz esperar, cola no pacote e reenvia — a segunda
      // verificação passa. Isso anula por completo o propósito do módulo, que é
      // provar que a gravação NÃO foi alterada.
      //
      // A verificação continua respondendo o que o usuário legítimo precisa
      // saber (é válido? o hash bate? a assinatura bate?) e o que ele mesmo
      // enviou — nunca o segredo derivado da chave HMAC.
      expected: {
        packageHash: { algorithm: 'SHA-256' },
        signature: { algorithm: 'HMAC-SHA-256', keyId: this.hmacKeyId },
      },
      provided: {
        packageHash: providedHash,
        signature: providedSignature,
      },
      verifiedAt: new Date().toISOString(),
    };
  }

  private omitInternalFields(value: Record<string, unknown>) {
    const { packageHash: _packageHash, signature: _signature, signedAt: _signedAt, ...base } = value;
    return base;
  }

  private assertSecretConfigured() {
    if (!this.hmacSecret || this.hmacSecret.length < 16) {
      throw new ServiceUnavailableException('EVIDENCE_HMAC_SECRET não configurado ou inválido.');
    }
  }

  private sha256Hex(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }

  private hmacSha256Hex(value: string) {
    return createHmac('sha256', this.hmacSecret).update(value).digest('hex');
  }

  private safeCompareHex(provided: string | null, computed: string) {
    if (!provided) return false;
    if (!/^[0-9a-f]+$/i.test(provided) || !/^[0-9a-f]+$/i.test(computed)) return false;

    const providedBuffer = Buffer.from(provided, 'hex');
    const computedBuffer = Buffer.from(computed, 'hex');
    if (providedBuffer.length !== computedBuffer.length) return false;

    return timingSafeEqual(providedBuffer, computedBuffer);
  }

  private stableStringify(value: unknown): string {
    return JSON.stringify(this.normalizeForStableJson(value));
  }

  private normalizeForStableJson(value: unknown): unknown {
    if (Array.isArray(value)) {
      return value.map((item) => this.normalizeForStableJson(item));
    }

    if (value && typeof value === 'object') {
      const entries = Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, this.normalizeForStableJson(item)] as const);
      return Object.fromEntries(entries);
    }

    return value;
  }

  private extractObject(value: unknown) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    return value as Record<string, unknown>;
  }
}
