import { tryParseDirty } from '../json-repair';

describe('tryParseDirty', () => {
  it('parses already-valid JSON', () => {
    expect(tryParseDirty('{"tool":"web_search","args":{"query":"x"}}')).toEqual({
      tool: 'web_search',
      args: { query: 'x' },
    });
  });

  it('strips ```json fences', () => {
    const raw = '```json\n{"tool":"final_answer","args":{"text":"hola"}}\n```';
    expect(tryParseDirty(raw)).toEqual({ tool: 'final_answer', args: { text: 'hola' } });
  });

  it('ignores prose before and after the object', () => {
    const raw = 'Claro, aquí está:\n{"tool":"code_execute","args":{"code":"print(1)"}}\nEso debería funcionar.';
    expect(tryParseDirty(raw)).toEqual({ tool: 'code_execute', args: { code: 'print(1)' } });
  });

  it('removes trailing commas', () => {
    const raw = '{"tool":"terminal_run","args":{"cmd":"ls",},}';
    expect(tryParseDirty(raw)).toEqual({ tool: 'terminal_run', args: { cmd: 'ls' } });
  });

  it('auto-closes a truncated object (interrupted generation)', () => {
    const raw = '{"tool":"final_answer","args":{"text":"respuesta larga incompleta"';
    expect(tryParseDirty(raw)).toEqual({
      tool: 'final_answer',
      args: { text: 'respuesta larga incompleta' },
    });
  });

  it('does not confuse braces inside string values', () => {
    const raw = '{"tool":"code_execute","args":{"code":"print({\\"a\\": 1})"}}';
    expect(tryParseDirty(raw)).toEqual({
      tool: 'code_execute',
      args: { code: 'print({"a": 1})' },
    });
  });

  it('returns null for non-object / unrecoverable input', () => {
    expect(tryParseDirty('no json here at all')).toBeNull();
    expect(tryParseDirty('[1,2,3]')).toBeNull();
    expect(tryParseDirty('')).toBeNull();
  });
});
