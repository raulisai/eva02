/**
 * SkillGuard — escáner estático para skills generadas por el agente.
 * Port acotado del skills_guard de hermes-agent (nousresearch/hermes-agent):
 * regex sobre el código ANTES de registrarlo como skill reutilizable.
 *
 * Contexto EVA: el sandbox corre sin red y read-only, así que el riesgo real
 * es una skill guardada hoy que se re-ejecute mañana con red aprobada
 * (sandbox.network_exec) o cuyo texto envenene prompts futuros. El gate vive
 * en el registro (SkillLibraryService.register), no en la ejecución.
 *
 * Política (espejo del INSTALL_POLICY "agent-created" de hermes):
 *   safe → registrar · caution → registrar con findings en metadata ·
 *   dangerous → bloquear (el loop puede reintentar sin el contenido marcado).
 */

export type SkillVerdict = 'safe' | 'caution' | 'dangerous';

export interface SkillGuardFinding {
  pattern_id: string;
  severity: 'critical' | 'high';
  category: 'exfiltration' | 'injection' | 'destructive' | 'obfuscation';
  description: string;
}

export interface SkillScan {
  verdict: SkillVerdict;
  findings: SkillGuardFinding[];
}

type Pattern = [RegExp, string, 'critical' | 'high', SkillGuardFinding['category'], string];

const THREAT_PATTERNS: Pattern[] = [
  // ── Exfiltración: secrets hacia la red ─────────────────────────────────
  [/\b(curl|wget)\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i,
    'env_exfil_shell', 'critical', 'exfiltration', 'curl/wget interpolando una variable secreta'],
  [/\b(fetch|axios\.\w+|requests\.(get|post|put|patch)|httpx?\.(get|post|put|patch))\s*\([^\n]*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/,
    'env_exfil_http', 'critical', 'exfiltration', 'llamada HTTP con variable secreta'],
  // El alias §§secret(...) embebido en una URL es exfiltración del valor resuelto.
  [/https?:\/\/[^\s"'\n]*§§secret\(/,
    'secret_alias_in_url', 'critical', 'exfiltration', 'alias §§secret(...) dentro de una URL'],

  // ── Exfiltración: lectura de credenciales del host ─────────────────────
  [/(\$HOME|~)\/\.(ssh|aws|gnupg|kube|docker|netrc)\b/,
    'cred_dir_access', 'high', 'exfiltration', 'referencia a directorio de credenciales del host'],
  [/\bcat\s+(?!>)[^\n]*(\.env\b|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/,
    'read_secrets_file', 'critical', 'exfiltration', 'lee un archivo de secrets conocido'],
  [/\b(printenv|env\s*\|)/,
    'dump_all_env', 'high', 'exfiltration', 'vuelca todas las variables de entorno'],
  [/os\.environ\s*(?!\.get\s*\()/,
    'python_environ_dump', 'high', 'exfiltration', 'acceso a os.environ completo (posible dump)'],
  [/JSON\.stringify\s*\(\s*process\.env\s*\)|console\.log\s*\(\s*process\.env\s*\)/,
    'node_env_dump', 'critical', 'exfiltration', 'vuelca process.env completo'],

  // ── Destructivo ─────────────────────────────────────────────────────────
  [/\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)[a-z]*\s+(\/|~\/|\$HOME)(\s|$)/,
    'rm_rf_root', 'critical', 'destructive', 'rm -rf sobre raíz o $HOME'],
  [/\b(mkfs|fdisk|parted)\b|\bdd\s+[^\n]*of=\/dev\//,
    'disk_destruction', 'critical', 'destructive', 'operación destructiva de disco'],
  [/:\(\)\s*\{\s*:\|:/,
    'fork_bomb', 'critical', 'destructive', 'fork bomb'],
  [/\b(shutdown|reboot|halt|poweroff)\b/,
    'host_power', 'high', 'destructive', 'apaga o reinicia el host'],

  // ── Inyección de prompt (el texto de una skill se reinyecta a futuros prompts) ──
  [/ignor(e|a)\s+(\w+\s+)*(previous|all|above|prior|las|todas las)\s+(instructions|instrucciones)/i,
    'prompt_injection_ignore', 'critical', 'injection', 'inyección: ignorar instrucciones previas'],
  [/\b(do\s+not|don'?t|no\s+le)\s+(\w+\s+)*(tell|digas?|cuentes?)\s+(\w+\s+)*(the\s+user|al?\s+usuario)/i,
    'deception_hide', 'critical', 'injection', 'pide ocultar información al usuario'],
  [/\b(disregard|olvida|desobedece)\s+(\w+\s+)*(your|tus|las)\s+(\w+\s+)*(instructions|rules|reglas|instrucciones)/i,
    'disregard_rules', 'critical', 'injection', 'pide desobedecer las reglas del agente'],

  // ── Ofuscación ──────────────────────────────────────────────────────────
  [/base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash|python|node)/,
    'b64_pipe_exec', 'critical', 'obfuscation', 'decodifica base64 y lo ejecuta'],
  [/\b(eval|exec)\s*\(\s*(atob|base64|Buffer\.from\s*\([^\n]*['"]base64)/,
    'eval_decoded', 'critical', 'obfuscation', 'eval/exec sobre contenido decodificado'],
];

/**
 * Escanea código + descripción de una skill candidata.
 * Heurístico, no frontera de seguridad dura (igual que en hermes): el sandbox
 * sigue siendo el aislamiento real; esto evita sedimentar payloads obvios.
 */
export function scanSkillCode(code: string, description = ''): SkillScan {
  const text = `${code}\n${description}`;
  const findings: SkillGuardFinding[] = [];
  for (const [regex, pattern_id, severity, category, desc] of THREAT_PATTERNS) {
    if (regex.test(text)) findings.push({ pattern_id, severity, category, description: desc });
  }
  const verdict: SkillVerdict = findings.some((f) => f.severity === 'critical')
    ? 'dangerous'
    : findings.length > 0 ? 'caution' : 'safe';
  return { verdict, findings };
}

/** Política agent-created: solo "dangerous" bloquea el registro. */
export function shouldBlockAgentSkill(scan: SkillScan): boolean {
  return scan.verdict === 'dangerous';
}

/** Resumen de findings en una línea para observaciones/logs. */
export function formatScanSummary(scan: SkillScan): string {
  if (scan.findings.length === 0) return 'sin hallazgos';
  return scan.findings.map((f) => `${f.pattern_id} (${f.severity}): ${f.description}`).join('; ');
}
