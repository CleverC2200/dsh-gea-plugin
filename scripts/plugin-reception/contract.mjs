import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import supportedCore from '../current-core.json' with { type: 'json' };
import { isAbsolute } from 'node:path';

export const pluginNames = ['@cleverc2200/dsh-agent-workbench', 'dsh-agent-manage', '@cleverc2200/gea-dsh-prototype'];
export const businessIds = ['gea-html-inventory-aqkc', 'gea-html-inventory-qll', 'gea-html-inventory-fc', 'gea-html-inventory-dealer', 'gea-html-inventory-apsplan', 'gea-readonly'];
export const documentIds = ['standard', 'auto-negotiation', 'agent-resource-skill', ...businessIds];
export const deliveryStates = ['packaged', 'installed-and-host-observed'];
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function artifactSetSha256(artifacts) {
  assert(Array.isArray(artifacts), 'RECEPTION_BINDING_INVALID');
  return digest(JSON.stringify(artifacts.map(({ name, version, sha256 }) => ({ name, version, sha256 })).sort((a, b) => a.name.localeCompare(b.name))));
}

/** Validate runtime semantics separately from receipt provenance, so past failures can be replayed. */
export function validateRuntimeObservation(runtime, packageManifests) {
  for (const id of businessIds) {
    const rows = runtime?.resources?.filter(row => row.id === id) ?? [];
    assert(rows.length === 1 && rows[0].enabled === true && rows[0].error === false && Array.isArray(rows[0].missingSkills) && rows[0].missingSkills.length === 0, `RECEPTION_RESOURCE_NOT_READY:${id}`);
  }
  assert(runtime.resources.every(row => !row.error && !(row.missingSkills?.length)), 'RECEPTION_RESOURCE_ERRORS');
  assert(runtime.success === true && runtime.checkpoint === 'complete' && !runtime.cleanupFailed, 'RECEPTION_RUNTIME_INCOMPLETE');
  for (const name of pluginNames) {
    const plugins = runtime.plugins?.filter(row => row.name === name) ?? [];
    assert(plugins.length === 1 && plugins[0].mounts === 1 && plugins[0].active === true, 'RECEPTION_HOST_INCOMPLETE');
    const clients = runtime.clients?.filter(row => row.id === name) ?? [];
    assert(clients.length === 1 && clients[0].graphRegistered === true && clients[0].scriptPath && clients[0].batchPath, 'RECEPTION_CLIENT_INCOMPLETE');
  }
  for (const id of documentIds) {
    const docs = runtime.documents?.filter(row => row.id === id) ?? [];
    assert(docs.length === 1 && docs[0].fullStandardRetained === true && Number.isInteger(docs[0].standardEntries) && docs[0].standardEntries > 0 && /^[a-f0-9]{64}$/.test(docs[0].sha256), 'RECEPTION_STANDARD_INCOMPLETE');
    if (['standard', 'auto-negotiation', 'agent-resource-skill'].includes(id)) assert(docs[0].byteEqualStandard === true, 'RECEPTION_GENERAL_PRESET_CHANGED');
  }
  assert(runtime.actualDefault === 'auto-negotiation', 'RECEPTION_DEFAULT_CHANGED');
  assert(runtime.sdk?.length > 0 && runtime.sdk.every(row => row.sameInstallationInstance === true && row.peerSatisfied === true), 'RECEPTION_SDK_INVALID');
  for (const name of pluginNames) assert(runtime.sdk.some(row => row.plugin === name), 'RECEPTION_SDK_INCOMPLETE');
  if (packageManifests) {
    const declared = packageManifests.flatMap(manifest => Object.keys(manifest.peerDependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/')).map(name => ({ plugin: manifest.name, name })));
    assert(runtime.sdk.length === declared.length && declared.every(peer => runtime.sdk.filter(row => row.plugin === peer.plugin && row.name === peer.name).length === 1), 'RECEPTION_SDK_INCOMPLETE');
    for (const manifest of packageManifests) for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (name.startsWith('@deepseek-ai/')) assert(runtime.sdk.find(row => row.plugin === manifest.name && row.name === name)?.version === range, 'RECEPTION_SDK_VERSION_MISMATCH');
    }
  }
  assert(['fetch', 'http', 'https', 'socket'].every(key => runtime.outgoingAttempts?.[key] === 0), 'RECEPTION_OUTGOING_ATTEMPTED');
  assert(runtime.modelTasks === 0 && runtime.businessQueries === 0 && runtime.credentialsReadOrCopied === false && runtime.nativeRun === false, 'RECEPTION_SCOPE_CHANGED');
}

/** The sole acceptance projection: observed behavior must belong to the packaged artifact set. */
export function bindReception(manifest, install, observe, bindings = {}) {
  assert(deliveryStates.includes(manifest.status) && manifest.packages?.length === 3 && pluginNames.every(name => manifest.packages.filter(row => row.name === name).length === 1), 'RECEPTION_BINDING_INVALID');
  assert(manifest.core?.head === supportedCore.adaptation && manifest.core?.version === supportedCore.version, 'RECEPTION_CORE_INVALID');
  assert(bindings.packageManifests?.length === 3 && pluginNames.every(name => bindings.packageManifests.filter(row => row.name === name).length === 1), 'RECEPTION_DECLARED_SDK_REQUIRED');
  const absolute = value => typeof value === 'string' && value.length > 0 && isAbsolute(value);
  assert([install.profile, observe.profile, install.core, observe.core, bindings.expectedProfile, bindings.expectedCore].every(absolute), 'RECEPTION_ABSOLUTE_BINDING_REQUIRED');
  const artifactSha = artifactSetSha256(manifest.packages);
  assert(install.success === true && install.mode === 'install' && observe.success === true && observe.mode === 'observe', 'RECEPTION_RECEIPT_FAILED');
  for (const [receipt, key] of [[install, 'installProcess'], [observe, 'observationProcess']]) {
    const process = receipt[key];
    assert(process?.code === 0 && process.signal === null && process.timedOut === false && process.killSent === false && process.cleanupTimedOut === false && process.rawOutputPrivateOnly === true, 'RECEPTION_PROCESS_UNSAFE');
    assert(receipt.nativeRun === false && receipt.credentialsReadOrCopied === false && receipt.modelTasks === 0 && receipt.businessQueries === 0, 'RECEPTION_SCOPE_CHANGED');
  }
  assert(install.profile === observe.profile && install.profile === bindings.expectedProfile && install.core === observe.core && install.core === bindings.expectedCore && install.coreHead === manifest.core?.head && observe.coreHead === manifest.core?.head, 'RECEPTION_PROFILE_CORE_MISMATCH');
  assert(install.artifacts?.length === 3 && install.artifacts.every(row => row.byteEqual === true && row.files > 0) && artifactSetSha256(install.artifacts) === artifactSha, 'RECEPTION_ARTIFACT_MISMATCH');
  assert(install.artifactSetSha256 === artifactSha && observe.observation?.artifactSetSha256 === artifactSha, 'RECEPTION_ARTIFACT_BINDING_MISSING');
  assert(['manifestSha256', 'installSha256', 'observeSha256'].every(key => /^[a-f0-9]{64}$/.test(bindings[key])), 'RECEPTION_RECEIPT_DIGEST_REQUIRED');
  validateRuntimeObservation(observe.observation, bindings.packageManifests);
  return { status: 'installed-and-host-observed', core: manifest.core, artifactSetSha256: artifactSha, artifacts: install.artifacts.map(({ name, version, sha256, files, byteEqual }) => ({ name, version, sha256, files, byteEqual })), binding: { manifestSha256: bindings.manifestSha256, installSha256: bindings.installSha256, observeSha256: bindings.observeSha256 }, observation: observe.observation, nativeRun: false, modelTasks: 0, businessQueries: 0 };
}
