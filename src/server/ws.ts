import {WebSocketServer, WebSocket} from 'ws';
import type {IncomingMessage} from 'node:http';
import {verifyAccessToken} from './crypto';

interface ConnectedClient {
  ws: WebSocket;
  userId: number;
  role: 'SUPER_ADMIN' | 'ADMIN' | 'USER';
}

class NotificationHub {
  private wss: WebSocketServer | null = null;
  private clients = new Set<ConnectedClient>();

  init(): WebSocketServer {
    if (this.wss) return this.wss;
    this.wss = new WebSocketServer({noServer: true});
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      const url = new URL(req.url || '/', 'http://localhost');
      const token = url.searchParams.get('token') || '';
      const decoded = verifyAccessToken(token);
      if (!decoded) {
        ws.close(4001, 'Unauthorized');
        return;
      }

      const client: ConnectedClient = {
        ws,
        userId: decoded.sub,
        role: decoded.role,
      };
      this.clients.add(client);

      ws.send(
        JSON.stringify({
          event: 'connected',
          userId: decoded.sub,
          role: decoded.role,
        }),
      );

      ws.on('close', () => {
        this.clients.delete(client);
      });
      ws.on('error', () => {
        this.clients.delete(client);
      });
    });
    return this.wss;
  }

  getServer(): WebSocketServer {
    return this.init();
  }

  pushToUser(userId: number, payload: Record<string, unknown>): void {
    const msg = JSON.stringify(payload);
    for (const c of this.clients) {
      if (c.userId === userId && c.ws.readyState === WebSocket.OPEN) {
        c.ws.send(msg);
      }
    }
  }

  pushToAdmins(payload: Record<string, unknown>): void {
    const msg = JSON.stringify(payload);
    for (const c of this.clients) {
      if (
        (c.role === 'ADMIN' || c.role === 'SUPER_ADMIN') &&
        c.ws.readyState === WebSocket.OPEN
      ) {
        c.ws.send(msg);
      }
    }
  }
}

export const notificationHub = new NotificationHub();
