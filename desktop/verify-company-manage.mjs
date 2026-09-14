/** Release gate: reject payloads that cannot register login-owned GEA MCP tools. */
import {resolve} from 'node:path';
import {verifyCompanyManage} from './company-manage.mjs';
if(!process.argv[2])throw Error('Usage: node desktop/verify-company-manage.mjs <payload>');
await verifyCompanyManage(resolve(process.argv[2]));
console.log('Company Agent Manage MCP integration present');
