/**
 * Smoke test manual del SandboxService contra Docker REAL.
 * Uso: npx ts-node --transpile-only scripts/sandbox-smoke.ts
 *
 * Valida: sesión persistente por tarea, /work compartido entre python, node y
 * terminal, procesos en background, bloqueo de red por defecto y cleanup.
 * Además (PTY vivo): estado de shell persistente entre pasos, detección de
 * diálogo + terminal_input, terminales multiplexadas e ipython.
 */
import { SandboxService } from '../src/agent/sandbox.service';

async function main() {
  const sandbox = new SandboxService(undefined as never);
  const TASK = `smoke-${Date.now()}`;

  console.log('docker disponible:', await sandbox.dockerAvailable());

  const r1 = await sandbox.execInSession(TASK, {
    kind: 'python',
    code: 'import sys\nopen("/work/x.txt","w").write("hola desde python")\nprint("python ok", sys.version.split()[0])\ntry:\n    import pandas\n    print("pandas", pandas.__version__)\nexcept ImportError:\n    print("pandas no disponible (imagen alpine)")',
  });
  console.log('[1] python escribe /work:', JSON.stringify(r1));

  const r2 = await sandbox.execInSession(TASK, { kind: 'terminal', code: 'cat x.txt && ls -la' });
  console.log('[2] terminal lee el MISMO /work:', JSON.stringify(r2));

  const r3 = await sandbox.execInSession(TASK, {
    kind: 'node',
    code: 'console.log(require("fs").readFileSync("/work/x.txt","utf8") + " → leído desde node")',
  });
  console.log('[3] node comparte workspace:', JSON.stringify(r3));

  await sandbox.execInSession(TASK, { kind: 'terminal', code: 'for i in 1 2 3; do echo tick $i; sleep 0.2; done', background: true });
  await new Promise((r) => setTimeout(r, 2000));
  const r4 = await sandbox.readBackgroundOutput(TASK);
  console.log('[4] background output:', JSON.stringify(r4));

  const r5 = await sandbox.execInSession(TASK, {
    kind: 'python',
    code: 'import urllib.request\ntry:\n    urllib.request.urlopen("http://example.com", timeout=3)\n    print("NET OK (mal: la red deberia estar bloqueada)")\nexcept Exception as e:\n    print("NET BLOCKED:", type(e).__name__)',
  });
  console.log('[5] red bloqueada por defecto:', JSON.stringify(r5));

  // ── PTY vivo: estado de shell persistente entre pasos ──────────────────────
  await sandbox.execInSession(TASK, { kind: 'terminal', code: 'export EVA_SMOKE=42; cd /tmp; echo set' });
  const r6b = await sandbox.execInSession(TASK, { kind: 'terminal', code: 'echo "EVA_SMOKE=$EVA_SMOKE pwd=$(pwd)"' });
  console.log('[6] estado de shell persiste (espera EVA_SMOKE=42 pwd=/tmp):', JSON.stringify(r6b.output));
  if (!r6b.output.includes('EVA_SMOKE=42')) console.error('  ⚠️  el estado de shell NO persistió (¿imagen sin bash/PTY?)');

  // ── Detección de diálogo + terminal_input ──────────────────────────────────
  const r7a = await sandbox.execInSession(TASK, {
    kind: 'terminal',
    code: 'read -p "Confirma? [y/n] " ans; echo "got=$ans"',
  });
  console.log('[7a] diálogo detectado (espera status=awaiting_input):', r7a.status, '|', JSON.stringify(r7a.output));
  const r7b = await sandbox.sendShellInput(TASK, { keyboard: 'y' });
  console.log('[7b] terminal_input completa el comando (espera got=y):', r7b.status, '|', JSON.stringify(r7b.output));

  // ── Terminales multiplexadas (sesiones paralelas) ──────────────────────────
  await sandbox.execInSession(TASK, { kind: 'terminal', code: 'export WHICH=cero', session: 0 });
  await sandbox.execInSession(TASK, { kind: 'terminal', code: 'export WHICH=uno', session: 1 });
  const r8a = await sandbox.execInSession(TASK, { kind: 'terminal', code: 'echo $WHICH', session: 0 });
  const r8b = await sandbox.execInSession(TASK, { kind: 'terminal', code: 'echo $WHICH', session: 1 });
  console.log('[8] shells paralelos aislados (espera cero / uno):', JSON.stringify(r8a.output), '/', JSON.stringify(r8b.output));

  // ── IPython: traceback rico en errores ─────────────────────────────────────
  const r9 = await sandbox.execInSession(TASK, {
    kind: 'python',
    code: 'def f():\n    return 1/0\nprint("antes")\nf()',
  });
  console.log('[9] python error con traceback (ipython si está en la imagen):', JSON.stringify(r9.output), '| exit', r9.exitCode);

  await sandbox.release(TASK);
  console.log('[6] release ok, sesión viva?', sandbox.hasSession(TASK));
  await sandbox.onModuleDestroy();
}

main().catch((err) => {
  console.error('SMOKE FALLÓ:', err);
  process.exit(1);
});
