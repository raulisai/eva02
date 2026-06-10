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
import { Injectable, Logger } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EvaEvent } from '../events/event-bus.service';
import { DatabaseService } from '../database/database.service';

@Injectable()
@WebSocketGateway({
  namespace: '/eva',
  cors: { origin: '*', credentials: true },
})
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  constructor(private readonly db: DatabaseService) {}

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
      // Use Supabase auth.getUser() — handles ES256/HS256 automatically
      const { data: { user }, error: authError } = await this.db.forUser(token).auth.getUser();

      if (authError || !user) {
        this.logger.warn(`handleConnection rejected: ${authError?.message ?? 'no user'}`);
        client.emit('error', { message: 'Invalid token' });
        client.disconnect(true);
        return;
      }

      // Look up org_id from users table
      const { data, error: dbError } = await this.db.admin
        .from('users')
        .select('org_id')
        .eq('id', user.id)
        .limit(1)
        .single();

      if (dbError || !data?.org_id) {
        client.emit('error', { message: 'User has no org membership' });
        client.disconnect(true);
        return;
      }

      const orgId = data.org_id as string;

      await client.join(`org:${orgId}`);
      (client.data as any).orgId = orgId;
      (client.data as any).userId = user.id;

      this.logger.log(`Client ${client.id} joined org:${orgId}`);
      client.emit('connected', { orgId });
    } catch (err) {
      this.logger.warn(`handleConnection rejected: ${(err as Error).message}`);
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

  /** Send a command to org-scoped nodes; nodes must verify target nodeId locally. */
  emitNodeCommand(orgId: string, payload: Record<string, unknown>) {
    this.server.to(`org:${orgId}`).emit('node.command', payload);
  }

  /** Ping/pong for liveness checks from dashboard. */
  @SubscribeMessage('ping')
  handlePing(@ConnectedSocket() client: Socket, @MessageBody() _data: unknown) {
    client.emit('pong', { ts: Date.now() });
  }
}
