// Manual mock for socket.io-client.
// After io() is called, fires 'connect' in the next microtask so useEffect
// handlers are registered first. Call triggerEvent() to simulate server→client events.

type Handler = (...args: unknown[]) => void;
let listeners: Record<string, Handler[]> = {};

export const mockSocket = {
  connected: false,
  on: jest.fn((event: string, handler: Handler) => {
    listeners[event] = [...(listeners[event] ?? []), handler];
    return mockSocket;
  }),
  off: jest.fn(),
  emit: jest.fn(),
  disconnect: jest.fn(),
};

export const io = jest.fn(() => {
  // Fire 'connect' asynchronously so all .on() registrations happen first
  Promise.resolve().then(() => {
    mockSocket.connected = true;
    (listeners['connect'] ?? []).forEach(h => h());
  });
  return mockSocket;
});

/** Simulate an incoming server→client event. */
export function triggerEvent(event: string, ...args: unknown[]) {
  (listeners[event] ?? []).forEach(h => h(...args));
}

/** Reset all listeners and call counts between tests. */
export function resetMockSocket() {
  listeners = {};
  mockSocket.connected = false;
  mockSocket.on.mockClear();
  mockSocket.off.mockClear();
  mockSocket.emit.mockClear();
  mockSocket.disconnect.mockClear();
  io.mockClear();
}

export default { io };
