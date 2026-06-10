import { IntegrationKind } from '../integrations/integrations.types';

export type SetupType = 'oauth' | 'api_key' | 'bot_token' | 'qr_scan';

export interface IntegrationRef {
  kind: IntegrationKind;
  provider: string;
}

export interface CapabilityRequirement {
  /** Stable identifier for this capability */
  capability: string;
  /** What EVA says immediately (replaces the generic ACK) */
  ack_message: string;
  /** Full explanation shown to the user in the setup card */
  user_message: string;
  /** Label for the action button in the frontend */
  setup_label: string;
  /** Ordered list of integrations to check — first active one satisfies the requirement */
  integrations: IntegrationRef[];
  /** How the user completes setup */
  setup_type: SetupType;
  /**
   * For setup_type='oauth': the OAuth scope set required.
   * For setup_type='qr_scan': the browser session key (e.g. 'whatsapp_web').
   * Optional metadata for the frontend.
   */
  setup_meta?: Record<string, unknown>;
}

/** Emitted as task.setup_required payload */
export interface SetupRequiredPayload extends Record<string, unknown> {
  capability: string;
  setup_type: SetupType;
  setup_label: string;
  message: string;
  integrations: IntegrationRef[];
  setup_meta?: Record<string, unknown>;
}
