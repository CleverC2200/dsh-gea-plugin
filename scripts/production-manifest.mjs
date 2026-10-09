/** Publish the plugin's runtime graph; the official profile provides SDK and companion peers. */
export function productionManifest(source, versions) {
  const manifest = structuredClone(source);
  for (const field of ['devDependencies', 'scripts', 'workspaces', 'packageManager', 'pnpm']) delete manifest[field];
  const companionNames = ['@changfenhuang/dsh-genui', '@cleverc2200/dsh-agent-workbench', 'dsh-better-sidebar', 'dsh-agent-manage'];
  manifest.peerDependencies = { ...source.peerDependencies };
  for (const name of companionNames) {
    if (typeof versions[name] !== 'string' || !versions[name]) throw Error('COMPANION_VERSION_REQUIRED: ' + name);
    delete manifest.dependencies[name];
    manifest.peerDependencies[name] = versions[name];
  }
  delete manifest.dependencies.esbuild;
  const sdk = source.dependencies['@modelcontextprotocol/sdk'] ?? source.devDependencies['@modelcontextprotocol/sdk'];
  if (!sdk) throw Error('MCP_SDK_RUNTIME_VERSION_REQUIRED');
  manifest.dependencies['@modelcontextprotocol/sdk'] = sdk;
  manifest.version = versions[source.name] ?? source.version;
  manifest.files = source.files.filter(file => !file.startsWith('scripts/') && !file.startsWith('src/') && !['gea.direct.example.json', 'gea.config.example.json'].includes(file));
  return manifest;
}
