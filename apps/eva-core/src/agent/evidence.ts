/**
 * Detección de petición explícita de evidencia visual o de fuentes.
 *
 * Las capturas de pantalla / imágenes SOLO se envían al usuario cuando él las
 * pide ("mándame la captura", "quiero evidencia", "pásame las fuentes").
 * El flujo normal (enviar un mensaje, leer un chat) responde con texto.
 */
export const WANTS_EVIDENCE_RE =
  /\b(captura|pantallazo|screenshot|evidencia|comprobante|foto|imagen|prueba|fuentes?)\b/i;

export function wantsEvidence(text: string | null | undefined): boolean {
  return !!text && WANTS_EVIDENCE_RE.test(text);
}
