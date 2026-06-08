import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayInit,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  MessageBody,
  ConnectedSocket,
} from '@nestjs/websockets';
import { Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import * as jwt from 'jsonwebtoken';
import { EvaEvent } from '../events/event-bus.service';

@WebSocketGateway({
  namespace: '/eva',
  cors: { origin: '*', credentials: true },
})
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  afterInit() {
    this.logger.log('WebSocket gateway initialised at namespace /eva');
  }

  async handleConnection(client: Socket) {
    const token =
      (client.handshake.auth as { token?: string }).token ??
      (client.handshake.headers.authorization ?? '').replace('Bearer ', '');

    if (!token) {
      client.emit('error', { message: 'Missing auth token' });
      client.disconnect(true);
      return;
    }

    try {
      const secret = process.env.SUPABASE_JWT_SECRET ?? '';
      const payload = jwt.verify(token, secret) as Record<string, unknown>;
      const orgId = (payload['app_metadata'] as any)?.org_id as string | undefined;

      if (!orgId) {
        client.emit('error', { message: 'Token missing org_id in app_metadata' });
        client.disconnect(true);
        return;
      }

      // Join org-scoped room so only org members receive events
      await client.join(`org:${orgId}`);
      (client.data as any).orgId = orgId;
      (client.data as any).userId = payload['sub'];

      this.logger.debug(`Client ${client.id} joined org:${orgId}`);
      client.emit('connected', { orgId });
    } catch {
      client.emit('error', { message: 'Invalid token' });
      client.disconnect(true);
    }
  }

  handleDisconnect(client: Socket) {
    this.logger.debug(`Client ${client.id} disconnected`);
  }

  /** Broadcast an EVA event to all members of an org room. */
  emitToOrg(orgId: string, event: EvaEvent) {
    this.server.to(`org:${orgId}`).emit(event.type, {
      taskId: event.taskId,
      payload: event.payload,
      ts: event.ts,
    });
  }

  /** Ping/pong for liveness checks from dashboard. */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket, @MessageBody() _data: unknown) {
    client.emit('pong', { ts: Date.now() });
  }
}
