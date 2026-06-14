export type RequestLocationSource =
  | 'browser'
  | 'wear_os'
  | 'telegram'
  | 'device'
  | 'unknown';

export interface RequestLocationContext {
  source: RequestLocationSource;
  latitude: number;
  longitude: number;
  accuracy_m?: number;
  captured_at?: string;
  label?: string;
}

export interface RequestLocationStatus {
  source: RequestLocationSource;
  status: 'granted' | 'denied' | 'unavailable' | 'timeout' | 'error';
  message?: string;
  captured_at?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function numberFrom(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function stringFrom(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function sourceFrom(value: unknown, fallback: RequestLocationSource): RequestLocationSource {
  if (value === 'browser' || value === 'wear_os' || value === 'telegram' || value === 'device') {
    return value;
  }
  return fallback;
}

function isoFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  return undefined;
}

function normalizeLocationRaw(
  raw: unknown,
  fallbackSource: RequestLocationSource,
): RequestLocationContext | null {
  if (!isRecord(raw)) return null;
  const latitude = numberFrom(raw.latitude ?? raw.lat);
  const longitude = numberFrom(raw.longitude ?? raw.lng ?? raw.lon);
  if (
    latitude === null ||
    longitude === null ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    return null;
  }

  const accuracy = numberFrom(raw.accuracy_m ?? raw.accuracyMeters ?? raw.accuracy);
  return {
    source: sourceFrom(raw.source, fallbackSource),
    latitude,
    longitude,
    ...(accuracy !== null && accuracy >= 0 ? { accuracy_m: accuracy } : {}),
    ...(isoFrom(raw.captured_at ?? raw.timestamp ?? raw.recorded_at) ? { captured_at: isoFrom(raw.captured_at ?? raw.timestamp ?? raw.recorded_at) } : {}),
    ...(stringFrom(raw.label ?? raw.address) ? { label: stringFrom(raw.label ?? raw.address) } : {}),
  };
}

function requestContext(metadata: Record<string, unknown> | undefined): Record<string, unknown> | null {
  return isRecord(metadata?.request_context) ? metadata.request_context : null;
}

export function normalizeRequestLocation(
  metadata: Record<string, unknown> | undefined,
  fallbackSource: RequestLocationSource = 'unknown',
): RequestLocationContext | null {
  const ctx = requestContext(metadata);
  return (
    normalizeLocationRaw(ctx?.location, fallbackSource) ??
    normalizeLocationRaw(metadata?.device_location, fallbackSource) ??
    normalizeLocationRaw(metadata?.location, fallbackSource) ??
    normalizeLocationRaw(metadata, fallbackSource)
  );
}

export function requestLocationStatus(
  metadata: Record<string, unknown> | undefined,
  fallbackSource: RequestLocationSource = 'unknown',
): RequestLocationStatus | null {
  const ctx = requestContext(metadata);
  const raw = ctx?.location_status ?? ctx?.location_permission ?? metadata?.location_status;
  if (!isRecord(raw)) return null;
  const status = raw.status ?? raw.permission;
  if (
    status !== 'granted' &&
    status !== 'denied' &&
    status !== 'unavailable' &&
    status !== 'timeout' &&
    status !== 'error'
  ) {
    return null;
  }
  return {
    source: sourceFrom(raw.source, fallbackSource),
    status,
    ...(stringFrom(raw.message ?? raw.reason) ? { message: stringFrom(raw.message ?? raw.reason) } : {}),
    ...(isoFrom(raw.captured_at ?? raw.timestamp) ? { captured_at: isoFrom(raw.captured_at ?? raw.timestamp) } : {}),
  };
}

export function legacyDeviceLocation(location: RequestLocationContext): Record<string, unknown> {
  return {
    latitude: location.latitude,
    longitude: location.longitude,
    ...(location.accuracy_m !== undefined ? { accuracy: location.accuracy_m } : {}),
    ...(location.captured_at ? { timestamp: location.captured_at } : {}),
    source: location.source,
  };
}

export function formatCoordinatePair(location: Pick<RequestLocationContext, 'latitude' | 'longitude'>): string {
  return `${location.latitude.toFixed(6)}, ${location.longitude.toFixed(6)}`;
}
