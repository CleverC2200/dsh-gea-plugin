import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = import.meta.dirname;
const [releaseDirectory, baselineDirectory, outputDirectory] = process.argv.slice(2).map(value => path.resolve(root, value));
const read = async file => JSON.parse(await fs.readFile(file, 'utf8'));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
const releases = await read(path.join(releaseDirectory, 'releases.json'));
const baseline = await read(path.join(baselineDirectory, 'baseline.json'));
const preflight = await read(path.join(releaseDirectory, 'preflight.json'));
const manifest = await read(preflight.deliveryManifest);
const expected = await read(path.join(root, 'release-main-heads.json'));
const observed = await read(path.join(root, 'observed-main-heads.json'));
for (const entry of manifest.packages) {
  const head = baseline.sources.find(source => source.repo === entry.repo)?.head;
  if (head !== observed[entry.repo]) throw Error('REMOTE_MAIN_ADVANCED: ' + entry.repo);
  if (entry.source.head !== expected[entry.repo]) throw Error('RELEASE_SOURCE_CHANGED: ' + entry.repo);
}
const { createPluginSuiteChannel, encodePluginChannel } = await import(pathToFileURL('/home/runner/work/dsh-gea-plugin/dsh-gea-plugin/candidate/dsh-gea-plugin/scripts/plugin-channel.mjs'));
await fs.mkdir(outputDirectory, { mode: 0o700 });
const promotionPreflight = path.join(outputDirectory, 'preflight-at-promotion.json');
await write(promotionPreflight, { ...preflight, deployed: baseline.deployed, environment: await read(path.join(baselineDirectory, 'environment.json')) });
const references = releases.map(({ name, url, sha256 }) => ({ name, url, sha256 }));
const results = [];
for (const [name, previous] of Object.entries(baseline.channels)) {
  const issuedAt = new Date();
  const duration = Date.parse(previous.expiresAt) - Date.parse(previous.issuedAt);
  if (!Number.isFinite(duration) || duration <= 0) throw Error('CHANNEL_VALIDITY_UNCONFIRMED');
  const payload = await createPluginSuiteChannel({ previous, preflightInput: promotionPreflight, references, revision: previous.revision + 1, issuedAt: issuedAt.toISOString(), expiresAt: new Date(issuedAt.valueOf() + duration).toISOString() });
  const file = path.join(outputDirectory, `plugin-detail-${name}.json`);
  await write(file, encodePluginChannel({ payload }));
  results.push({ name, revision: payload.revision, file, sha256: createHash('sha256').update(await fs.readFile(file)).digest('hex'), previousEnvelopeSha256: createHash('sha256').update(await fs.readFile(path.join(baselineDirectory, `channel-${name}.json`))).digest('hex') });
}
await write(path.join(outputDirectory, 'channels.json'), results);
console.log(JSON.stringify({ status: 'prepared-not-published', channels: results }));
