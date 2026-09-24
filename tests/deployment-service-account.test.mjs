import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readDeployment } from '../scripts/deployment.mjs';

const account = {
  clientIdEnv: 'GEA_RESUBMIT_TEST_CLIENT',
  clientSecretEnv: 'GEA_RESUBMIT_TEST_SECRET',
  keychainService: 'gea-resubmit-fixture',
  tenantId: '0',
  allowedUserIds: ['user-1'],
};

const deployment = {
  geaBaseUrl: 'https://gea.example.test/gea-boot',
  pageSize: 10,
  periodPageSize: 100,
  requestTimeoutMs: 15000,
  maxSnapshotBytes: 100000,
  analysis: { mode: 'receipt' },
  serviceAccounts: { production: account },
};

async function configFile(t, value = deployment) {
  const directory = await mkdtemp(resolve(tmpdir(), 'gea-credential-deployment-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = resolve(directory, 'gea.config.json');
  await writeFile(path, JSON.stringify(value));
  return path;
}

test('the plugin deployment loader supplies desktop Host credentials from Keychain without serializing them', async (t) => {
  const path = await configFile(t);
  const credentialEnv = {};
  let reads = 0;
  const config = await readDeployment(path, {
    credentialEnv,
    platform: 'darwin',
    readKeychain: async (service) => {
      reads++;
      assert.equal(service, account.keychainService);
      return { clientId: 'fixture-client', secret: 'fixture-secret' };
    },
  });
  assert.equal(reads, 1);
  assert.deepEqual(credentialEnv, {
    GEA_RESUBMIT_TEST_CLIENT: 'fixture-client',
    GEA_RESUBMIT_TEST_SECRET: 'fixture-secret',
  });
  assert.equal(JSON.stringify(config).includes('fixture-secret'), false);
});

test('missing Keychain material fails closed without partially setting credential environment', async (t) => {
  const path = await configFile(t);
  const credentialEnv = {};
  await assert.rejects(
    readDeployment(path, {
      credentialEnv,
      platform: 'darwin',
      readKeychain: async () => ({ clientId: 'fixture-client', secret: '' }),
    }),
    /GEA_KEYCHAIN_CREDENTIAL_INVALID/,
  );
  assert.deepEqual(credentialEnv, {});
});

test('a later Keychain failure cannot leave earlier account credentials in the environment', async (t) => {
  const path = await configFile(t, {
    ...deployment,
    serviceAccounts: {
      production: account,
      test: {
        ...account,
        clientIdEnv: 'GEA_RESUBMIT_TEST_OTHER_CLIENT',
        clientSecretEnv: 'GEA_RESUBMIT_TEST_OTHER_SECRET',
        keychainService: 'gea-resubmit-other-fixture',
      },
    },
  });
  const credentialEnv = {};
  await assert.rejects(
    readDeployment(path, {
      credentialEnv,
      platform: 'darwin',
      readKeychain: async (service) => {
        if (service === account.keychainService) return { clientId: 'fixture-client', secret: 'fixture-secret' };
        throw new Error('fixture-secret must not appear in the error');
      },
    }),
    (error) => error.message === 'GEA_KEYCHAIN_CREDENTIAL_MISSING',
  );
  assert.deepEqual(credentialEnv, {});
});

test('Keychain-backed deployment fails closed on unsupported platforms', async (t) => {
  const path = await configFile(t);
  const credentialEnv = {};
  await assert.rejects(
    readDeployment(path, {
      credentialEnv,
      platform: 'win32',
      readKeychain: async () => { throw new Error('should not read Keychain'); },
    }),
    /GEA_KEYCHAIN_UNAVAILABLE/,
  );
  assert.deepEqual(credentialEnv, {});
});

test('deployment rejects inline secrets before reading Keychain', async (t) => {
  const path = await configFile(t, {
    ...deployment,
    serviceAccounts: { production: { ...account, secret: 'must-not-be-in-configuration' } },
  });
  await assert.rejects(
    readDeployment(path, {
      credentialEnv: {},
      platform: 'darwin',
      readKeychain: async () => { throw new Error('should not read Keychain'); },
    }),
    /INVALID_SERVICE_ACCOUNTS/,
  );
});

test('deployment without service accounts does not read Keychain', async (t) => {
  const { serviceAccounts: _unused, ...plain } = deployment;
  const path = await configFile(t, plain);
  await readDeployment(path, {
    credentialEnv: {},
    platform: 'darwin',
    readKeychain: async () => { throw new Error('unexpected Keychain access'); },
  });
});
