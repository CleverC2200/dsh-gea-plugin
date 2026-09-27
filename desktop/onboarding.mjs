/** Apply the GEA desktop's notice preference using DSH 0.1.5-rc.2 settings. */
import {readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {join} from 'node:path';
// An upgraded shell can still run a prepared full graph through standalone
// Node. Its dependencies belong to that graph, not to the new ASAR baseline.
const dependencyRoot=process.env.GEA_LAYERED_CORE||process.env.DSH_PLUGIN_GRAPH;
const dependency=createRequire(dependencyRoot?join(dependencyRoot,'package.json'):import.meta.url);
const YAML=dependency('yaml');
/** Preserve unrelated settings and comments while skipping the informational welcome notice. */
export async function configureWelcomeNotice(path) {
  let text='';
  try {text=await readFile(path,'utf8');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const document=YAML.parseDocument(text);
  if(document.errors.length)throw new Error('Invalid DSH settings: '+document.errors[0].message);
  const field=['ui-onboarding','welcomeNoticeVersion'];
  // Matches the welcome-copy version shipped by the pinned official DSH package.
  const version='2026-08-13.1';
  if(document.getIn(field)===version)return;
  document.setIn(field,version);
  await writeFile(path,document.toString(),{mode:0o600});
}
