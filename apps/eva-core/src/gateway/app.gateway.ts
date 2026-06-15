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
import { Injectable, Logger, Optional } from '@nestjs/common';
import { Server, Socket } from 'socket.io';
import { EvaEvent } from '../events/event-bus.service';
import { DatabaseService } from '../database/database.service';
import { SandboxService } from '../agent/sandbox.service';

@Injectable()
@WebSocketGateway({
  namespace: '/eva',
  cors: { origin: '*', credentials: true },
})
export class AppGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(AppGateway.name);

  private readonly sandboxSessions = new Map<string, () => void>(); // socketId → unsubscribe

  constructor(
    private readonly db: DatabaseService,
    @Optional() private readonly sandbox?: SandboxService,
  ) {}

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
    const unsub = this.sandboxSessions.get(client.id);
    if (unsub) { unsub(); this.sandboxSessions.delete(client.id); }
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

  /**
   * Attach to an agent's sandbox PTY.
   * Client sends: { taskId: string, shellNum?: number }
   * Server streams back: 'sandbox.output' events with { data: string }
   */
  @SubscribeMessage('sandbox.attach')
  handleSandboxAttach(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { taskId: string; shellNum?: number },
  ) {
    if (!this.sandbox) {
      client.emit('sandbox.error', { message: 'Sandbox no disponible' });
      return;
    }

    // Detach any previous session
    const prev = this.sandboxSessions.get(client.id);
    if (prev) prev();

    const stream = this.sandbox.attachShellStream(payload.taskId, payload.shellNum ?? 0);
    if (!stream) {
      client.emit('sandbox.error', { message: `No hay sesión de sandbox activa para task ${payload.taskId}` });
      return;
    }

    // Send buffer snapshot immediately for initial paint
    if (stream.initialBuffer) {
      client.emit('sandbox.output', { data: stream.initialBuffer, initial: true });
    }

    // Stream live output
    const unsub = stream.subscribe((chunk) => {
      client.emit('sandbox.output', { data: chunk });
    });

    this.sandboxSessions.set(client.id, unsub);
    client.emit('sandbox.attached', { taskId: payload.taskId });
  }

  /** Send raw input to the attached sandbox PTY. */
  @SubscribeMessage('sandbox.input')
  handleSandboxInput(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: { taskId: string; data: string; shellNum?: number },
  ) {
    if (!this.sandbox) return;
    const stream = this.sandbox.attachShellStream(payload.taskId, payload.shellNum ?? 0);
    stream?.write(payload.data);
  }

  /** Detach from sandbox PTY. */
  @SubscribeMessage('sandbox.detach')
  handleSandboxDetach(@ConnectedSocket() client: Socket) {
    const unsub = this.sandboxSessions.get(client.id);
    if (unsub) { unsub(); this.sandboxSessions.delete(client.id); }
    client.emit('sandbox.detached', {});
  }
}
