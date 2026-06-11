import { Test } from '@nestjs/testing';
import { CapabilityGateService } from '../capability-gate.service';
import { IntegrationsService } from '../../integrations/integrations.service';

const makeIntegrationsStub = (activeProviders: string[] = []): jest.Mocked<IntegrationsService> => ({
  list: jest.fn().mockImplementation((_orgId, kind) => {
    const rows = activeProviders
      .filter((p) => p.startsWith(`${kind}:`))
      .map((p) => ({ provider: p.split(':')[1], status: 'active' }));
    return Promise.resolve(rows);
  }),
  getSecret: jest.fn().mockResolvedValue(null),
} as unknown as jest.Mocked<IntegrationsService>);

describe('CapabilityGateService', () => {
  let gate: CapabilityGateService;
  let integrations: jest.Mocked<IntegrationsService>;

  async function buildGate(activeProviders: string[] = []) {
    integrations = makeIntegrationsStub(activeProviders);
    const mod = await Test.createTestingModule({
      providers: [
        CapabilityGateService,
        { provide: IntegrationsService, useValue: integrations },
      ],
    }).compile();
    gate = mod.get(CapabilityGateService);
  }

  describe('email capability', () => {
    it('blocks when no google credential is configured', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('revisa mi correo', 'org-1');
      expect(req).not.toBeNull();
      expect(req!.capability).toBe('email');
      expect(req!.setup_type).toBe('oauth');
    });

    it('passes when google credential is active', async () => {
      await buildGate(['credential:google']);
      const req = await gate.firstMissingRequirement('revisa mi correo', 'org-1');
      expect(req).toBeNull();
    });

    it('passes when email channel is active (no google)', async () => {
      await buildGate(['channel:email']);
      const req = await gate.firstMissingRequirement('revisa mi correo', 'org-1');
      expect(req).toBeNull();
    });

    it('passes when google credential is stored as secret', async () => {
      await buildGate([]);
      integrations.getSecret.mockResolvedValueOnce('some-secret');
      const req = await gate.firstMissingRequirement('revisa mi correo', 'org-1');
      expect(req).toBeNull();
    });

    it('matches "revisa mi email"', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('revisa mi email', 'org-1');
      expect(req?.capability).toBe('email');
    });

    it('matches "inbox" keyword', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('muéstrame mi inbox', 'org-1');
      expect(req?.capability).toBe('email');
    });
  });

  describe('calendar capability', () => {
    it('blocks when google credential missing', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('revisa mi calendario', 'org-1');
      expect(req?.capability).toBe('calendar');
    });

    it('passes when google credential active', async () => {
      await buildGate(['credential:google']);
      const req = await gate.firstMissingRequirement('agéndame una cita', 'org-1');
      expect(req).toBeNull();
    });
  });

  describe('whatsapp capability', () => {
    it('blocks when whatsapp channel missing', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('revisa mi whatsapp', 'org-1');
      expect(req?.capability).toBe('whatsapp');
      expect(req?.setup_type).toBe('qr_scan');
      expect(req?.setup_meta?.session_key).toBe('whatsapp_web');
    });

    it('passes when whatsapp channel configured', async () => {
      await buildGate(['channel:whatsapp']);
      const req = await gate.firstMissingRequirement('revisa mi whatsapp', 'org-1');
      expect(req).toBeNull();
    });

    it('matches common misspelling "watsap"', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('revisa mi watsap', 'org-1');
      expect(req?.capability).toBe('whatsapp');
    });
  });

  describe('no-op cases', () => {
    it('returns null for generic questions', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('qué hora es', 'org-1');
      expect(req).toBeNull();
    });

    it('returns null for search requests', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('busca el clima de hoy', 'org-1');
      expect(req).toBeNull();
    });

    it('returns null for coding tasks', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('crea un script en Python para leer CSV', 'org-1');
      expect(req).toBeNull();
    });

    it('returns null for Uber price estimates handled through browser quote flow', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('cuanto cuesta un Uber de Roma Norte a Aeropuerto?', 'org-1');
      expect(req).toBeNull();
    });
  });

  describe('uber capability', () => {
    it('blocks ride-ordering requests when Uber OAuth is missing', async () => {
      await buildGate([]);
      const req = await gate.firstMissingRequirement('pide un Uber a mi casa', 'org-1');
      expect(req?.capability).toBe('uber');
      expect(req?.setup_type).toBe('oauth');
    });
  });

  describe('error resilience', () => {
    it('returns null (pass-through) when integrations service throws', async () => {
      await buildGate([]);
      integrations.list.mockRejectedValue(new Error('DB down'));
      integrations.getSecret.mockRejectedValue(new Error('DB down'));
      // On error, gate should not block (fail open to avoid false positives)
      const req = await gate.firstMissingRequirement('revisa mi correo', 'org-1');
      expect(req).toBeNull();
    });
  });
});
