import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  candidateOnvifPorts,
  COMMON_ONVIF_PORTS,
  MAX_ONVIF_CANDIDATES,
  parseStreamUri,
  predictOnvifPortFromSiblings,
  streamUriIdentifiesCamera,
} from '../src/cameras/helpers/onvif-port-discovery.helper';

// ─────────────────────────────────────────────────────────────────────────────
// O CAMPO EM BRANCO QUE CUSTAVA METADE DO SERVIDOR
//
// Medido em 2026-07-31 na instalação Grupo Flash: 6 câmeras em detecção nativa
// (evento ONVIF) e 15 na análise de vídeo do servidor, a 1,06 Mbps + ~2% de CPU
// cada. A varredura provou que o roteador JÁ redirecionava ONVIF para 15 delas
// (8081–8095) — só seis tinham a porta digitada no cadastro.
//
// As portas abaixo não são inventadas: são as medidas em campo, e a identidade
// de cada uma foi confirmada pela própria câmera (GetStreamUri devolvendo o
// endereço externo do NAT, ex.: a de 8087 declarou 160.19.47.74:57554).
// ─────────────────────────────────────────────────────────────────────────────

/** As seis que já tinham porta cadastrada — a "reta" do roteador deste cliente. */
const IRMAS_MEDIDAS = [
  { rtspPort: 51554, onvifPort: 8081 }, // Cam-01
  { rtspPort: 52554, onvifPort: 8082 }, // Cam-03
  { rtspPort: 53554, onvifPort: 8083 }, // Cam-02
  { rtspPort: 54554, onvifPort: 8084 }, // Cam-04
  { rtspPort: 55554, onvifPort: 8085 }, // Cam-05
  { rtspPort: 56554, onvifPort: 8086 }, // Cam-06
];

test('prevê as portas reais das oito câmeras que estavam sem cadastro', () => {
  // Previsão × porta que respondeu ONVIF na varredura de campo.
  const esperado: Array<[number, number]> = [
    [57554, 8087], // Cam-07
    [58554, 8088], // Cam-08
    [59554, 8089], // Cam-09
    [60554, 8090], // Cam-10
    [61554, 8091], // Cam-11
    [62554, 8092], // Cam-12
    [63554, 8093], // Cam-13
    [64554, 8094], // Cam-14
  ];
  for (const [rtsp, onvif] of esperado) {
    assert.equal(
      predictOnvifPortFromSiblings(rtsp, IRMAS_MEDIDAS),
      onvif,
      `RTSP ${rtsp} deveria prever ONVIF ${onvif}`,
    );
  }
});

test('duas irmãs bastam para traçar a reta', () => {
  const duas = [IRMAS_MEDIDAS[0], IRMAS_MEDIDAS[1]];
  assert.equal(predictOnvifPortFromSiblings(57554, duas), 8087);
});

test('uma irmã só não vira regra — uma reta precisa de dois pontos', () => {
  assert.equal(predictOnvifPortFromSiblings(57554, [IRMAS_MEDIDAS[0]]), null);
  assert.equal(predictOnvifPortFromSiblings(57554, []), null);
});

test('irmã fora da reta descarta a regra inteira', () => {
  // Site sem padrão: alguém redirecionou uma câmera na mão, fora da sequência.
  const bagunçado = [...IRMAS_MEDIDAS, { rtspPort: 57554, onvifPort: 9999 }];
  assert.equal(predictOnvifPortFromSiblings(58554, bagunçado), null);
});

test('cadastro contraditório (mesma RTSP com duas ONVIF) descarta a regra', () => {
  const contraditório = [
    { rtspPort: 51554, onvifPort: 8081 },
    { rtspPort: 51554, onvifPort: 8085 },
    { rtspPort: 52554, onvifPort: 8082 },
  ];
  assert.equal(predictOnvifPortFromSiblings(57554, contraditório), null);
});

test('previsão fracionária é rejeitada em vez de arredondada', () => {
  // Reta de inclinação 1/3: 60000 não cai em inteiro partindo de 51554.
  const irmãs = [
    { rtspPort: 51554, onvifPort: 8081 },
    { rtspPort: 54554, onvifPort: 8082 },
  ];
  assert.equal(predictOnvifPortFromSiblings(52554, irmãs), null);
  // Já um múltiplo exato do passo continua valendo.
  assert.equal(predictOnvifPortFromSiblings(57554, irmãs), 8083);
});

