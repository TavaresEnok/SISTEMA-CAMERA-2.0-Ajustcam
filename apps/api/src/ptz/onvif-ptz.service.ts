import { Injectable, Logger } from '@nestjs/common';
import { type Camera } from '@prisma/client';
import { createHash, randomBytes } from 'crypto';
import * as http from 'http';
import { type PtzCommandDto } from './dto/ptz-command.dto';
import { diagnosticarFalhaPtz } from './helpers/diagnostico-ptz.helper';
import { CryptoService } from '../common/crypto/crypto.service';
import { PortCheckerService } from '../common/network/port-checker.service';
import { assertCameraTargetAllowed } from '../common/network/safe-url.helper';
import { PtzStateStore } from './ptz-state.store';

type DigestSoapRequestInput = {
  method?: 'GET' | 'POST';
  host: string;
  port: number;
  path: string;
  body?: string;
  username: string;
  password: string;
  timeout: number;
  contentType?: string;
};

type DigestSoapResult = {
  ok: boolean;
  message: string;
  statusCode?: number;
  responseBody?: string;
};

type DetectOnvifInput = {
  ip: string;
  onvifPort?: number;
  username?: string;
  password?: string;
  onvifPath?: string;
  onvifProfileToken?: string;
};

type RelayState = 'active' | 'inactive';

