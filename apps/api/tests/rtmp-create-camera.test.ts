import { test } from 'node:test';
import assert from 'node:assert/strict';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateCameraDto } from '../src/cameras/dto/create-camera.dto';

// ─────────────────────────────────────────────────────────────────────────────
// CÂMERA QUE PUBLICA NÃO TEM ENDEREÇO NOSSO
//
// No modo push é a câmera que disca. Não existe IP para alcançá-la, porta para
// bater nem credencial para apresentar. Obrigar o instalador a inventar esses
// valores só para vencer a validação encheria o cadastro de dado falso que
// ninguém saberia interpretar meses depois — e foi exatamente o buraco que o
// dono apontou: "se eu quiser uma câmera só RTMP, ela não estará cadastrada".
//
// Estes testes fixam as duas metades do contrato: push dispensa conexão, e o
// modo tradicional continua exigindo tudo como antes.
// ─────────────────────────────────────────────────────────────────────────────

const erros = (payload: Record<string, unknown>) =>
  validateSync(plainToInstance(CreateCameraDto, payload), { whitelist: true })
    .flatMap((e) => Object.keys(e.constraints ?? {}).map(() => e.property));

test('push aceita cadastro só com o nome', () => {
  assert.deepEqual(erros({ name: 'Portaria 4G', sourceMode: 'rtmp_push' }), []);
});

test('push aceita local e área, que são os únicos campos que fazem sentido', () => {
  assert.deepEqual(
    erros({ name: 'Portaria', sourceMode: 'rtmp_push', siteId: 'abc', areaId: 'def' }),
    [],
  );
});

test('o modo tradicional continua exigindo conexão completa', () => {
  const faltando = erros({ name: 'Câmera comum' });
  for (const campo of ['ip', 'rtspPort', 'username', 'password']) {
    assert.ok(faltando.includes(campo), `${campo} deveria continuar obrigatório no modo pull`);
  }
});

test('declarar rtsp_pull explicitamente também exige conexão', () => {
  const faltando = erros({ name: 'Câmera comum', sourceMode: 'rtsp_pull' });
  assert.ok(faltando.includes('ip'), 'rtsp_pull explícito não pode afrouxar a validação');
});

test('modo inventado é recusado', () => {
  assert.ok(erros({ name: 'X', sourceMode: 'p2p' }).includes('sourceMode'));
  assert.ok(erros({ name: 'X', sourceMode: 'rtmp' }).includes('sourceMode'));
});

test('cadastro tradicional válido passa sem erro', () => {
  assert.deepEqual(
    erros({ name: 'Cam', ip: '192.168.1.50', rtspPort: 554, username: 'admin', password: 'x' }),
    [],
  );
});

test('push com IP junto não é erro — apenas ignorado pelo caminho de push', () => {
  // Tolerante de propósito: integrações que já mandam o corpo completo não
  // quebram ao acrescentar sourceMode.
  assert.deepEqual(
    erros({ name: 'Cam', sourceMode: 'rtmp_push', ip: '192.168.1.50', rtspPort: 554, username: 'a', password: 'b' }),
    [],
  );
});
