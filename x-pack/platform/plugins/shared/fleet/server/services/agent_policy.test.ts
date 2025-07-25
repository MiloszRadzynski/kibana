/*
 * Copyright Elasticsearch B.V. and/or licensed to Elasticsearch B.V. under one
 * or more contributor license agreements. Licensed under the Elastic License
 * 2.0; you may not use this file except in compliance with the Elastic License
 * 2.0.
 */
import type { savedObjectsClientMock } from '@kbn/core/server/mocks';
import { elasticsearchServiceMock } from '@kbn/core/server/mocks';
import { securityMock } from '@kbn/security-plugin/server/mocks';
import { loggerMock } from '@kbn/logging-mocks';
import type { Logger } from '@kbn/core/server';
import type { SavedObjectError } from '@kbn/core-saved-objects-common';

import { createSavedObjectClientMock } from '../mocks';

import { LEGACY_PACKAGE_POLICY_SAVED_OBJECT_TYPE } from '../../common/constants';

import {
  PackagePolicyRestrictionRelatedError,
  FleetUnauthorizedError,
  HostedAgentPolicyRestrictionRelatedError,
  AgentPolicyInvalidError,
} from '../errors';
import type {
  AgentPolicy,
  FullAgentPolicy,
  NewAgentPolicy,
  PreconfiguredAgentPolicy,
} from '../types';
import {
  LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
  AGENT_POLICY_SAVED_OBJECT_TYPE,
} from '../constants';

import { AGENT_POLICY_INDEX, SO_SEARCH_LIMIT } from '../../common';

import { agentPolicyService } from './agent_policy';
import { agentPolicyUpdateEventHandler } from './agent_policy_update';

import { getAgentsByKuery } from './agents';
import { getPackagePolicySavedObjectType, packagePolicyService } from './package_policy';
import { appContextService } from './app_context';
import { outputService } from './output';
import { downloadSourceService } from './download_source';
import { getFullAgentPolicy } from './agent_policies';
import * as outputsHelpers from './agent_policies/outputs_helpers';
import { auditLoggingService } from './audit_logging';
import { licenseService } from './license';
import type { UninstallTokenServiceInterface } from './security/uninstall_token_service';
import { isSpaceAwarenessEnabled } from './spaces/helpers';
import { scheduleDeployAgentPoliciesTask } from './agent_policies/deploy_agent_policies_task';

jest.mock('./spaces/helpers');

function getSavedObjectMock(agentPolicyAttributes: any) {
  const mock = createSavedObjectClientMock();
  const mockPolicy = {
    type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
    references: [],
    attributes: agentPolicyAttributes as AgentPolicy,
  };
  mock.get.mockImplementation(async (type: string, id: string) => {
    return {
      id,
      ...mockPolicy,
    };
  });
  mock.bulkGet.mockImplementation(async (options) => {
    return {
      saved_objects: options.map(({ id }) => {
        return {
          id,
          ...mockPolicy,
        };
      }),
    };
  });
  mock.find.mockImplementation(async (options) => {
    switch (options.type) {
      case LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE:
        return {
          saved_objects: [
            {
              id: 'agent-policy-id',
              score: 1,
              ...mockPolicy,
            },
          ],
          total: 1,
          page: 1,
          per_page: 1,
        };
      case LEGACY_PACKAGE_POLICY_SAVED_OBJECT_TYPE:
        return {
          saved_objects: [],
          total: 0,
          page: 1,
          per_page: 1,
        };
      default:
        return {
          saved_objects: [
            {
              id: '93f74c0-e876-11ea-b7d3-8b2acec6f75c',
              attributes: {
                fleet_server_hosts: ['http://fleetserver:8220'],
              },
              type: 'ingest_manager_settings',
              score: 1,
              references: [],
            },
          ],
          total: 1,
          page: 1,
          per_page: 1,
        };
    }
  });

  return mock;
}

jest.mock('./output');
jest.mock('./download_source');
jest.mock('./agent_policy_update');
jest.mock('./agents');
jest.mock('./package_policy');
jest.mock('./app_context');
jest.mock('./audit_logging');
jest.mock('./agent_policies/full_agent_policy');
jest.mock('./agent_policies/outputs_helpers');
jest.mock('./agent_policies/deploy_agent_policies_task');

const mockedAppContextService = appContextService as jest.Mocked<typeof appContextService>;
mockedAppContextService.getSecuritySetup.mockImplementation(() => ({
  ...securityMock.createSetup(),
}));

const mockedAuditLoggingService = auditLoggingService as jest.Mocked<typeof auditLoggingService>;
const mockOutputsHelpers = outputsHelpers as jest.Mocked<typeof outputsHelpers>;
const mockedOutputService = outputService as jest.Mocked<typeof outputService>;
const mockedDownloadSourceService = downloadSourceService as jest.Mocked<
  typeof downloadSourceService
>;
const mockedPackagePolicyService = packagePolicyService as jest.Mocked<typeof packagePolicyService>;

const mockedGetFullAgentPolicy = getFullAgentPolicy as jest.Mock<
  ReturnType<typeof getFullAgentPolicy>
>;

function getAgentPolicyCreateMock() {
  const soClient = createSavedObjectClientMock();
  soClient.create.mockImplementation(async (type, attributes) => {
    return {
      attributes: attributes as unknown as NewAgentPolicy,
      id: 'mocked',
      type: 'mocked',
      references: [],
    };
  });
  return soClient;
}
let mockedLogger: jest.Mocked<Logger>;