@Injectable()
export class OnvifPtzService {
  private readonly logger = new Logger(OnvifPtzService.name);
  private readonly onvifFallbackPorts = [8075, 8080, 8000, 8899];
  private readonly proprietaryPtzPort = 8075;
  private readonly moveWatchdogs = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly cryptoService: CryptoService,
    private readonly portChecker: PortCheckerService,
    private readonly ptzStateStore: PtzStateStore,
  ) {}

  private resolveOnvifCredentials(camera: Camera) {
    const stored = this.ptzStateStore.getCamera(camera.id);
    const username = stored.onvifUsername?.trim() || camera.username;
    const password = stored.onvifPasswordEncrypted
      ? this.cryptoService.decrypt(stored.onvifPasswordEncrypted)
      : this.cryptoService.decrypt(camera.passwordEncrypted);
    return { username, password };
  }

  parseDigestHeader(header: string) {
    const result: Record<string, string> = {};
    const quotedRegex = /(\w+)="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = quotedRegex.exec(header)) !== null) {
      result[match[1]] = match[2];
    }
    if (Object.keys(result).length === 0) {
      const plainRegex = /(\w+)=([^,\s]+)/g;
      while ((match = plainRegex.exec(header)) !== null) {
        result[match[1]] = match[2];
      }
    }
    return result;
  }

  generateCnonce() {
    return randomBytes(8).toString('hex');
  }

  buildDigestAuth(
    method: string,
    uri: string,
    authHeader: string,
    username: string,
    password: string,
    nc = 1,
  ) {
    const params = this.parseDigestHeader(authHeader);
    const realm = params.realm ?? '';
    const nonce = params.nonce ?? '';
    const qop = params.qop ?? 'auth';
    const opaque = params.opaque ?? '';
    const algorithm = params.algorithm ?? 'MD5';
    const cnonce = this.generateCnonce();
    const ncStr = nc.toString(16).padStart(8, '0');

    const ha1 = createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
    const ha2 = createHash('md5').update(`${method}:${uri}`).digest('hex');
    const response = createHash('md5')
      .update(`${ha1}:${nonce}:${ncStr}:${cnonce}:${qop}:${ha2}`)
      .digest('hex');

    let auth = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", qop=${qop}, nc=${ncStr}, cnonce="${cnonce}", response="${response}"`;
    if (opaque) auth += `, opaque="${opaque}"`;
    if (algorithm && algorithm !== 'MD5') auth += `, algorithm="${algorithm}"`;
    return auth;
  }

  private speedToFactor(speed?: number) {
    const value = Number.isFinite(speed) ? Number(speed) : 5;
    return Math.max(0.1, Math.min(1, value / 10));
  }

  private moveKey(cameraId: string, direction?: string) {
    return `${cameraId}:${direction ?? 'all'}`;
  }

  private clearMoveWatchdog(cameraId: string, direction?: string) {
    const keys = direction ? [this.moveKey(cameraId, direction), this.moveKey(cameraId)] : Array.from(this.moveWatchdogs.keys()).filter((key) => key.startsWith(`${cameraId}:`));
    for (const key of keys) {
      const timer = this.moveWatchdogs.get(key);
      if (!timer) continue;
      clearTimeout(timer);
      this.moveWatchdogs.delete(key);
    }
  }

  private scheduleMoveWatchdog(camera: Camera, direction: NonNullable<PtzCommandDto['direction']>, timeoutMs?: number) {
    const safeTimeout = Math.max(500, Math.min(3000, Number(timeoutMs ?? 1500)));
    const key = this.moveKey(camera.id, direction);
    this.clearMoveWatchdog(camera.id, direction);
    const timer = setTimeout(() => {
      this.moveWatchdogs.delete(key);
      void this.sendPtzWithFallbacks(camera, 'stop', direction).then((result) => {
        this.logger.log(`PTZ watchdog stop camera=${camera.id} direction=${direction} ok=${result.ok}`);
      });
    }, safeTimeout);
    this.moveWatchdogs.set(key, timer);
  }

  buildSoapBody(action: 'start' | 'stop', direction: PtzCommandDto['direction'], profileToken: string, speed?: number) {
    if (action === 'stop') {
      return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
  <soap:Body>
    <tptz:Stop>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
      <tptz:PanTilt>true</tptz:PanTilt>
      <tptz:Zoom>true</tptz:Zoom>
    </tptz:Stop>
  </soap:Body>
</soap:Envelope>`;
    }

    const map: Record<NonNullable<PtzCommandDto['direction']>, [number, number, number]> = {
      Up: [0, 0.5, 0],
      Down: [0, -0.5, 0],
      Left: [-0.5, 0, 0],
      Right: [0.5, 0, 0],
      ZoomIn: [0, 0, 0.5],
      ZoomOut: [0, 0, -0.5],
    };
    const [baseX, baseY, baseZ] = map[direction ?? 'Up'];
    const factor = this.speedToFactor(speed);
    const x = Number((baseX * factor).toFixed(3));
    const y = Number((baseY * factor).toFixed(3));
    const z = Number((baseZ * factor).toFixed(3));

    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <soap:Body>
    <tptz:ContinuousMove>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
      <tptz:Velocity>
        <tt:PanTilt x="${x}" y="${y}" />
        <tt:Zoom x="${z}" />
      </tptz:Velocity>
    </tptz:ContinuousMove>
  </soap:Body>
</soap:Envelope>`;
  }

  buildGotoHomeSoapBody(profileToken: string) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl">
  <soap:Body>
    <tptz:GotoHomePosition>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
    </tptz:GotoHomePosition>
  </soap:Body>
</soap:Envelope>`;
  }

  buildRelativeMoveSoapBody(direction: NonNullable<PtzCommandDto['direction']>, profileToken: string) {
    const map: Record<NonNullable<PtzCommandDto['direction']>, [number, number, number]> = {
      Up: [0, 0.2, 0],
      Down: [0, -0.2, 0],
      Left: [-0.2, 0, 0],
      Right: [0.2, 0, 0],
      ZoomIn: [0, 0, 0.2],
      ZoomOut: [0, 0, -0.2],
    };
    const [x, y, z] = map[direction];
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tptz="http://www.onvif.org/ver20/ptz/wsdl" xmlns:tt="http://www.onvif.org/ver10/schema">
  <soap:Body>
    <tptz:RelativeMove>
      <tptz:ProfileToken>${profileToken}</tptz:ProfileToken>
      <tptz:Translation>
        <tt:PanTilt x="${x}" y="${y}" />
        <tt:Zoom x="${z}" />
      </tptz:Translation>
    </tptz:RelativeMove>
  </soap:Body>
</soap:Envelope>`;
  }

  private parseSoapResponse(statusCode: number | undefined, responseBody: string): DigestSoapResult {
    const body = responseBody.trim();
    const lower = body.toLowerCase();
    if ((statusCode ?? 500) >= 400) {
      return {
        ok: false,
        statusCode,
        responseBody: body,
        message: body.includes('Unknown Error') ? 'Câmera rejeitou o comando PTZ (SOAP Fault).' : `ONVIF SOAP HTTP ${statusCode ?? 500}`,
      };
    }
    if (lower.includes('<fault') || lower.includes(':fault>') || lower.includes('<soap:fault')) {
      return {
        ok: false,
        statusCode,
        responseBody: body,
        message: body.includes('Unknown Error') ? 'Câmera rejeitou o comando PTZ (SOAP Fault).' : 'Câmera retornou falha SOAP para o comando PTZ.',
      };
    }
    return {
      ok: true,
      statusCode,
      responseBody: body,
      message: 'ok',
    };
  }

  digestSoapRequest(input: DigestSoapRequestInput): Promise<DigestSoapResult> {
    const { host, port, path, username, password, timeout } = input;
    let allowedHost: string;
    try {
      allowedHost = assertCameraTargetAllowed(host, port);
    } catch {
      return Promise.resolve({ ok: false, message: 'Destino ONVIF bloqueado pela política de rede.' });
    }
    const method = input.method ?? 'POST';
    const body = input.body ?? '';
    const contentType = input.contentType ?? 'application/soap+xml; charset=utf-8';
    const baseHeaders: Record<string, string | number> = {
      Connection: 'close',
    };
    if (method !== 'GET') {
      baseHeaders['Content-Type'] = contentType;
      baseHeaders['Content-Length'] = Buffer.byteLength(body);
    }

    return new Promise((resolve) => {
      const collectBody = (res: http.IncomingMessage, done: (payload: DigestSoapResult) => void) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          done(this.parseSoapResponse(res.statusCode, bodyText));
        });
      };

      const requestOptions: http.RequestOptions = {
        host: allowedHost,
        port,
        path,
        method,
        timeout,
        headers: baseHeaders,
      };

      const req1 = http.request(requestOptions, (res1) => {
        if (res1.statusCode === 401) {
          const authHeader = res1.headers['www-authenticate'];
          if (!authHeader || !String(authHeader).toLowerCase().startsWith('digest')) {
            resolve({ ok: false, message: 'Auth não é Digest' });
            return;
          }

          const digestAuth = this.buildDigestAuth(
            method,
            path,
            String(authHeader),
            username,
            password,
            1,
          );

          const req2 = http.request(
            {
              ...requestOptions,
              headers: {
                ...baseHeaders,
                Authorization: digestAuth,
              },
            },
            (res2) => {
              collectBody(res2, resolve);
            },
          );

          req2.on('error', (error) => resolve({ ok: false, message: `SOAP PTZ falhou: ${error.message}` }));
          req2.on('timeout', () => {
            req2.destroy();
            resolve({ ok: false, message: 'SOAP PTZ timeout' });
          });
          if (method !== 'GET') {
            req2.write(body);
          }
          req2.end();
          return;
        }

        collectBody(res1, resolve);
      });

      req1.on('error', (error) => resolve({ ok: false, message: `SOAP PTZ falhou: ${error.message}` }));
      req1.on('timeout', () => {
        req1.destroy();
        resolve({ ok: false, message: 'SOAP PTZ timeout' });
      });
      if (method !== 'GET') {
        req1.write(body);
      }
      req1.end();
    });
  }

  private candidatePaths(preferred?: string | null) {
    return Array.from(new Set([
      preferred?.trim(),
      '/onvif/ptz_service',
      '/onvif/device_service',
      '/onvif/media_service',
    ].filter((value): value is string => Boolean(value))));
  }

  private candidateDevicePaths(preferred?: string | null) {
    return Array.from(new Set([
      preferred?.trim(),
      '/onvif/device_service',
      '/onvif/device',
      '/onvif/ptz_service',
    ].filter((value): value is string => Boolean(value))));
  }

  private candidateProfileTokens(preferred?: string | null, channel?: number | null, discoveredTokens: string[] = []) {
    const channelNumber = Number(channel);
    const channelTokens = Number.isFinite(channelNumber) && channelNumber > 0
      ? [
          `Profile${String(channelNumber - 1).padStart(3, '0')}`,
          `Profile${String(channelNumber).padStart(3, '0')}`,
          `profile_${channelNumber}`,
          `profile${channelNumber}`,
          `Profile${channelNumber}`,
        ]
      : [];
    return Array.from(
      new Set(
        [
          preferred?.trim(),
          ...discoveredTokens,
          ...channelTokens,
          'Profile000',
          'Profile001',
          'Profile002',
          'profile_1',
          'profile_2',
        ].filter((value): value is string => Boolean(value)),
      ),
    );
  }

  private buildGetProfilesSoapBody() {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:trt="http://www.onvif.org/ver10/media/wsdl">
  <soap:Body>
    <trt:GetProfiles />
  </soap:Body>
</soap:Envelope>`;
  }

  private buildGetRelayOutputsSoapBody() {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <soap:Body>
    <tds:GetRelayOutputs />
  </soap:Body>
</soap:Envelope>`;
  }

  private buildSetRelayOutputStateSoapBody(token: string, state: RelayState) {
    return `<?xml version="1.0" encoding="utf-8"?>
<soap:Envelope xmlns:soap="http://www.w3.org/2003/05/soap-envelope" xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
  <soap:Body>
    <tds:SetRelayOutputState>
      <tds:RelayOutputToken>${token}</tds:RelayOutputToken>
      <tds:LogicalState>${state}</tds:LogicalState>
    </tds:SetRelayOutputState>
  </soap:Body>
</soap:Envelope>`;
  }

  private extractProfileTokens(responseBody?: string) {
    if (!responseBody) return [];
    const tokens: string[] = [];
    const tokenRegex = /<(?:\w+:)?Profiles\b[^>]*(?:token|Token)="([^"]+)"/g;
    let match: RegExpExecArray | null;
    while ((match = tokenRegex.exec(responseBody)) !== null) {
      if (match[1]) tokens.push(match[1]);
    }
    return Array.from(new Set(tokens));
  }

  private extractRelayOutputs(responseBody?: string) {
    if (!responseBody) return [];
    const relays: Array<{ token: string; mode?: string; delayTime?: string; idleState?: string }> = [];
    const relayRegex = /<(?:\w+:)?RelayOutputs\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?RelayOutputs>/g;
    let match: RegExpExecArray | null;
    while ((match = relayRegex.exec(responseBody)) !== null) {
      const attrs = match[1] ?? '';
      const body = match[2] ?? '';
      const token = attrs.match(/\b(?:token|Token)="([^"]+)"/)?.[1];
      if (!token) continue;
      relays.push({
        token,
        mode: body.match(/<(?:\w+:)?Mode>([^<]+)<\/(?:\w+:)?Mode>/)?.[1],
        delayTime: body.match(/<(?:\w+:)?DelayTime>([^<]+)<\/(?:\w+:)?DelayTime>/)?.[1],
        idleState: body.match(/<(?:\w+:)?IdleState>([^<]+)<\/(?:\w+:)?IdleState>/)?.[1],
      });
    }

    return relays.filter((relay, index, list) => list.findIndex((item) => item.token === relay.token) === index);
  }

  private async discoverProfileTokens(input: {
    host: string;
    port: number;
    paths: string[];
    username: string;
    password: string;
    timeout?: number;
  }) {
    const discovered: Array<{ path: string; tokens: string[] }> = [];
    const errors: string[] = [];
    for (const path of input.paths) {
      const result = await this.digestSoapRequest({
        host: input.host,
        port: input.port,
        path,
        body: this.buildGetProfilesSoapBody(),
        username: input.username,
        password: input.password,
        timeout: input.timeout ?? 3500,
      });
      if (!result.ok) {
        errors.push(`${path}: ${result.message}`);
        continue;
      }
      const tokens = this.extractProfileTokens(result.responseBody);
      if (tokens.length > 0) {
        discovered.push({ path, tokens });
      }
    }

    return {
      tokens: Array.from(new Set(discovered.flatMap((item) => item.tokens))),
      endpoints: discovered,
      errors,
    };
  }

  private async sendPtzWithFallbacks(
    camera: Camera,
    action: 'start' | 'stop',
    direction?: NonNullable<PtzCommandDto['direction']>,
    speed?: number,
  ) {
    const onvifPort = await this.findOnvifPort(camera);
    if (!onvifPort) {
      return { ok: false, message: 'ONVIF unreachable' };
    }

    const auth = this.resolveOnvifCredentials(camera);
    const candidatePaths = this.candidatePaths(camera.onvifPath);
    const errors: string[] = [];

    if (this.shouldPreferProprietaryPtz(camera)) {
      const proprietaryResult = await this.sendProprietaryPtz(camera, action, direction);
      if (proprietaryResult.ok) {
        return proprietaryResult;
      }
      if (proprietaryResult.message) {
        errors.push(`cgi-bin/ptz.cgi: ${proprietaryResult.message}`);
      }
    }

    const profileDiscovery = await this.discoverProfileTokens({
      host: camera.ip,
      port: onvifPort,
      paths: candidatePaths,
      username: auth.username,
      password: auth.password,
      timeout: 3000,
    });
    const candidateTokens = this.candidateProfileTokens(camera.onvifProfileToken, camera.channel, profileDiscovery.tokens);

    for (const onvifPath of candidatePaths) {
      for (const profileToken of candidateTokens) {
        const body = this.buildSoapBody(action, direction, profileToken, speed);
        const result = await this.digestSoapRequest({
          host: camera.ip,
          port: onvifPort,
          path: onvifPath,
          body,
          username: auth.username,
          password: auth.password,
          timeout: 5000,
        });
        if (result.ok) {
          return {
            ok: true,
            message: 'ok',
            onvifPort,
            onvifPath,
            profileToken,
            discoveredProfileTokens: profileDiscovery.tokens,
          };
        }
        if (action === 'start' && direction) {
          const relativeBody = this.buildRelativeMoveSoapBody(direction, profileToken);
          const relativeResult = await this.digestSoapRequest({
            host: camera.ip,
            port: onvifPort,
            path: onvifPath,
            body: relativeBody,
            username: auth.username,
            password: auth.password,
            timeout: 5000,
          });
          if (relativeResult.ok) {
            return {
              ok: true,
              message: 'ok',
              onvifPort,
              onvifPath,
              profileToken,
              mode: 'relative_move',
              discoveredProfileTokens: profileDiscovery.tokens,
            };
          }
          errors.push(`${onvifPath} ${profileToken} (relative): ${relativeResult.message}`);
        }
        errors.push(`${onvifPath} ${profileToken}: ${result.message}`);
      }
    }

    const proprietaryResult = await this.sendProprietaryPtz(camera, action, direction);
    if (proprietaryResult.ok) {
      return proprietaryResult;
    }
    if (proprietaryResult.message) {
      errors.push(`cgi-bin/ptz.cgi: ${proprietaryResult.message}`);
    }

    // O operador recebe a CAUSA e o que fazer; o rastro técnico continua
    // inteiro, só que num campo próprio (log e painel de diagnóstico), em vez
    // de quatro tentativas concatenadas numa caixa vermelha na tela.
    const diagnostico = diagnosticarFalhaPtz(errors);
    this.logger.warn(
      `PTZ falhou camera=${camera.id} causa=${diagnostico.causa}: ${errors.slice(0, 4).join(' | ')}`,
    );
    return {
      ok: false,
      message: diagnostico.mensagem,
      causa: diagnostico.causa,
      detalhesTecnicos: diagnostico.detalhesTecnicos.slice(0, 6),
    };
  }

  private proprietaryDirectionCode(direction: NonNullable<PtzCommandDto['direction']>) {
    const map: Record<NonNullable<PtzCommandDto['direction']>, string[]> = {
      Up: ['Up'],
      Down: ['Down'],
      Left: ['Left'],
      Right: ['Right'],
      ZoomIn: ['ZoomTele', 'ZoomIn'],
      ZoomOut: ['ZoomWide', 'ZoomOut'],
    };
    return map[direction];
  }

  private shouldPreferProprietaryPtz(camera: Camera) {
    const rtspPath = (camera.rtspPath ?? '').toLowerCase();
    return rtspPath.includes('/cam/realmonitor') || [8075, 8076, 8077].includes(camera.onvifPort ?? 0);
  }

  private proprietaryPorts(camera: Camera) {
    return Array.from(new Set([
      camera.onvifPort ?? undefined,
      this.proprietaryPtzPort,
      ...this.onvifFallbackPorts,
      80,
    ].filter((value): value is number => Number.isFinite(value))));
  }

  private proprietaryChannels(camera: Camera) {
    // When cameras are exposed through per-camera forwarded ports, vendor CGI usually expects channel=1.
    return Array.from(new Set([1, camera.channel].filter((value): value is number => Number.isFinite(value) && value > 0)));
  }

  private extractVendorAlarmOutputs(responseBody?: string) {
    if (!responseBody) return [];
    const relays: Array<{ token: string; protocol: 'cgi'; output: number; mode?: string }> = [];
    const modeRegex = /AlarmOut\[(\d+)\]\.Mode=([0-9]+)/g;
    let match: RegExpExecArray | null;
    while ((match = modeRegex.exec(responseBody)) !== null) {
      const output = Number(match[1]);
      if (!Number.isFinite(output)) continue;
      relays.push({
        token: `alarmout-${output}`,
        protocol: 'cgi',
        output,
        mode: match[2],
      });
    }
    return relays.filter((relay, index, list) => list.findIndex((item) => item.output === relay.output) === index);
  }

  private isCgiErrorResponse(responseBody?: string) {
    const body = responseBody?.trim().toLowerCase() ?? '';
    return !body || body === 'error' || body.includes('bad request') || body.includes('not support') || body.includes('not supported');
  }

  private relayTokenToVendorOutput(token?: string) {
    if (!token) return 0;
    const match = token.match(/(?:alarmout|output)-(\d+)/i);
    const value = match ? Number(match[1]) : Number(token);
    return Number.isFinite(value) && value >= 0 ? value : 0;
  }

  private async listVendorAlarmOutputs(camera: Camera) {
    if (!this.shouldPreferProprietaryPtz(camera)) {
      return { ok: false, message: 'Câmera não parece compatível com CGI Intelbras/Dahua.', relays: [], relayCount: 0, triggerable: false };
    }

    const auth = this.resolveOnvifCredentials(camera);
    const ports = this.proprietaryPorts(camera);
    for (const port of ports) {
      if (!await this.portChecker.check(camera.ip, port)) continue;
      const result = await this.digestSoapRequest({
        method: 'GET',
        host: camera.ip,
        port,
        path: '/cgi-bin/configManager.cgi?action=getConfig&name=AlarmOut',
        username: auth.username,
        password: auth.password,
        timeout: 3500,
        contentType: 'text/plain',
      });
      if (!result.ok || this.isCgiErrorResponse(result.responseBody)) continue;
      const relays = this.extractVendorAlarmOutputs(result.responseBody);
      if (relays.length > 0) {
        return {
          ok: true,
          message: 'ok',
          protocol: 'cgi',
          port,
          relays,
          relayCount: relays.length,
          triggerable: true,
        };
      }
    }

    return {
      ok: true,
      message: 'A câmera não publicou saída AlarmOut manual via API local.',
      protocol: 'cgi',
      relays: [],
      relayCount: 0,
      triggerable: false,
    };
  }

  private async setVendorAlarmOutputMode(camera: Camera, output: number, mode: 0 | 1 | 2) {
    if (!this.shouldPreferProprietaryPtz(camera)) {
      return { ok: false, message: 'Câmera não parece compatível com CGI Intelbras/Dahua.' };
    }

    const auth = this.resolveOnvifCredentials(camera);
    const ports = this.proprietaryPorts(camera);
    for (const port of ports) {
      if (!await this.portChecker.check(camera.ip, port)) continue;
      const result = await this.digestSoapRequest({
        method: 'GET',
        host: camera.ip,
        port,
        path: `/cgi-bin/configManager.cgi?action=setConfig&AlarmOut[${output}].Mode=${mode}`,
        username: auth.username,
        password: auth.password,
        timeout: 3500,
        contentType: 'text/plain',
      });
      if (result.ok && !this.isCgiErrorResponse(result.responseBody)) {
        return {
          ok: true,
          message: 'ok',
          protocol: 'cgi',
          port,
          output,
          mode,
        };
      }
    }

    return { ok: false, message: `AlarmOut[${output}] não aceitou Mode=${mode}.`, output, mode };
  }

  private async triggerVendorAlarmOutput(camera: Camera, token?: string, durationMs?: number) {
    const discovery = await this.listVendorAlarmOutputs(camera);
    if (!discovery.ok || discovery.relayCount === 0) {
      return {
        ok: false,
        message: discovery.message ?? 'Nenhuma saída de alarme manual foi publicada pela câmera.',
        details: discovery,
      };
    }

    const output = this.relayTokenToVendorOutput(token);
    const safeDuration = Math.max(250, Math.min(15000, Number(durationMs ?? 2000)));
    const active = await this.setVendorAlarmOutputMode(camera, output, 1);
    if (!active.ok) return active;

    await new Promise((resolve) => setTimeout(resolve, safeDuration));
    const inactive = await this.setVendorAlarmOutputMode(camera, output, 2);
    if (!inactive.ok) {
      return {
        ok: false,
        message: `AlarmOut ativado, mas falhou ao desativar automaticamente: ${inactive.message}`,
        mode: 'vendor_alarmout_trigger',
        durationMs: safeDuration,
        active,
        inactive,
      };
    }

    return {
      ok: true,
      message: 'ok',
      mode: 'vendor_alarmout_trigger',
      durationMs: safeDuration,
      relayToken: `alarmout-${output}`,
      active,
      inactive,
    };
  }

  private async sendProprietaryPtz(
    camera: Camera,
    action: 'start' | 'stop',
    direction?: NonNullable<PtzCommandDto['direction']>,
  ) {
    const auth = this.resolveOnvifCredentials(camera);
    const ports = this.proprietaryPorts(camera);
    const channels = this.proprietaryChannels(camera);
    const reachablePorts: number[] = [];
    for (const port of ports) {
      if (await this.portChecker.check(camera.ip, port)) {
        reachablePorts.push(port);
      }
    }
    if (reachablePorts.length === 0) {
      return { ok: false, message: 'Portas PTZ proprietárias indisponíveis.' };
    }

    if (action === 'stop') {
      const stopDirections = direction ? [direction] : ['Up', 'Down', 'Left', 'Right'] as Array<NonNullable<PtzCommandDto['direction']>>;
      for (const port of reachablePorts) {
        for (const channel of channels) {
          for (const item of stopDirections) {
            for (const code of this.proprietaryDirectionCode(item)) {
              const result = await this.digestSoapRequest({
                method: 'GET',
                host: camera.ip,
                port,
                path: `/cgi-bin/ptz.cgi?action=stop&channel=${channel}&code=${code}&arg1=0&arg2=1&arg3=0`,
                username: auth.username,
                password: auth.password,
                timeout: 3500,
                contentType: 'text/plain',
              });
              if (result.ok) {
                return { ok: true, message: 'ok', protocol: 'cgi', channel, port, code };
              }
            }
          }
        }
      }
      return { ok: false, message: 'Falha ao parar PTZ no endpoint proprietário.' };
    }

    if (!direction) {
      return { ok: false, message: 'Direção ausente para PTZ proprietário.' };
    }
    for (const port of reachablePorts) {
      for (const channel of channels) {
        for (const code of this.proprietaryDirectionCode(direction)) {
          const result = await this.digestSoapRequest({
            method: 'GET',
            host: camera.ip,
            port,
            path: `/cgi-bin/ptz.cgi?action=start&channel=${channel}&code=${code}&arg1=0&arg2=1&arg3=0`,
            username: auth.username,
            password: auth.password,
            timeout: 3500,
            contentType: 'text/plain',
          });
          if (result.ok) {
            return { ok: true, message: 'ok', protocol: 'cgi', channel, port, code };
          }
        }
      }
    }
    return { ok: false, message: 'Nenhum endpoint proprietário aceitou o comando.' };
  }

  private async findOnvifPort(camera: Camera) {
    const preferredPort = camera.onvifPort ?? this.onvifFallbackPorts[0];
    const ports = Array.from(new Set([preferredPort, ...this.onvifFallbackPorts, 80, 2020]));
    for (const port of ports) {
      const reachable = await this.portChecker.check(camera.ip, port);
      if (reachable) {
        return port;
      }
    }
    return null;
  }

  async move(camera: Camera, direction: NonNullable<PtzCommandDto['direction']>, speed?: number, autoStopMs?: number) {
    this.logger.log(`PTZ start camera=${camera.id} direction=${direction} speed=${speed ?? 5} onvifPort=${camera.onvifPort ?? 'auto'}`);
    const result = await this.sendPtzWithFallbacks(camera, 'start', direction, speed);
    if (result.ok) {
      this.scheduleMoveWatchdog(camera, direction, autoStopMs);
    }
    this.logger.log(`PTZ start result camera=${camera.id} ok=${result.ok}`);
    return result;
  }

  async stop(camera: Camera, direction?: NonNullable<PtzCommandDto['direction']>) {
    this.logger.log(`PTZ stop camera=${camera.id} onvifPort=${camera.onvifPort ?? 'auto'}`);
    this.clearMoveWatchdog(camera.id, direction);
    const result = await this.sendPtzWithFallbacks(camera, 'stop', direction);
    this.logger.log(`PTZ stop result camera=${camera.id} ok=${result.ok}`);
    return result;
  }

  async step(camera: Camera, direction: NonNullable<PtzCommandDto['direction']>, speed?: number, durationMs?: number) {
    const stepDuration = Math.max(120, Math.min(2500, Number(durationMs ?? 420)));
    const start = await this.move(camera, direction, speed);
    if (!start.ok) return start;
    await new Promise((resolve) => setTimeout(resolve, stepDuration));
    const stop = await this.stop(camera, direction);
    if (!stop.ok) {
      return { ok: false, message: `Step iniciou, mas falhou ao parar: ${stop.message}`, mode: 'step', durationMs: stepDuration, start, stop };
    }
    return { ok: true, message: 'ok', mode: 'step', durationMs: stepDuration, start, stop };
  }

  async goHome(camera: Camera) {
    const onvifPort = await this.findOnvifPort(camera);
    if (!onvifPort) {
      return { ok: false, message: 'ONVIF unreachable' };
    }
    const auth = this.resolveOnvifCredentials(camera);
    const candidatePaths = this.candidatePaths(camera.onvifPath);
    const profileDiscovery = await this.discoverProfileTokens({
      host: camera.ip,
      port: onvifPort,
      paths: candidatePaths,
      username: auth.username,
      password: auth.password,
      timeout: 3000,
    });
    const candidateTokens = this.candidateProfileTokens(camera.onvifProfileToken, camera.channel, profileDiscovery.tokens);
    const errors: string[] = [];
    for (const onvifPath of candidatePaths) {
      for (const profileToken of candidateTokens) {
        const result = await this.digestSoapRequest({
          host: camera.ip,
          port: onvifPort,
          path: onvifPath,
          body: this.buildGotoHomeSoapBody(profileToken),
          username: auth.username,
          password: auth.password,
          timeout: 5000,
        });
        if (result.ok) {
          this.logger.log(`PTZ home camera=${camera.id} ok=true`);
          return { ok: true, message: 'ok', onvifPort, onvifPath, profileToken, discoveredProfileTokens: profileDiscovery.tokens };
        }
        errors.push(`${onvifPath} ${profileToken}: ${result.message}`);
      }
    }
    this.logger.log(`PTZ home camera=${camera.id} ok=false`);
    return { ok: false, message: `Home position não aceita pelos endpoints testados: ${errors.slice(0, 4).join(' | ')}` };
  }

  async listRelayOutputs(camera: Camera) {
    const onvifPort = await this.findOnvifPort(camera);
    if (!onvifPort) {
      const vendorRelays = await this.listVendorAlarmOutputs(camera);
      if (vendorRelays.ok) return vendorRelays;
      return { ok: false, message: 'ONVIF unreachable', relays: [] };
    }

    const auth = this.resolveOnvifCredentials(camera);
    const errors: string[] = [];
    let emptyOnvifResult: {
      ok: true;
      message: string;
      onvifPort: number;
      onvifPath: string;
      relays: Array<{ token: string; mode?: string; delayTime?: string; idleState?: string }>;
      relayCount: number;
      triggerable: boolean;
    } | null = null;
    for (const onvifPath of this.candidateDevicePaths(camera.onvifPath)) {
      const result = await this.digestSoapRequest({
        host: camera.ip,
        port: onvifPort,
        path: onvifPath,
        body: this.buildGetRelayOutputsSoapBody(),
        username: auth.username,
        password: auth.password,
        timeout: 5000,
      });
      if (!result.ok) {
        errors.push(`${onvifPath}: ${result.message}`);
        continue;
      }

      const relays = this.extractRelayOutputs(result.responseBody);
      if (relays.length === 0) {
        emptyOnvifResult = {
          ok: true,
          message: 'ok',
          onvifPort,
          onvifPath,
          relays,
          relayCount: 0,
          triggerable: false,
        };
        continue;
      }
      return {
        ok: true,
        message: 'ok',
        onvifPort,
        onvifPath,
        relays,
        relayCount: relays.length,
        triggerable: true,
      };
    }

    const vendorRelays = await this.listVendorAlarmOutputs(camera);
    if (vendorRelays.ok) return vendorRelays;
    if (emptyOnvifResult) return emptyOnvifResult;

    return {
      ok: false,
      message: `Câmera não informou saídas de relé ONVIF. Tentativas: ${errors.slice(0, 4).join(' | ')}`,
      relays: [],
    };
  }

  async setRelayOutputState(camera: Camera, token: string, state: RelayState) {
    const onvifPort = await this.findOnvifPort(camera);
    if (!onvifPort) {
      return { ok: false, message: 'ONVIF unreachable' };
    }

    const auth = this.resolveOnvifCredentials(camera);
    const errors: string[] = [];
    for (const onvifPath of this.candidateDevicePaths(camera.onvifPath)) {
      const result = await this.digestSoapRequest({
        host: camera.ip,
        port: onvifPort,
        path: onvifPath,
        body: this.buildSetRelayOutputStateSoapBody(token, state),
        username: auth.username,
        password: auth.password,
        timeout: 5000,
      });
      if (result.ok) {
        return { ok: true, message: 'ok', onvifPort, onvifPath, token, state };
      }
      errors.push(`${onvifPath}: ${result.message}`);
    }

    return {
      ok: false,
      message: `Relé ONVIF não aceitou estado ${state}. Tentativas: ${errors.slice(0, 4).join(' | ')}`,
      token,
      state,
    };
  }

  async triggerRelayOutput(camera: Camera, token?: string, durationMs?: number) {
    const discovery = await this.listRelayOutputs(camera);
    if (!discovery.ok) {
      return discovery;
    }

    const selectedToken = token?.trim() || discovery.relays[0]?.token;
    if (!selectedToken) {
      return { ok: false, message: 'Nenhuma saída de relé/alarme encontrada nesta câmera.', relays: discovery.relays };
    }

    const selectedRelay = discovery.relays.find((relay) => relay.token === selectedToken);
    if (selectedRelay && 'protocol' in selectedRelay && selectedRelay.protocol === 'cgi') {
      return this.triggerVendorAlarmOutput(camera, selectedToken, durationMs);
    }

    const safeDuration = Math.max(250, Math.min(15000, Number(durationMs ?? 2000)));
    const active = await this.setRelayOutputState(camera, selectedToken, 'active');
    if (!active.ok) return active;

    await new Promise((resolve) => setTimeout(resolve, safeDuration));
    const inactive = await this.setRelayOutputState(camera, selectedToken, 'inactive');
    if (!inactive.ok) {
      return {
        ok: false,
        message: `Relé ativado, mas falhou ao desativar automaticamente: ${inactive.message}`,
        mode: 'relay_trigger',
        durationMs: safeDuration,
        active,
        inactive,
      };
    }

    return {
      ok: true,
      message: 'ok',
      mode: 'relay_trigger',
      durationMs: safeDuration,
      relayToken: selectedToken,
      active,
      inactive,
    };
  }

  async detectPtzEndpoint(input: DetectOnvifInput) {
    const ports = Array.from(new Set([input.onvifPort, ...this.onvifFallbackPorts, 80, 2020].filter((v): v is number => Number.isFinite(v as number))));
    const candidatePaths = this.candidatePaths(input.onvifPath);
    const discoveryByPort: Record<number, Awaited<ReturnType<OnvifPtzService['discoverProfileTokens']>>> = {};

    for (const port of ports) {
      const reachable = await this.portChecker.check(input.ip, port);
      if (!reachable) continue;
      const profileDiscovery = input.username && input.password
        ? await this.discoverProfileTokens({
            host: input.ip,
            port,
            paths: candidatePaths,
            username: input.username,
            password: input.password,
            timeout: 3000,
          })
        : { tokens: [], endpoints: [], errors: [] };
      discoveryByPort[port] = profileDiscovery;
      const candidateTokens = this.candidateProfileTokens(input.onvifProfileToken, undefined, profileDiscovery.tokens);

      for (const path of candidatePaths) {
        for (const token of candidateTokens) {
          if (!input.username || !input.password) {
            continue;
          }
          const body = this.buildSoapBody('stop', undefined, token);
          const result = await this.digestSoapRequest({
            host: input.ip,
            port,
            path,
            body,
            username: input.username,
            password: input.password,
            timeout: 3500,
          });
          if (result.ok) {
            return {
              ok: true,
              protocol: 'onvif',
              onvifPort: port,
              onvifPath: path,
              onvifProfileToken: token,
              discoveredProfileTokens: profileDiscovery.tokens,
              profileEndpoints: profileDiscovery.endpoints,
            };
          }
        }
      }
    }

    if (input.username && input.password && await this.portChecker.check(input.ip, this.proprietaryPtzPort)) {
      const result = await this.digestSoapRequest({
        method: 'GET',
        host: input.ip,
        port: this.proprietaryPtzPort,
        path: '/cgi-bin/ptz.cgi?action=stop&channel=1&code=Up&arg1=0&arg2=1&arg3=0',
        username: input.username,
        password: input.password,
        timeout: 3500,
        contentType: 'text/plain',
      });
      if (result.ok) {
        return {
          ok: true,
          protocol: 'vendor_http',
          onvifPort: this.proprietaryPtzPort,
          onvifPath: '/cgi-bin/ptz.cgi',
          onvifProfileToken: null,
        };
      }
    }

    return {
      ok: false,
      protocol: null,
      onvifPort: input.onvifPort ?? null,
      onvifPath: input.onvifPath ?? null,
      onvifProfileToken: input.onvifProfileToken ?? null,
    };
  }

  async diagnoseCamera(camera: Camera) {
    const auth = this.resolveOnvifCredentials(camera);
    const detection = await this.detectPtzEndpoint({
      ip: camera.ip,
      onvifPort: camera.onvifPort ?? undefined,
      username: auth.username,
      password: auth.password,
      onvifPath: camera.onvifPath ?? undefined,
      onvifProfileToken: camera.onvifProfileToken ?? undefined,
    });

    return {
      cameraId: camera.id,
      ip: camera.ip,
      configured: {
        onvifPort: camera.onvifPort ?? null,
        onvifPath: camera.onvifPath ?? null,
        onvifProfileToken: camera.onvifProfileToken ?? null,
        channel: camera.channel,
      },
      detected: detection,
      discoveredProfiles: detection.ok && 'discoveredProfileTokens' in detection ? detection.discoveredProfileTokens : [],
      ptzLikelyWorking: Boolean(detection.ok),
    };
  }
}
