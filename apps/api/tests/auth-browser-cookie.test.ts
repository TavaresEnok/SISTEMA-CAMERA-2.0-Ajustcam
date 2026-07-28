import assert from 'node:assert/strict';
import test from 'node:test';
import { AuthController } from '../src/auth/auth.controller';

const user = {
  id: 'user-1',
  name: 'Operador',
  email: 'operador@example.test',
  role: 'OPERATOR',
};

test('login web guarda refresh somente em cookie HttpOnly e usa access curto', async () => {
  const calls: any[] = [];
  const auth = {
    login: async (...args: any[]) => {
      calls.push(args);
      return {
        accessToken: 'access-curto',
        refreshToken: 'refresh-secreto-com-mais-de-trinta-e-dois-caracteres',
        refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        user,
      };
    },
  };
  const cookies: any[] = [];
  const controller = new AuthController(
    auth as any,
    { log: async () => undefined } as any,
  );
  const result = await controller.login(
    { email: user.email, password: 'senha' },
    { headers: { 'x-drac-auth-mode': 'cookie' } } as any,
    { cookie: (...args: any[]) => cookies.push(args) } as any,
  );

  assert.equal(calls[0][2], '15m');
  assert.equal('refreshToken' in result, false);
  assert.equal(result.accessToken, 'access-curto');
  assert.equal(cookies[0][0], 'vms_refresh_session');
  assert.equal(cookies[0][2].httpOnly, true);
  assert.equal(cookies[0][2].sameSite, 'lax');
});

test('refresh web lê cookie, rotaciona e nunca devolve o segredo ao JavaScript', async () => {
  const refreshCalls: any[] = [];
  const auth = {
    refreshSession: async (...args: any[]) => {
      refreshCalls.push(args);
      return {
        accessToken: 'access-rotacionado',
        refreshToken: 'refresh-novo-com-mais-de-trinta-e-dois-caracteres',
        refreshExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        user,
      };
    },
  };
  const cookies: any[] = [];
  const controller = new AuthController(
    auth as any,
    { log: async () => undefined } as any,
  );
  const result = await controller.refresh(
    {},
    {
      headers: {
        'x-drac-auth-mode': 'cookie',
        cookie: 'vms_refresh_session=refresh-antigo-seguro',
      },
    } as any,
    { cookie: (...args: any[]) => cookies.push(args) } as any,
  );

  assert.deepEqual(refreshCalls[0], ['refresh-antigo-seguro', '15m']);
  assert.equal('refreshToken' in result, false);
  assert.equal(cookies[0][1], 'refresh-novo-com-mais-de-trinta-e-dois-caracteres');
});