describe('Agent policy', () => {
  beforeEach(() => {
    mockedLogger = loggerMock.create();
    mockedAppContextService.getLogger.mockReturnValue(mockedLogger);
    mockedAppContextService.getExperimentalFeatures.mockReturnValue({} as any);
    jest.mocked(isSpaceAwarenessEnabled).mockResolvedValue(false);
    jest
      .mocked(getPackagePolicySavedObjectType)
      .mockResolvedValue(LEGACY_PACKAGE_POLICY_SAVED_OBJECT_TYPE);
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe('create', () => {
    it('is_managed present and false by default', async () => {
      const soClient = getAgentPolicyCreateMock();
      // ignore unrelated unique name constraint
      agentPolicyService.requireUniqueName = async () => {};
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'No is_managed provided',
          namespace: 'default',
        })
      ).resolves.toHaveProperty('is_managed', false);

      const [, attributes] = soClient.create.mock.calls[0];
      expect(attributes).toHaveProperty('is_managed', false);
    });

    it('should set is_managed property, if given', async () => {
      // ignore unrelated unique name constraint
      agentPolicyService.requireUniqueName = async () => {};
      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'is_managed: true provided',
          namespace: 'default',
          is_managed: true,
        })
      ).resolves.toHaveProperty('is_managed', true);

      const [, attributes] = soClient.create.mock.calls[0];
      expect(attributes).toHaveProperty('is_managed', true);
    });

    it('should call audit logger', async () => {
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      const soClient = createSavedObjectClientMock();

      soClient.find.mockResolvedValueOnce({
        total: 0,
        saved_objects: [],
        per_page: 0,
        page: 1,
      });

      soClient.create.mockResolvedValueOnce({
        id: 'test-agent-policy',
        type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
        attributes: {
          name: 'test',
        },
        references: [],
      });

      mockOutputsHelpers.validateOutputForPolicy.mockResolvedValueOnce(undefined);

      await agentPolicyService.create(
        soClient,
        esClient,
        {
          name: 'test',
          namespace: 'default',
        },
        { id: 'test-agent-policy' }
      );

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenCalledWith({
        action: 'create',
        name: 'test',
        id: 'test-agent-policy',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });

    it('should write to the correct saved object-type if user opt-in for space awerness', async () => {
      jest.mocked(isSpaceAwarenessEnabled).mockResolvedValue(true);
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      const soClient = createSavedObjectClientMock();

      soClient.find.mockResolvedValueOnce({
        total: 0,
        saved_objects: [],
        per_page: 0,
        page: 1,
      });

      soClient.create.mockResolvedValueOnce({
        id: 'test-agent-policy',
        type: AGENT_POLICY_SAVED_OBJECT_TYPE,
        attributes: {},
        references: [],
      });

      mockOutputsHelpers.validateOutputForPolicy.mockResolvedValueOnce(undefined);

      await agentPolicyService.create(
        soClient,
        esClient,
        {
          name: 'test',
          namespace: 'default',
        },
        { id: 'test-agent-policy' }
      );
      expect(soClient.create).toBeCalledWith(
        AGENT_POLICY_SAVED_OBJECT_TYPE,
        expect.anything(),
        expect.anything()
      );
      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenCalledWith({
        action: 'create',
        id: 'test-agent-policy',
        name: 'test',
        savedObjectType: AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });

    it('should throw FleetUnauthorizedError if is_protected=true with insufficient license', async () => {
      jest.spyOn(licenseService, 'hasAtLeast').mockReturnValue(false);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'test',
          namespace: 'default',
          is_protected: true,
        })
      ).rejects.toThrowError(
        new FleetUnauthorizedError('Tamper protection requires Platinum license')
      );
    });

    it('should not throw FleetUnauthorizedError if is_protected=false with insufficient license', async () => {
      jest.spyOn(licenseService, 'hasAtLeast').mockReturnValue(false);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'test',
          namespace: 'default',
        })
      ).resolves.not.toThrowError(
        new FleetUnauthorizedError('Tamper protection requires Platinum license')
      );
    });

    it('should throw AgentPolicyInvalidError if support_agentless is defined in stateful without agentless enabled', async () => {
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: false } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).rejects.toThrowError(
        new AgentPolicyInvalidError(
          'supports_agentless is only allowed in serverless and cloud environments that support the agentless feature'
        )
      );
    });

    it('should throw AgentPolicyInvalidError if agentless is disabled in serverless', async () => {
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: true } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).rejects.toThrowError(
        new AgentPolicyInvalidError(
          'supports_agentless is only allowed in serverless and cloud environments that support the agentless feature'
        )
      );
    });

    it('should create an agentless policy when agentless config is set and in serverless env', async () => {
      jest
        .spyOn(appContextService, 'getConfig')
        .mockReturnValue({ agentless: { enabled: true } } as any);
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: true } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.find.mockResolvedValueOnce({
        total: 0,
        saved_objects: [],
        per_page: 0,
        page: 1,
      });

      const res = await agentPolicyService.create(soClient, esClient, {
        name: 'test',
        namespace: 'default',
        supports_agentless: true,
      });
      expect(res).toEqual({
        id: 'mocked',
        name: 'test',
        namespace: 'default',
        supports_agentless: true,
        status: 'active',
        is_managed: false,
        revision: 1,
        updated_at: expect.anything(),
        updated_by: 'system',
        schema_version: '1.1.1',
        is_protected: false,
        fleet_server_host_id: 'default-fleet-server',
      });
    });

    it('should create a policy if agentless feature flag is set and in cloud env', async () => {
      jest.spyOn(appContextService, 'getCloud').mockReturnValue({ isCloudEnabled: true } as any);
      jest.spyOn(appContextService, 'getConfig').mockReturnValue({
        agentless: { enabled: true },
      } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.find.mockResolvedValueOnce({
        total: 0,
        saved_objects: [],
        per_page: 0,
        page: 1,
      });

      const res = await agentPolicyService.create(soClient, esClient, {
        name: 'test',
        namespace: 'default',
        supports_agentless: true,
      });
      expect(res).toEqual({
        id: 'mocked',
        name: 'test',
        namespace: 'default',
        supports_agentless: true,
        status: 'active',
        is_managed: false,
        revision: 1,
        updated_at: expect.anything(),
        updated_by: 'system',
        schema_version: '1.1.1',
        is_protected: false,
        fleet_server_host_id: 'fleet-default-fleet-server-host',
      });
    });

    it('should create an agentless policy with a fallback fleet_server_host_id if not provided', async () => {
      jest
        .spyOn(appContextService, 'getConfig')
        .mockReturnValue({ agentless: { enabled: true } } as any);
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: true } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.find.mockResolvedValueOnce({
        total: 0,
        saved_objects: [],
        per_page: 0,
        page: 1,
      });

      const res = await agentPolicyService.create(soClient, esClient, {
        name: 'test',
        namespace: 'default',
        supports_agentless: true,
      });
      expect(res).toEqual({
        id: 'mocked',
        name: 'test',
        namespace: 'default',
        supports_agentless: true,
        status: 'active',
        is_managed: false,
        revision: 1,
        updated_at: expect.anything(),
        updated_by: 'system',
        schema_version: '1.1.1',
        is_protected: false,
        fleet_server_host_id: 'default-fleet-server',
      });
    });

    it('should throw error when attempting to create policy with supports_agentless true on cloud environment that does not support the agentless feature', async () => {
      jest.spyOn(appContextService, 'getConfig').mockReturnValue({
        agentless: { enabled: false },
      } as any);

      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isCloudEnabled: true, isServerlessEnabled: false } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).rejects.toThrowError(
        new AgentPolicyInvalidError(
          'supports_agentless is only allowed in serverless and cloud environments that support the agentless feature'
        )
      );
    });

    it('should throw error when attempting to create policy with supports_agentless true on serverless environment that does not support the agentless feature', async () => {
      jest
        .spyOn(appContextService, 'getExperimentalFeatures')
        .mockReturnValue({ agentless: false } as any);

      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isCloudEnabled: false, isServerlessEnabled: true } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await expect(
        agentPolicyService.create(soClient, esClient, {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).rejects.toThrowError(
        new AgentPolicyInvalidError(
          'supports_agentless is only allowed in serverless and cloud environments that support the agentless feature'
        )
      );
    });
  });

  // TODO: Add more test coverage to `get` service method
  describe('get', () => {
    it('should call audit logger', async () => {
      const soClient = createSavedObjectClientMock();

      soClient.bulkGet.mockResolvedValueOnce({
        saved_objects: [
          {
            id: 'test-agent-policy',
            attributes: {
              name: 'Test',
            },
            references: [],
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
          },
        ],
      });

      await agentPolicyService.get(soClient, 'test-agent-policy', false);

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toBeCalledWith({
        action: 'get',
        id: 'test-agent-policy',
        name: 'Test',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });
  });

  describe('getByIds', () => {
    it('should call audit logger', async () => {
      const soClient = createSavedObjectClientMock();

      soClient.bulkGet.mockResolvedValueOnce({
        saved_objects: [
          {
            id: 'test-agent-policy-1',
            attributes: {
              name: 'Test 1',
            },
            references: [],
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
          },
          {
            id: 'test-agent-policy-2',
            attributes: {
              name: 'Test 2',
            },
            references: [],
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
          },
        ],
      });

      await agentPolicyService.getByIds(soClient, ['test-agent-policy-1', 'test-agent-policy-2']);

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenNthCalledWith(1, {
        action: 'get',
        id: 'test-agent-policy-1',
        name: 'Test 1',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenNthCalledWith(2, {
        action: 'get',
        id: 'test-agent-policy-2',
        name: 'Test 2',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });
  });

  describe('list', () => {
    it('should call audit logger', async () => {
      const soClient = createSavedObjectClientMock();

      soClient.find.mockResolvedValueOnce({
        total: 2,
        saved_objects: [
          {
            id: 'test-agent-policy-1',
            attributes: {
              name: 'Test 1',
            },
            references: [],
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
            score: 0,
          },
          {
            id: 'test-agent-policy-2',
            attributes: {
              name: 'Test 2',
            },
            references: [],
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
            score: 0,
          },
        ],
        per_page: 0,
        page: 1,
      });

      await agentPolicyService.list(soClient, {
        page: 1,
        perPage: 10,
        kuery: '',
      });

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenNthCalledWith(1, {
        action: 'find',
        id: 'test-agent-policy-1',
        name: 'Test 1',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenNthCalledWith(2, {
        action: 'find',
        id: 'test-agent-policy-2',
        name: 'Test 2',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });
  });

  describe('delete', () => {
    let soClient: ReturnType<typeof savedObjectsClientMock.create>;
    let esClient: ReturnType<typeof elasticsearchServiceMock.createClusterClient>['asInternalUser'];

    beforeEach(() => {
      soClient = getSavedObjectMock({ revision: 1, name: 'Test', package_policies: ['package-1'] });
      mockedPackagePolicyService.findAllForAgentPolicy.mockReturnValue([
        {
          id: 'package-1',
        },
      ] as any);
      esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      (getAgentsByKuery as jest.Mock).mockResolvedValue({
        agents: [],
        total: 0,
        page: 1,
        perPage: 10,
      });
      mockedPackagePolicyService.create.mockReset();
    });

    it('should throw error for agent policy which has managed package policy', async () => {
      mockedPackagePolicyService.findAllForAgentPolicy.mockReturnValue([
        {
          id: 'package-1',
          is_managed: true,
        },
      ] as any);
      try {
        await agentPolicyService.delete(soClient, esClient, 'mocked');
      } catch (e) {
        expect(e.message).toEqual(
          new PackagePolicyRestrictionRelatedError(
            `Cannot delete agent policy mocked that contains managed package policies`
          ).message
        );
      }
    });

    it('should allow delete with force for agent policy which has managed package policy', async () => {
      mockedPackagePolicyService.findAllForAgentPolicy.mockReturnValue([
        {
          id: 'package-1',
          is_managed: true,
        },
      ] as any);
      const response = await agentPolicyService.delete(soClient, esClient, 'mocked', {
        force: true,
      });
      expect(response.id).toEqual('mocked');
    });

    it('should call audit logger', async () => {
      await agentPolicyService.delete(soClient, esClient, 'mocked');

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenCalledWith({
        action: 'delete',
        id: 'mocked',
        name: 'Test',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });

    it('should throw error if active agents are assigned to the policy', async () => {
      (getAgentsByKuery as jest.Mock).mockResolvedValue({
        agents: [],
        total: 2,
        page: 1,
        perPage: 10,
      });
      await expect(agentPolicyService.delete(soClient, esClient, 'mocked')).rejects.toThrowError(
        'Cannot delete an agent policy that is assigned to any active or inactive agents'
      );
    });

    it('should delete .fleet-policies entries on agent policy delete', async () => {
      esClient.deleteByQuery.mockResolvedValueOnce({
        deleted: 2,
      });

      await agentPolicyService.delete(soClient, esClient, 'mocked');

      expect(esClient.deleteByQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          index: AGENT_POLICY_INDEX,
          query: {
            term: {
              policy_id: 'mocked',
            },
          },
        })
      );
    });

    it('should only delete package polices that are not shared with other agent policies', async () => {
      mockedPackagePolicyService.findAllForAgentPolicy.mockReturnValue([
        {
          id: 'package-1',
          policy_id: ['policy_1'],
          policy_ids: ['policy_1', 'int_policy_2'],
        },
        {
          id: 'package-2',
          policy_id: ['policy_1'],
          policy_ids: ['policy_1'],
        },
        {
          id: 'package-3',
        },
      ] as any);
      await agentPolicyService.delete(soClient, esClient, 'policy_1');
      expect(mockedPackagePolicyService.delete).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        ['package-2', 'package-3'],
        expect.anything()
      );
      expect(mockedPackagePolicyService.bulkUpdate).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        [
          {
            id: 'package-1',
            policy_id: 'int_policy_2',
            policy_ids: ['int_policy_2'],
          },
        ]
      );
    });
  });

  describe('bumpRevision', () => {
    it('should call agentPolicyUpdateEventHandler with updated event once', async () => {
      const soClient = getSavedObjectMock({
        revision: 1,
        monitoring_enabled: ['metrics'],
      });
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      await agentPolicyService.bumpRevision(soClient, esClient, 'agent-policy');

      expect(agentPolicyUpdateEventHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe('bumpAllAgentPolicies', () => {
    it('should call scheduleDeployAgentPoliciesTask with updated event once', async () => {
      const soClient = getSavedObjectMock({
        revision: 1,
        monitoring_enabled: ['metrics'],
      });
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        soClient
      );
      await agentPolicyService.bumpAllAgentPolicies(esClient, undefined);

      expect(soClient.bulkUpdate).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            attributes: expect.objectContaining({
              monitoring_enabled: ['metrics'],
            }),
            id: 'agent-policy-id',
            namespace: undefined,
            type: 'ingest-agent-policies',
            version: undefined,
          }),
        ],
        expect.objectContaining({
          namespace: 'default',
        })
      );

      expect(scheduleDeployAgentPoliciesTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('bumpAllAgentPoliciesForOutput', () => {
    it('should call scheduleDeployAgentPoliciesTask with updated event once', async () => {
      const soClient = getSavedObjectMock({
        revision: 1,
        monitoring_enabled: ['metrics'],
      });
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        soClient
      );
      await agentPolicyService.bumpAllAgentPoliciesForOutput(esClient, 'output-id-123');

      expect(scheduleDeployAgentPoliciesTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('removeOutputFromAll', () => {
    let mockedAgentPolicyServiceUpdate: jest.SpyInstance<
      ReturnType<(typeof agentPolicyService)['update']>
    >;
    beforeEach(() => {
      mockedAgentPolicyServiceUpdate = jest
        .spyOn(agentPolicyService, 'update')
        .mockResolvedValue({} as any);
    });

    afterEach(() => {
      mockedAgentPolicyServiceUpdate.mockRestore();
    });
    it('should update policies using deleted output', async () => {
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      soClient.find.mockResolvedValue({
        saved_objects: [
          {
            id: 'test1',
            attributes: {
              data_output_id: 'output-id-123',
              monitoring_output_id: 'output-id-another-output',
            },
          },
          {
            id: 'test2',
            attributes: {
              data_output_id: 'output-id-another-output',
              monitoring_output_id: 'output-id-123',
            },
          },
        ],
      } as any);
      soClient.bulkGet.mockImplementation(async (objects): Promise<any> => {
        if (objects.some(({ id }) => id === 'test1')) {
          return {
            saved_objects: [
              {
                id: 'test1',
                attributes: {
                  data_output_id: 'output-id-123',
                  monitoring_output_id: 'output-id-another-output',
                },
              },
            ],
          };
        }
        if (objects.some(({ id }) => id === 'test2')) {
          return {
            saved_objects: [
              {
                id: 'test2',
                attributes: {
                  data_output_id: 'output-id-another-output',
                  monitoring_output_id: 'output-id-123',
                },
              },
            ],
          };
        }

        return { saved_objects: [] };
      });
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValue(
        soClient
      );
      mockedAppContextService.getInternalUserSOClientForSpaceId.mockReturnValue(soClient);
      await agentPolicyService.removeOutputFromAll(esClient, 'output-id-123');

      expect(mockedAgentPolicyServiceUpdate).toHaveBeenCalledTimes(2);
      expect(mockedAgentPolicyServiceUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'test1',
        { data_output_id: null, monitoring_output_id: 'output-id-another-output' },
        { skipValidation: true }
      );
      expect(mockedAgentPolicyServiceUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'test2',
        { data_output_id: 'output-id-another-output', monitoring_output_id: null },
        { skipValidation: true }
      );
    });
  });

  describe('removeDefaultSourceFromAll', () => {
    let mockedAgentPolicyServiceUpdate: jest.SpyInstance<
      ReturnType<(typeof agentPolicyService)['update']>
    >;
    beforeEach(() => {
      mockedAgentPolicyServiceUpdate = jest
        .spyOn(agentPolicyService, 'update')
        .mockResolvedValue({} as any);
    });

    afterEach(() => {
      mockedAgentPolicyServiceUpdate.mockRestore();
    });

    it('should update policies using deleted download source host', async () => {
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      mockedDownloadSourceService.getDefaultDownloadSourceId.mockResolvedValue(
        'default-download-source-id'
      );
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValue(
        soClient
      );
      mockedAppContextService.getInternalUserSOClientForSpaceId.mockReturnValue(soClient);
      soClient.find.mockResolvedValue({
        saved_objects: [
          {
            id: 'test-ds-1',
            attributes: {
              download_source_id: 'ds-id-1',
            },
          },
          {
            id: 'test-ds-2',
            attributes: {
              download_source_id: 'default-download-source-id',
            },
          },
        ],
      } as any);

      await agentPolicyService.removeDefaultSourceFromAll(esClient, 'default-download-source-id');

      expect(mockedAgentPolicyServiceUpdate).toHaveBeenCalledTimes(2);
      expect(mockedAgentPolicyServiceUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'test-ds-1',
        { download_source_id: 'ds-id-1' }
      );
      expect(mockedAgentPolicyServiceUpdate).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'test-ds-2',
        { download_source_id: null }
      );
    });
  });

  describe('bumpAllAgentPoliciesForDownloadSource', () => {
    it('should call scheduleDeployAgentPoliciesTask with updated event once', async () => {
      const soClient = getSavedObjectMock({
        revision: 1,
        monitoring_enabled: ['metrics'],
      });
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        soClient
      );
      await agentPolicyService.bumpAllAgentPoliciesForDownloadSource(esClient, 'test-id-1');

      expect(scheduleDeployAgentPoliciesTask).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('should update is_managed property, if given', async () => {
      // ignore unrelated unique name constraint
      agentPolicyService.requireUniqueName = async () => {};
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'mocked',
            type: 'mocked',
            references: [],
          },
        ],
      });
      await agentPolicyService.update(soClient, esClient, 'mocked', {
        name: 'mocked',
        namespace: 'default',
        is_managed: false,
      });
      // soClient.update is called with updated values
      let calledWith = soClient.update.mock.calls[0];
      expect(calledWith[2]).toHaveProperty('is_managed', false);

      await agentPolicyService.update(soClient, esClient, 'mocked', {
        name: 'is_managed: true provided',
        namespace: 'default',
        is_managed: true,
      });
      // soClient.update is called with updated values
      calledWith = soClient.update.mock.calls[1];
      expect(calledWith[2]).toHaveProperty('is_managed', true);
    });

    it('should throw a HostedAgentRestrictionRelated error if user enables "is_protected" for a managed policy', async () => {
      jest.spyOn(licenseService, 'hasAtLeast').mockReturnValue(true);
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: { is_managed: true },
            id: 'mocked',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          is_protected: true,
        })
      ).rejects.toThrowError(
        new HostedAgentPolicyRestrictionRelatedError('Cannot update is_protected')
      );
    });

    it('should call audit logger', async () => {
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {
              name: 'Test',
            },
            references: [],
            id: 'test-agent-policy',
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
          },
        ],
      });

      await agentPolicyService.update(soClient, esClient, 'test-agent-policy', {
        name: 'Test Agent Policy',
        namespace: 'default',
        is_managed: false,
      });

      expect(mockedAuditLoggingService.writeCustomSoAuditLog).toHaveBeenCalledWith({
        action: 'update',
        name: 'Test',
        id: 'test-agent-policy',
        savedObjectType: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      });
    });

    it('should throw FleetUnauthorizedError if is_protected=true with insufficient license', async () => {
      jest.spyOn(licenseService, 'hasAtLeast').mockReturnValue(false);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
          is_protected: true,
        })
      ).rejects.toThrowError(
        new FleetUnauthorizedError('Tamper protection requires Platinum license')
      );
    });

    it('should not throw FleetUnauthorizedError if is_protected=false with insufficient license', async () => {
      jest.spyOn(licenseService, 'hasAtLeast').mockReturnValue(false);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
        })
      ).resolves.not.toThrowError(
        new FleetUnauthorizedError('Tamper protection requires Platinum license')
      );
    });

    it('should throw Error if is_protected=true with invalid uninstall token', async () => {
      jest.spyOn(licenseService, 'hasAtLeast').mockReturnValue(true);

      mockedAppContextService.getUninstallTokenService.mockReturnValueOnce({
        checkTokenValidityForPolicy: jest
          .fn()
          .mockResolvedValueOnce({ error: new Error('reason') }),
      } as unknown as UninstallTokenServiceInterface);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
          is_protected: true,
        })
      ).rejects.toThrowError(new Error('Cannot enable Agent Tamper Protection: reason'));
    });

    it('should not throw AgentPolicyInvalidError if support_agentless is defined in stateful', async () => {
      jest.spyOn(appContextService, 'getConfig').mockReturnValue({
        agentless: { enabled: true },
      } as any);
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: false, isCloudEnabled: true } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).resolves.not.toThrow();
    });

    it('should not throw AgentPolicyInvalidError if support_agentless is defined in serverless', async () => {
      jest.spyOn(appContextService, 'getConfig').mockReturnValue({
        agentless: { enabled: true },
      } as any);
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: true, isCloudEnabled: false } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).resolves.not.toThrow();
    });

    it('should not throw in serverless if support_agentless and agentless config is set', async () => {
      jest
        .spyOn(appContextService, 'getConfig')
        .mockReturnValue({ agentless: { enabled: true } } as any);
      jest
        .spyOn(appContextService, 'getCloud')
        .mockReturnValue({ isServerlessEnabled: true } as any);

      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
          supports_agentless: true,
        })
      ).resolves.not.toThrow();
    });

    it('should run external "agentPolicyPostUpdate" callbacks when update is successful', async () => {
      const soClient = getAgentPolicyCreateMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      const postUpdateCallback = jest.fn(async (policy) => policy);
      mockedAppContextService.getExternalCallbacks.mockImplementation((type) => {
        if (type === 'agentPolicyPostUpdate') {
          return new Set([postUpdateCallback]);
        }
      });

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            id: 'test-id',
            type: 'mocked',
            references: [],
          },
        ],
      });

      await expect(
        agentPolicyService.update(soClient, esClient, 'test-id', {
          name: 'test',
          namespace: 'default',
        })
      ).resolves.not.toThrow();

      expect(mockedAppContextService.getExternalCallbacks).toHaveBeenCalledWith(
        'agentPolicyPostUpdate'
      );

      expect(postUpdateCallback).toHaveBeenCalled();
    });
  });

  describe('copy', () => {
    let soClient: ReturnType<typeof savedObjectsClientMock.create>;
    let esClient: ReturnType<typeof elasticsearchServiceMock.createClusterClient>['asInternalUser'];

    beforeEach(() => {
      soClient = getSavedObjectMock({ revision: 1, package_policies: ['package-1'] });
      esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
    });

    it('should throw error for agent policy which has managed package policy', async () => {
      mockedPackagePolicyService.findAllForAgentPolicy.mockReturnValue([
        {
          id: 'package-1',
          is_managed: true,
        },
      ] as any);
      try {
        await agentPolicyService.copy(soClient, esClient, 'mocked', {
          name: 'copy mocked',
        });
      } catch (e) {
        expect(e.message).toEqual(
          new PackagePolicyRestrictionRelatedError(
            `Cannot copy an agent policy mocked that contains managed package policies`
          ).message
        );
      }
    });

    it('should link shared package policies', async () => {
      agentPolicyService.requireUniqueName = async () => {};
      soClient = createSavedObjectClientMock();
      const mockPolicy = {
        type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
        references: [],
        attributes: { revision: 1, package_policies: ['package-1'] } as any,
      };
      soClient.bulkGet.mockImplementation(async (objects) => {
        return {
          saved_objects: objects.map(({ id }) => {
            return {
              id,
              ...mockPolicy,
            };
          }),
        };
      });
      soClient.find
        .mockImplementationOnce(async () => ({
          saved_objects: [
            {
              id: 'agent-policy-id',
              score: 1,
              ...{ ...mockPolicy, name: 'mocked-policy' },
            },
          ],
          total: 1,
          page: 1,
          per_page: 1,
        }))
        .mockImplementationOnce(async () => ({
          saved_objects: [
            {
              id: 'agent-policy-id-copy',
              score: 1,
              ...{ ...mockPolicy, name: 'mocked-policy' },
            },
          ],
          total: 1,
          page: 1,
          per_page: 1,
        }));
      soClient.create.mockImplementation(async (type, attributes) => {
        return {
          attributes: attributes as unknown as NewAgentPolicy,
          id: 'mocked',
          type: 'mocked',
          references: [],
        };
      });
      const packagePolicies = [
        {
          id: 'package-1',
          name: 'package-1',
          policy_id: 'policy_1',
          policy_ids: ['policy_1', 'policy_2'],
        },
        {
          id: 'package-2',
          name: 'package-2',
          policy_id: 'policy_1',
          policy_ids: ['policy_1'],
        },
      ] as any;
      mockedPackagePolicyService.findAllForAgentPolicy.mockReturnValue(packagePolicies);
      mockedPackagePolicyService.list.mockResolvedValue({ items: packagePolicies } as any);
      await agentPolicyService.copy(soClient, esClient, 'mocked', {
        name: 'copy mocked',
      });
      expect(mockedPackagePolicyService.bulkCreate).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        [
          {
            name: 'package-2 (copy)',
            policy_id: 'policy_1',
            policy_ids: ['mocked'],
          },
        ],
        expect.anything()
      );
      expect(mockedPackagePolicyService.bulkUpdate).toBeCalledWith(
        expect.anything(),
        expect.anything(),
        [
          {
            id: 'package-1',
            name: 'package-1',
            policy_id: 'policy_1',
            policy_ids: ['policy_1', 'policy_2', 'mocked'],
          },
        ]
      );
    });
  });

  describe('deployPolicy', () => {
    beforeEach(() => {
      mockedGetFullAgentPolicy.mockReset();
    });
    it('should not create a .fleet-policy document if we cannot get the full policy', async () => {
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      mockedAppContextService.getInternalUserESClient.mockReturnValue(esClient);
      mockedOutputService.getDefaultDataOutputId.mockResolvedValue('default-output');
      mockedGetFullAgentPolicy.mockResolvedValue(null);

      const mockFleetServerHost = {
        id: 'id1',
        name: 'fleet server 1',
        host_urls: ['https://host1.fr:8220', 'https://host2-with-a-longer-name.fr:8220'],
        is_default: false,
        is_preconfigured: false,
      };
      soClient.find.mockResolvedValue({
        saved_objects: [
          {
            id: 'existing-fleet-server-host',
            type: 'fleet-fleet-server-host',
            score: 1,
            references: [],
            version: '1.0.0',
            attributes: mockFleetServerHost,
          },
        ],
        page: 0,
        per_page: 0,
        total: 0,
      });

      const mockSo = {
        attributes: {},
        id: 'policy123',
        type: 'mocked',
        references: [],
      };
      soClient.bulkGet.mockResolvedValue({
        saved_objects: [mockSo],
      });
      await agentPolicyService.deployPolicy(soClient, 'policy123');

      expect(esClient.create).not.toBeCalled();
    });

    it('should create a .fleet-policy document if we can get the full policy', async () => {
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      mockedAppContextService.getInternalUserESClient.mockReturnValue(esClient);
      mockedOutputService.getDefaultDataOutputId.mockResolvedValue('default-output');
      mockedGetFullAgentPolicy.mockResolvedValue({
        id: 'policy123',
        revision: 1,
        namespaces: ['mySpace'],
        inputs: [
          {
            id: 'input-123',
          },
        ],
      } as FullAgentPolicy);

      const mockSo = {
        attributes: {},
        id: 'policy123',
        type: 'mocked',
        references: [],
      };
      const mockFleetServerHost = {
        id: 'id1',
        name: 'fleet server 1',
        host_urls: ['https://host1.fr:8220', 'https://host2-with-a-longer-name.fr:8220'],
        is_default: false,
        is_preconfigured: false,
      };
      soClient.find.mockResolvedValue({
        saved_objects: [
          {
            id: 'existing-fleet-server-host',
            type: 'fleet-fleet-server-host',
            score: 1,
            references: [],
            version: '1.0.0',
            attributes: mockFleetServerHost,
          },
        ],
        page: 0,
        per_page: 0,
        total: 0,
      });
      soClient.bulkGet.mockResolvedValue({
        saved_objects: [mockSo],
      });
      await agentPolicyService.deployPolicy(soClient, 'policy123');

      expect(esClient.bulk).toBeCalledWith(
        expect.objectContaining({
          index: AGENT_POLICY_INDEX,
          operations: [
            expect.objectContaining({
              index: {
                _id: expect.anything(),
              },
            }),
            expect.objectContaining({
              '@timestamp': expect.anything(),
              data: {
                id: 'policy123',
                inputs: [{ id: 'input-123' }],
                revision: 1,
                namespaces: ['mySpace'],
              },
              default_fleet_server: false,
              policy_id: 'policy123',
              revision_idx: 1,
              namespaces: ['mySpace'],
            }),
          ],
          refresh: 'wait_for',
        })
      );
    });

    it('should call audit logger', async () => {
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;
      const soClient = createSavedObjectClientMock();

      mockedAppContextService.getInternalUserESClient.mockReturnValue(esClient);
      mockedOutputService.getDefaultDataOutputId.mockResolvedValueOnce('default-output');

      soClient.bulkGet.mockResolvedValue({
        saved_objects: [
          {
            attributes: {},
            references: [],
            id: 'test-agent-policy',
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
          },
        ],
      });

      await agentPolicyService.deployPolicy(soClient, 'test-agent-policy');

      expect(mockedAuditLoggingService.writeCustomAuditLog).toHaveBeenCalledWith({
        message: `User deploying policy [id=test-agent-policy]`,
      });
    });
  });

  describe('ensurePreconfiguredAgentPolicy', () => {
    it('should use preconfigured id if provided for policy', async () => {
      const soClient = createSavedObjectClientMock();
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      const preconfiguredAgentPolicy: PreconfiguredAgentPolicy = {
        id: 'my-unique-id',
        name: 'My Preconfigured Policy',
        package_policies: [
          {
            name: 'my-package-policy',
            id: 'my-package-policy-id',
            package: {
              name: 'test-package',
            },
          },
        ],
      };

      soClient.find.mockResolvedValueOnce({ total: 0, saved_objects: [], page: 1, per_page: 10 });
      soClient.bulkGet.mockRejectedValueOnce({ saved_objects: [] });

      soClient.create.mockResolvedValueOnce({
        id: 'my-unique-id',
        type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
        attributes: {},
        references: [],
      });

      await agentPolicyService.ensurePreconfiguredAgentPolicy(
        soClient,
        esClient,
        preconfiguredAgentPolicy
      );

      expect(soClient.create).toHaveBeenCalledWith(
        LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
        expect.anything(),
        expect.objectContaining({ id: 'my-unique-id' })
      );
    });
  });

  describe('getInactivityTimeouts', () => {
    const createPolicySO = (id: string, inactivityTimeout: number) => ({
      id,
      type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      attributes: { inactivity_timeout: inactivityTimeout },
      references: [],
      score: 1,
    });

    const createMockSoClientThatReturns = (policies: Array<ReturnType<typeof createPolicySO>>) => {
      const mockSoClient = createSavedObjectClientMock();
      mockSoClient.find.mockResolvedValue({
        saved_objects: policies,
        page: 1,
        per_page: 10,
        total: policies.length,
      });
      return mockSoClient;
    };

    it('should return empty array if no policies with inactivity timeouts', async () => {
      const mockSoClient = createMockSoClientThatReturns([]);
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        mockSoClient
      );
      expect(await agentPolicyService.getInactivityTimeouts()).toEqual([]);
    });
    it('should return single inactivity timeout', async () => {
      const mockSoClient = createMockSoClientThatReturns([createPolicySO('policy1', 1000)]);
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        mockSoClient
      );
      expect(await agentPolicyService.getInactivityTimeouts()).toEqual([
        { inactivityTimeout: 1000, policyIds: ['policy1'] },
      ]);
    });
    it('should return group policies with same inactivity timeout', async () => {
      const mockSoClient = createMockSoClientThatReturns([
        createPolicySO('policy1', 1000),
        createPolicySO('policy2', 1000),
      ]);
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        mockSoClient
      );

      expect(await agentPolicyService.getInactivityTimeouts()).toEqual([
        { inactivityTimeout: 1000, policyIds: ['policy1', 'policy2'] },
      ]);
    });
    it('should return handle single and grouped policies', async () => {
      const mockSoClient = createMockSoClientThatReturns([
        createPolicySO('policy1', 1000),
        createPolicySO('policy2', 1000),
        createPolicySO('policy3', 2000),
      ]);
      mockedAppContextService.getInternalUserSOClientWithoutSpaceExtension.mockReturnValueOnce(
        mockSoClient
      );
      expect(await agentPolicyService.getInactivityTimeouts()).toEqual([
        { inactivityTimeout: 1000, policyIds: ['policy1', 'policy2'] },
        { inactivityTimeout: 2000, policyIds: ['policy3'] },
      ]);
    });
  });

  describe('Fetch Agent Policies Methods', () => {
    const soList = Array.from({ length: 2 }, () => ({
      updated_at: '2020-01-01T00:00:00.000Z',
    }));

    const createSOMock = (soResult?: []) => {
      return {
        saved_objects: !soResult
          ? soList.map((soAttributes) => {
              return {
                score: 1,
                id: 'so-123',
                type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
                version: 'abc',
                updated_at: soAttributes.updated_at,
                attributes: soAttributes,
                references: [],
                sort: ['created_at'],
              };
            })
          : soResult,
        total: soList.length,
        per_page: 10,
        page: 1,
        pit_id: 'pit-id-1',
      };
    };

    describe('fetchAllAgentPolicyIds()', () => {
      let soClientMock: ReturnType<typeof savedObjectsClientMock.create>;

      beforeEach(() => {
        soClientMock = createSavedObjectClientMock();

        soClientMock.find
          .mockResolvedValueOnce(createSOMock())
          .mockResolvedValueOnce(createSOMock())
          .mockResolvedValueOnce(createSOMock([]));
      });

      it('should return an iterator', async () => {
        expect(await agentPolicyService.fetchAllAgentPolicyIds(soClientMock)).toEqual({
          [Symbol.asyncIterator]: expect.any(Function),
        });
      });

      it('should provide item ids on every iteration', async () => {
        for await (const ids of await agentPolicyService.fetchAllAgentPolicyIds(soClientMock)) {
          expect(ids).toEqual(['so-123', 'so-123']);
        }

        expect(soClientMock.find).toHaveBeenCalledTimes(3);
      });

      it('should use default options', async () => {
        for await (const ids of await agentPolicyService.fetchAllAgentPolicyIds(soClientMock)) {
          expect(ids);
        }

        expect(soClientMock.find).toHaveBeenCalledWith(
          expect.objectContaining({
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
            perPage: 1000,
            sortField: 'created_at',
            sortOrder: 'asc',
            fields: ['id', 'name'],
            filter: undefined,
          })
        );
      });

      it('should use custom options when defined', async () => {
        for await (const ids of await agentPolicyService.fetchAllAgentPolicyIds(soClientMock, {
          perPage: 13,
          kuery: 'one=two',
        })) {
          expect(ids);
        }

        expect(soClientMock.find).toHaveBeenCalledWith(
          expect.objectContaining({
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
            perPage: 13,
            sortField: 'created_at',
            sortOrder: 'asc',
            fields: ['id', 'name'],
            filter: 'one=two',
          })
        );
      });
    });

    describe('fetchAllItems()', () => {
      let soClientMock: ReturnType<typeof savedObjectsClientMock.create>;

      beforeEach(() => {
        soClientMock = createSavedObjectClientMock();

        soClientMock.find
          .mockResolvedValueOnce(createSOMock())
          .mockResolvedValueOnce(createSOMock())
          .mockResolvedValueOnce(createSOMock([]));
      });

      it('should return an iterator', async () => {
        expect(await agentPolicyService.fetchAllAgentPolicies(soClientMock)).toEqual({
          [Symbol.asyncIterator]: expect.any(Function),
        });
      });

      it('should provide items on every iteration', async () => {
        for await (const items of await agentPolicyService.fetchAllAgentPolicies(soClientMock)) {
          expect(items.map((item) => item.id)).toEqual(soList.map((_so) => 'so-123'));
        }

        expect(soClientMock.find).toHaveBeenCalledTimes(3);
      });

      it('should use default options', async () => {
        for await (const ids of await agentPolicyService.fetchAllAgentPolicies(soClientMock)) {
          expect(ids);
        }

        expect(soClientMock.find).toHaveBeenCalledWith(
          expect.objectContaining({
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
            perPage: 1000,
            sortField: 'created_at',
            sortOrder: 'asc',
            fields: [],
            filter: undefined,
          })
        );
      });

      it('should use new saved object if user opt-in for space awareness', async () => {
        jest.mocked(isSpaceAwarenessEnabled).mockResolvedValue(true);
        for await (const ids of await agentPolicyService.fetchAllAgentPolicies(soClientMock)) {
          expect(ids);
        }

        expect(soClientMock.find).toHaveBeenCalledWith(
          expect.objectContaining({
            type: AGENT_POLICY_SAVED_OBJECT_TYPE,
            perPage: 1000,
            sortField: 'created_at',
            sortOrder: 'asc',
            fields: [],
            filter: undefined,
          })
        );
      });

      it('should use custom options when defined', async () => {
        for await (const ids of await agentPolicyService.fetchAllAgentPolicies(soClientMock, {
          kuery: 'one=two',
          perPage: 12,
          sortOrder: 'desc',
          sortField: 'updated_by',
        })) {
          expect(ids);
        }

        expect(soClientMock.find).toHaveBeenCalledWith(
          expect.objectContaining({
            type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
            perPage: 12,
            sortField: 'updated_by',
            sortOrder: 'desc',
            filter: 'one=two',
          })
        );
      });
    });
  });

  describe('turnOffAgentTamperProtections', () => {
    const createPolicySO = (id: string, isProtected: boolean, error?: SavedObjectError) => ({
      id,
      type: LEGACY_AGENT_POLICY_SAVED_OBJECT_TYPE,
      attributes: {
        is_protected: isProtected,
      },
      references: [],
      score: 1,
      ...(error ? { error } : {}),
    });

    const generateAgentPolicy = (id: string, isProtected: boolean): AgentPolicy => ({
      id,
      is_protected: isProtected,
      updated_at: '2020-01-01T00:00:00.000Z',
      updated_by: 'user',
      revision: 1,
      name: 'test',
      namespace: 'default',
      status: 'active',
      is_managed: false,
    });

    const getMockAgentPolicyFetchAllAgentPolicies = (items: AgentPolicy[]) =>
      jest.fn().mockResolvedValue(
        jest.fn(async function* () {
          yield items;
        })()
      );

    it('should return if all policies are compliant', async () => {
      const mockSoClient = createSavedObjectClientMock();

      jest.spyOn(agentPolicyService, 'fetchAllAgentPolicies').mockReturnValue([] as any);

      expect(await agentPolicyService.turnOffAgentTamperProtections(mockSoClient)).toEqual({
        failedPolicies: [],
        updatedPolicies: null,
      });
      expect(mockSoClient.bulkUpdate).not.toHaveBeenCalled();
    });

    it('should bulk update policies that are not compliant', async () => {
      const mockSoClient = createSavedObjectClientMock();

      agentPolicyService.fetchAllAgentPolicies = getMockAgentPolicyFetchAllAgentPolicies([
        generateAgentPolicy('policy1', true),
        generateAgentPolicy('policy2', true),
      ]);

      mockSoClient.bulkUpdate.mockResolvedValueOnce({
        saved_objects: [createPolicySO('policy1', false), createPolicySO('policy2', false)],
      });

      const expectedResponse = expect.arrayContaining([
        expect.objectContaining({
          id: 'policy1',
          attributes: expect.objectContaining({ is_protected: false }),
        }),
        expect.objectContaining({
          id: 'policy2',
          attributes: expect.objectContaining({ is_protected: false }),
        }),
      ]);

      expect(await agentPolicyService.turnOffAgentTamperProtections(mockSoClient)).toEqual({
        failedPolicies: [],
        updatedPolicies: expectedResponse,
      });

      expect(mockSoClient.bulkUpdate).toHaveBeenCalledWith(expectedResponse);
    });

    it('should return failed policies if bulk update fails', async () => {
      const mockSoClient = createSavedObjectClientMock();

      agentPolicyService.fetchAllAgentPolicies = getMockAgentPolicyFetchAllAgentPolicies([
        generateAgentPolicy('policy1', true),
        generateAgentPolicy('policy2', true),
        generateAgentPolicy('policy3', false),
      ]);

      mockSoClient.bulkUpdate.mockResolvedValueOnce({
        saved_objects: [
          createPolicySO('policy1', false, { error: 'Oops!', message: 'Ooops!', statusCode: 500 }),
          createPolicySO('policy2', false),
        ],
      });
      expect(await agentPolicyService.turnOffAgentTamperProtections(mockSoClient)).toEqual({
        failedPolicies: [
          expect.objectContaining({
            id: 'policy1',
            error: expect.objectContaining({ message: 'Ooops!' }),
          }),
        ],
        updatedPolicies: [expect.objectContaining({ id: 'policy2' })],
      });
    });
  });

  describe('deleteFleetServerPoliciesForPolicyId', () => {
    it('should call audit logger', async () => {
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      esClient.deleteByQuery.mockResolvedValueOnce({} as any);

      await agentPolicyService.deleteFleetServerPoliciesForPolicyId(esClient, 'test-agent-policy');

      expect(mockedAuditLoggingService.writeCustomAuditLog).toHaveBeenCalledWith({
        message: 'User deleting policy [id=test-agent-policy]',
      });
    });

    it('should call deleteByQuery multiple time if there is more than 10000 .fleet-policies', async () => {
      const esClient = elasticsearchServiceMock.createClusterClient().asInternalUser;

      esClient.deleteByQuery.mockResolvedValueOnce({
        deleted: SO_SEARCH_LIMIT,
      });
      esClient.deleteByQuery.mockResolvedValueOnce({
        deleted: 10,
      });

      await agentPolicyService.deleteFleetServerPoliciesForPolicyId(esClient, 'test-agent-policy');

      expect(esClient.deleteByQuery).toBeCalledTimes(2);
    });
  });
});
