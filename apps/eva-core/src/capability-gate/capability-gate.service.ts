import { Injectable, Logger } from '@nestjs/common';
import { IntegrationsService } from '../integrations/integrations.service';
import { IntegrationRef, CapabilityRequirement } from './capability-gate.types';
import { CAPABILITY_CATALOG } from './capability-catalog';

@Injectable()
export class CapabilityGateService {
  private readonly logger = new Logger(CapabilityGateService.name);

  constructor(private readonly integrations: IntegrationsService) {}

  /**
   * Returns the first capability requirement that the user is requesting
   * but does not have configured. Returns null if all required integrations
   * are present (or the input matches nothing in the catalog).
   *
   * We check each matching catalog entry in order and return the first
   * unmet one — the caller handles it and stops the pipeline.
   */
  async firstMissingRequirement(
    input: string,
    orgId: string,
  ): Promise<CapabilityRequirement | null> {
    const normalized = input.toLowerCase();

    for (const entry of CAPABILITY_CATALOG) {
      if (!entry.pattern.test(normalized)) continue;

      const configured = await this.isAnyIntegrationActive(orgId, entry.requirement.integrations);
      if (!configured) {
        this.logger.log(
          `Capability gate blocked: "${entry.requirement.capability}" not configured for org ${orgId}`,
        );
        return entry.requirement;
      }
    }

    return null;
  }

  /**
   * Returns true if at least one of the listed integrations is present
   * and active for the org.
   */
  private async isAnyIntegrationActive(orgId: string, refs: IntegrationRef[]): Promise<boolean> {
    for (const ref of refs) {
      try {
        const list = await this.integrations.list(orgId, ref.kind);
        const found = list.find(
          (i) => i.provider === ref.provider && i.status === 'active',
        );
        if (found) return true;

        // Also check if there is a stored secret (secret-only configs may have
        // status='active' implied by the presence of the secret).
        const secret = await this.integrations.getSecret(orgId, ref.kind, ref.provider);
        if (secret) return true;
      } catch (err) {
        this.logger.warn(
          `Capability gate: error checking ${ref.kind}:${ref.provider} for org ${orgId}`,
          err,
        );
        // On error, assume configured to avoid false positives.
        return true;
      }
    }
    return false;
  }
}
