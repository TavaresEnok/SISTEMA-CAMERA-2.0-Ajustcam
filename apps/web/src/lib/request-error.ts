import axios from 'axios';

// ── A MENSAGEM DO SERVIDOR É A ÚTIL ─────────────────────────────────────────
//
// `error.message` do axios é literalmente "Request failed with status code 400"
// — em inglês, sem dizer o que está errado — e descarta o `message` do backend,
// que é justamente onde está a explicação (inclusive o array do class-validator
// com o campo que falhou).
//
// Este helper vivia duplicado dentro do CamerasPage enquanto o CameraDetailPage
// mostrava o texto cru em ONZE `catch` diferentes. Extraído para ser um só.
export function getRequestErrorMessage(error: unknown, fallback: string) {
  if (axios.isAxiosError(error)) {
    const message = error.response?.data?.message;
    if (Array.isArray(message)) return message.join('\n');
    if (typeof message === 'string' && message.trim()) return message;
    if (typeof error.response?.data?.error === 'string') return error.response.data.error;
    // Sem resposta = a requisição nem chegou: dizer isso vale mais que repetir
    // o texto genérico do axios.
    if (!error.response) return 'Não foi possível falar com o servidor. Verifique a conexão.';
    return fallback;
  }
  return error instanceof Error ? error.message : fallback;
}
