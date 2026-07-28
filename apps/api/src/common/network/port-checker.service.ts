import { Injectable } from '@nestjs/common';
import { Socket } from 'net';
import { assertCameraTargetAllowed } from './safe-url.helper';

@Injectable()
export class PortCheckerService {
  check(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
    try {
      host = assertCameraTargetAllowed(host, port);
    } catch {
      return Promise.resolve(false);
    }
    return new Promise((resolve) => {
      const socket = new Socket();
      let settled = false;

      const finish = (value: boolean) => {
        if (!settled) {
          settled = true;
          socket.removeAllListeners();
          socket.destroy();
          resolve(value);
        }
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => finish(true));
      socket.once('timeout', () => finish(false));
      socket.once('error', () => finish(false));
      socket.once('close', () => finish(false));

      socket.connect(port, host);
    });
  }
}
