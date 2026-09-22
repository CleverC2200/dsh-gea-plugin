/** Local development only: official desktop owns a supported DSH profile launcher. */
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
const workspace=process.env.GEA_INVENTORY_WORKSPACE;
if(!workspace || !process.env.DSH_FULL_DATA_DIR || !process.env.GEA_DESKTOP_CONTROL_URL)
  throw Error('INVENTORY_DESKTOP_CONTEXT_REQUIRED');
process.env.GEA_HTML_RUNTIME=resolve(process.env.DSH_FULL_DATA_DIR);
process.env.GEA_HTML_PORT='0';
await import(pathToFileURL(resolve(workspace,'agent-plugin-trials/scripts/light/start-aqkc-latest.mjs')).href);
