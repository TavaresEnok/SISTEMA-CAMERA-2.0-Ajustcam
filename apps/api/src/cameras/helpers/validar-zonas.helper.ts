import { BadRequestException } from '@nestjs/common';

/**
 * Validação das zonas por TIPO — o que o DTO sozinho não consegue exigir.
 *
 * O DTO valida a lista inteira com uma regra só (2 a 40 pontos), porque
 * `class-validator` não sabe olhar o `kind` do mesmo objeto. Mas as duas formas
 * têm exigências opostas:
 *
 *   · polígono precisa de 3+ pontos — com 2 seria uma área de espessura zero:
 *     nada cai dentro, a zona nunca dispara, e o operador vê "zona salva" sobre
 *     algo que não faz nada;
 *   · linha precisa de EXATAMENTE 2 — com 3 não dá para dizer qual trecho é a
 *     travessia, e o sentido (a seta) perde significado.
 *
 * Recusar aqui, com mensagem clara, é melhor que aceitar e falhar em silêncio
 * na hora em que alguém pular o muro.
 */
export function validarZonasDeDeteccao(zonas: unknown): void {
  if (zonas === undefined || zonas === null) return;
  if (!Array.isArray(zonas)) {
    throw new BadRequestException('Zonas de detecção devem ser uma lista.');
  }

  for (const zona of zonas as any[]) {
    const nome = String(zona?.name ?? zona?.id ?? 'sem nome');
    const pontos = Array.isArray(zona?.points) ? zona.points : [];

    if (zona?.kind === 'line') {
      if (pontos.length !== 2) {
        throw new BadRequestException(
          `A linha "${nome}" precisa de exatamente 2 pontos (início e fim); recebeu ${pontos.length}.`,
        );
      }
      const [a, b] = pontos;
      const iguais = Number(a?.[0]) === Number(b?.[0]) && Number(a?.[1]) === Number(b?.[1]);
      if (iguais) {
        throw new BadRequestException(`A linha "${nome}" tem os dois pontos no mesmo lugar — não há travessia possível.`);
      }
    } else if (pontos.length < 3) {
      throw new BadRequestException(
        `A área "${nome}" precisa de pelo menos 3 pontos; com ${pontos.length} ela não tem interior e nunca dispararia.`,
      );
    }

    // Coordenadas normalizadas: fora de 0..1 significa que alguém enviou
    // pixels. A zona "funcionaria" no banco e não casaria com quadro nenhum.
    for (const par of pontos) {
      const x = Number(par?.[0]);
      const y = Number(par?.[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1) {
        throw new BadRequestException(
          `"${nome}" tem ponto fora do quadro (${par?.[0]}, ${par?.[1]}). As coordenadas são normalizadas de 0 a 1.`,
        );
      }
    }
  }
}
