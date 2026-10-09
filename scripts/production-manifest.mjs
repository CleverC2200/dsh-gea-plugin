/** Publish the plugin's runtime graph; the official profile provides SDK and companion peers. */
export function productionManifest(source, versions) {
  const manifest = structuredClone(source);
  for (const field of ['devDependencies', 'scripts', 'workspaces', 'packageManager', 'pnpm']) delete manifest[field];
  const requiredCompanions = ['@cleverc2200/dsh-agent-workbench', 'dsh-agent-manage'];
  const optionalCompanions = ['@changfenhuang/dsh-genui', 'dsh-better-sidebar'];
  const companionNames = [...requiredCompanions, ...optionalCompanions];
  manifest.peerDependencies = { ...source.peerDependencies };
  for (const name of companionNames) {
    if (typeof versions[name] !== 'string' || !versions[name]) throw Error('COMPANION_VERSION_REQUIRED: ' + name);
    delete manifest.dependencies[name];
    manifest.peerDependencies[name] = versions[name];
  }
  manifest.peerDependenciesMeta = { ...source.peerDependenciesMeta };
  for (const name of requiredCompanions) delete manifest.peerDependenciesMeta[name];
  for (const name of optionalCompanions) manifest.peerDependenciesMeta[name] = { optional: true };
  delete manifest.dependencies.esbuild;
  const sdk = source.dependencies['@modelcontextprotocol/sdk'] ?? source.devDependencies['@modelcontextprotocol/sdk'];
  if (!sdk) throw Error('MCP_SDK_RUNTIME_VERSION_REQUIRED');
  manifest.dependencies['@modelcontextprotocol/sdk'] = sdk;
  manifest.version = versions[source.name] ?? source.version;
  manifest.files = source.files.filter(file => !file.startsWith('scripts/') && !file.startsWith('src/') && !['gea.direct.example.json', 'gea.config.example.json'].includes(file));
  return manifest;
}
