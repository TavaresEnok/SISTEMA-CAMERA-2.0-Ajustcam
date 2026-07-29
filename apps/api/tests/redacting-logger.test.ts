import test from 'node:test';
import assert from 'node:assert/strict';
import { __scrubForTest as scrub } from '../src/common/logging/redacting-logger';
import { redactSensitiveText, sanitizeSensitiveText } from '../src/common/security/sensitive-text.helper';

// ─────────────────────────────────────────────────────────────────────────────
// A SENHA DA CÂMERA NÃO PODE SAIR NO LOG — NEM QUANDO O PONTO DE CHAMADA ESQUECE.
//
// A defesa anterior era chamar `sanitizeSensitiveText()` em cada log (50+ pontos
// de chamada). O stderr do FFmpeg traz a URL RTSP inteira, então UM ponto novo
// esquecido já vaza a senha do cliente para `docker logs`. O Frigate resolve no
// logger (`frigate/log.py` + `util/builtin.py:clean_camera_user_pass`), onde não
// há como escapar; aqui a mesma ideia vive em `RedactingLogger`.
//
// O que estes testes travam:
//   1. string com credencial é redigida (o caso do stderr do FFmpeg);
//   2. Error tem mensagem E STACK redigidos, e o stack NÃO é descartado — jogar
//      fora o stack para esconder a senha trocaria um problema por outro;
//   3. o Error original NÃO é mutado (quem tratar o erro depois do log continua
//      vendo o objeto que recebeu);
//   4. redigir duas vezes é inofensivo (logger + call site coexistem);
//   5. valor que não é string/Error passa intacto (não serializamos objeto só
//      para logar — isso mudaria a formatação de toda a saída).
// ─────────────────────────────────────────────────────────────────────────────

const SEGREDO = 'rtsp://admin:s3nh4-d0-cl13nt3@192.168.0.50:554/cam/realmonitor';

test('string com credencial embutida é redigida', () => {
  const saida = scrub(`Connection to ${SEGREDO} failed`) as string;
  assert.ok(!saida.includes('s3nh4-d0-cl13nt3'), 'a senha não pode sobreviver');
  assert.ok(saida.includes('<redacted>@'), 'a marca de redação deve aparecer');
  assert.ok(saida.includes('192.168.0.50'), 'o host continua visível — é diagnóstico');
});

test('Error: mensagem e stack redigidos, stack preservado', () => {
  const erro = new Error(`ffmpeg falhou em ${SEGREDO}`);
  const saida = scrub(erro) as Error;
  assert.ok(saida instanceof Error);
  assert.ok(!saida.message.includes('s3nh4-d0-cl13nt3'));
  assert.ok(saida.stack, 'o stack não pode ser descartado');
  assert.ok(!saida.stack!.includes('s3nh4-d0-cl13nt3'), 'o stack também vaza — precisa ser redigido');
  assert.equal(saida.name, erro.name, 'o nome do erro é preservado');
});

test('o Error original NÃO é mutado pela redação', () => {
  const erro = new Error(`ffmpeg falhou em ${SEGREDO}`);
  scrub(erro);
  assert.ok(
    erro.message.includes('s3nh4-d0-cl13nt3'),
    'redigir para o log não pode alterar o objeto que o chamador ainda vai tratar',
  );
});

test('redigir duas vezes é idempotente (logger + call site coexistem)', () => {
  const umaVez = redactSensitiveText(`falha em ${SEGREDO}`);
  const duasVezes = redactSensitiveText(umaVez);
  assert.equal(duasVezes, umaVez, 'a segunda passada não pode corromper o texto já redigido');
  assert.ok(!duasVezes.includes('s3nh4-d0-cl13nt3'));
});

test('sanitizeSensitiveText mantém o contrato antigo (Error vira .message)', () => {
  // 50+ pontos de chamada dependem deste comportamento; a extração de
  // `redactSensitiveText` não pode tê-lo mudado.
  const texto = sanitizeSensitiveText(new Error(`falha em ${SEGREDO}`));
  assert.ok(!texto.includes('s3nh4-d0-cl13nt3'));
  assert.ok(!texto.includes('\n'), 'continua sendo só a mensagem, sem stack');
});

test('valores que não são string/Error passam intactos', () => {
  const objeto = { cameraId: 'abc', tentativa: 3 };
  assert.equal(scrub(objeto), objeto, 'mesma referência — nada de serializar para logar');
  assert.equal(scrub(42), 42);
  assert.equal(scrub(undefined), undefined);
});

test('múltiplas URLs na mesma linha são todas redigidas', () => {
  const linha = `origem ${SEGREDO} destino rtsp://outro:outra-senha@10.0.0.9/live`;
  const saida = scrub(linha) as string;
  assert.ok(!saida.includes('s3nh4-d0-cl13nt3'));
  assert.ok(!saida.includes('outra-senha'), 'a segunda URL não pode escapar');
});
