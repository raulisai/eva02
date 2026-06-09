import { randomUUID } from 'node:crypto';
import { AuditEventType, McpAuditEvent, ToolCallRecord } from './types';

export class McpAuditLog {
  private readonly events: McpAuditEvent[] = [];

  record(input: Omit<McpAuditEvent, 'id' | 'created_at'>): McpAuditEvent {
    const event = { ...input, id: randomUUID(), created_at: new Date().toISOString() };
    this.events.push(event);
    return event;
  }

  list(): McpAuditEvent[] {
    return [...this.events];
  }

  byType(type: AuditEventType): McpAuditEvent[] {
    return this.events.filter((event) => event.type === type);
  }
}

export class ToolCallLogger {
  private readonly calls: ToolCallRecord[] = [];

  record(input: Omit<ToolCallRecord, 'id' | 'created_at'>): ToolCallRecord {
    const call = { ...input, id: randomUUID(), created_at: new Date().toISOString() };
    this.calls.push(call);
    return call;
  }

  list(): ToolCallRecord[] {
    return [...this.calls];
  }
}
