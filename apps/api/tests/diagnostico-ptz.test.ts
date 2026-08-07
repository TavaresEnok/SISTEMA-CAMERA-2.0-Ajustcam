import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnosticarFalhaPtz } from '../src/ptz/helpers/diagnostico-ptz.helper';

// ─────────────────────────────────────────────────────────────────────────────
// A falha de PTZ chegava ao operador como quatro tentativas técnicas
// concatenadas numa caixa vermelha. O que importa aqui não é a redação: é que
// causas DIFERENTES levem a AÇÕES diferentes. Antes, "senha errada", "câmera
// fora do ar" e "câmera é fixa" viravam o mesmo parágrafo.
// ─────────────────────────────────────────────────────────────────────────────

test('câmera fixa: todas as tentativas recusadas → aponta modelo sem PTZ e a saída manual', () => {
  // Este é o texto REAL que apareceu na tela do dono em 07/08/2026.
  const d = diagnosticarFalhaPtz([
    'cgi-bin/ptz.cgi: Nenhum endpoint proprietário aceitou o comando.',
    '/onvif/ptz_service Profile000 (relative): Câmera retornou falha SOAP para o comando PTZ.',
    '/onvif/ptz_service Profile000: Câmera retornou falha SOAP para o comando PTZ.',
    '/onvif/ptz_service Profile001 (relative): Câmera retornou falha SOAP para o comando PTZ.',
  ]);

  assert.equal(d.causa, 'sem-suporte');
  assert.match(d.mensagem, /fixa|sem PTZ/i);
  assert.match(d.mensagem, /editor avançado/i, 'diz ao operador o que fazer se discordar');
  assert.equal(d.detalhesTecnicos.length, 4, 'o rastro técnico NÃO é jogado fora');
});

test('credencial recusada não vira "câmera não tem PTZ"', () => {
  // Distinção cara: mandar trocar o equipamento quando bastava corrigir a senha.
  const d = diagnosticarFalhaPtz([
    '/onvif/ptz_service Profile000: Auth não é Digest',
    'cgi-bin/ptz.cgi: HTTP 401 Unauthorized',
  ]);

  assert.equal(d.causa, 'credencial');
  assert.match(d.mensagem, /usuário e a senha|credenciais/i);
  assert.doesNotMatch(d.mensagem, /fixa|sem PTZ/i);
});

test('nada respondeu: é rede, não capacidade', () => {
  const d = diagnosticarFalhaPtz([
    '/onvif/ptz_service Profile000: ONVIF unreachable',
    '/onvif/device_service Profile000: SOAP PTZ timeout',
    'cgi-bin/ptz.cgi: Portas PTZ proprietárias indisponíveis.',
  ]);

  assert.equal(d.causa, 'inalcancavel');
  assert.match(d.mensagem, /online|porta/i);
  assert.doesNotMatch(d.mensagem, /fixa|sem PTZ/i, 'câmera fora do ar não é câmera sem PTZ');
});

test('sem tentativa alguma não inventa diagnóstico', () => {
  const d = diagnosticarFalhaPtz([]);
  assert.equal(d.causa, 'indeterminada');
  assert.equal(d.detalhesTecnicos.length, 0);
});

test('nenhuma mensagem despeja jargão de protocolo no operador', () => {
  const casos = [
    ['cgi-bin/ptz.cgi: Nenhum endpoint proprietário aceitou o comando.', '/onvif/x Profile000: Câmera retornou falha SOAP para o comando PTZ.'],
    ['/onvif/x: Auth não é Digest'],
    ['/onvif/x: ONVIF unreachable', '/onvif/y: SOAP PTZ timeout'],
    [],
    ['algo totalmente inesperado'],
  ];
  // O jargão continua existindo — em `detalhesTecnicos`. O que não pode é
  // vazar para a frase que o operador lê.
  //
  // "ONVIF" fica FORA desta lista de propósito: é rótulo visível no próprio
  // cadastro de câmera ("Porta ONVIF"), então o operador já convive com o termo
  // e dizer "o usuário do ONVIF é diferente do usuário da interface web" é a
  // informação mais útil da mensagem. Jargão é o que ele nunca viu: SOAP,
  // Digest, cgi-bin, Profile000, código HTTP.
  for (const tentativas of casos) {
    const { mensagem } = diagnosticarFalhaPtz(tentativas);
    assert.doesNotMatch(mensagem, /SOAP|Digest|cgi-bin|HTTP \d|endpoint|Profile\d/i, `vazou jargão: ${mensagem}`);
    assert.ok(mensagem.length > 40, 'mensagem curta demais para orientar alguém');
  }
});
