import test from 'node:test';import assert from 'node:assert/strict';
import{mkdtemp,readFile,writeFile,rm}from'node:fs/promises';import{tmpdir}from'node:os';import{join}from'node:path';import YAML from'yaml';
import{configureWelcomeNotice}from'./onboarding.mjs';
test('fresh desktop settings skip only the pinned welcome notice',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'gea-notice-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'settings.yaml');await configureWelcomeNotice(path);assert.deepEqual(YAML.parse(await readFile(path,'utf8')),{'ui-onboarding':{welcomeNoticeVersion:'2026-08-13.1'}});
});
test('notice preference preserves existing settings and comments and is idempotent',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'gea-notice-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'settings.yaml');await writeFile(path,'# keep this comment\nagent-default-model:\n  model: chosen\nui-onboarding:\n  custom: true\n');await configureWelcomeNotice(path);const first=await readFile(path,'utf8');assert.match(first,/# keep this comment/);assert.equal(YAML.parse(first)['agent-default-model'].model,'chosen');assert.equal(YAML.parse(first)['ui-onboarding'].custom,true);await configureWelcomeNotice(path);assert.equal(await readFile(path,'utf8'),first);
});
test('invalid settings are not overwritten',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'gea-notice-'));t.after(()=>rm(dir,{recursive:true,force:true}));const path=join(dir,'settings.yaml');await writeFile(path,'broken: [');await assert.rejects(configureWelcomeNotice(path));assert.equal(await readFile(path,'utf8'),'broken: [');
});