test('previsão fora da faixa de portas válidas é descartada', () => {
  const explosiva = [
    { rtspPort: 1000, onvifPort: 100 },
    { rtspPort: 2000, onvifPort: 40000 },
  ];
  assert.equal(predictOnvifPortFromSiblings(9000, explosiva), null);
});

test('sem porta RTSP no cadastro não há o que prever', () => {
  assert.equal(predictOnvifPortFromSiblings(null, IRMAS_MEDIDAS), null);
  assert.equal(predictOnvifPortFromSiblings(undefined, IRMAS_MEDIDAS), null);
});

// ── Identidade: a câmera confirma quem é ────────────────────────────────────

test('atrás de NAT a câmera declara o endereço externo e isso confirma', () => {
  // Exatamente o que a câmera de 8087 devolveu em campo.
  assert.equal(
    streamUriIdentifiesCamera('rtsp://160.19.47.74:57554/Streaming/Channels/101', {
      ip: '160.19.47.74',
      rtspPort: 57554,
    }),
    true,
  );
});

test('a irmã errada é rejeitada — este é o erro que um mapa por posição cometeria', () => {
  // Porta 8087 respondeu, mas declarou o fluxo da Cam-08: não é a Cam-07.
  assert.equal(
    streamUriIdentifiesCamera('rtsp://160.19.47.74:58554/Streaming/Channels/101', {
      ip: '160.19.47.74',
      rtspPort: 57554,
    }),
    false,
  );
});

test('câmera ligada direto confirma pelo IP interno com a 554 implícita', () => {
  assert.equal(
    streamUriIdentifiesCamera('rtsp://192.168.1.50/cam/realmonitor?channel=1', {
      ip: '192.168.1.50',
      rtspPort: 554,
    }),
    true,
  );
});

test('credencial embutida na URI não atrapalha a leitura do endereço', () => {
  assert.equal(
    streamUriIdentifiesCamera('rtsp://admin:p%40ss@word@192.168.1.50:554/live', {
      ip: '192.168.1.50',
      rtspPort: 554,
    }),
    true,
  );
});

test('IPv6 literal é lido corretamente', () => {
  assert.deepEqual(parseStreamUri('rtsp://[fd00::1]:8554/live'), {
    host: 'fd00::1',
    port: 8554,
  });
  assert.deepEqual(parseStreamUri('rtsp://[fd00::1]/live'), { host: 'fd00::1', port: 554 });
});

test('URI ilegível nunca confirma identidade', () => {
  for (const lixo of ['', 'http://192.168.1.50/snap.jpg', 'não é uri', 'rtsp://']) {
    assert.equal(
      streamUriIdentifiesCamera(lixo, { ip: '192.168.1.50', rtspPort: 554 }),
      false,
      `"${lixo}" não deveria confirmar`,
    );
  }
});

test('host diferente nunca confirma, mesmo com a porta certa', () => {
  assert.equal(
    streamUriIdentifiesCamera('rtsp://10.0.0.9:57554/live', {
      ip: '160.19.47.74',
      rtspPort: 57554,
    }),
    false,
  );
});

// ── Lista de candidatas ─────────────────────────────────────────────────────

test('a previsão do site vem antes das portas de fábrica', () => {
  const candidatas = candidateOnvifPorts({ rtspPort: 57554 }, IRMAS_MEDIDAS);
  assert.equal(candidatas[0], 8087, 'a porta prevista pelo site tem de ser a primeira tentativa');
  assert.ok(candidatas.includes(80), 'as de fábrica continuam na lista como reserva');
});

test('sem irmãs, sobram as portas de fábrica', () => {
  const candidatas = candidateOnvifPorts({ rtspPort: 554 }, []);
  assert.deepEqual(candidatas, [...COMMON_ONVIF_PORTS].slice(0, MAX_ONVIF_CANDIDATES));
});

test('a lista tem teto e não repete — sondagem não pode virar varredura', () => {
  const candidatas = candidateOnvifPorts({ rtspPort: 57554 }, IRMAS_MEDIDAS);
  assert.ok(candidatas.length <= MAX_ONVIF_CANDIDATES, 'passou do teto de tentativas');
  assert.equal(new Set(candidatas).size, candidatas.length, 'há porta repetida na lista');
});

test('previsão que coincide com porta de fábrica não é tentada duas vezes', () => {
  const irmãs = [
    { rtspPort: 1554, onvifPort: 78 },
    { rtspPort: 2554, onvifPort: 79 },
  ];
  const candidatas = candidateOnvifPorts({ rtspPort: 3554 }, irmãs); // prevê 80
  assert.equal(candidatas[0], 80);
  assert.equal(candidatas.filter((p) => p === 80).length, 1);
});
