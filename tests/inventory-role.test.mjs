import test from 'node:test';import assert from 'node:assert/strict';
import {verifiedRoleProfile} from '../src/host/inventory-role.ts';
const expected={sessionId:'s',conversationId:'c',agentCode:'inventory-personal-workbench'};
const user={success:true,code:'OK',sessionId:'s',conversationId:'c',agentId:expected.agentCode,userId:'u',roleCodes:'r1,r2',roleNames:'基地计划员,集团品类计划员',roles:[{code:'r2',name:'集团品类计划员'}],delegationToken:'must-not-return'};
test('validated user roles reach presentation without credential fields',()=>{const p=verifiedRoleProfile(user,expected,'u');assert.deepEqual(p.roleNames,['基地计划员','集团品类计划员']);assert.deepEqual(p.roleCodes,['r1','r2']);assert.equal(p.roles[1].name,'集团品类计划员');assert.ok(!JSON.stringify(p).includes('must-not-return'))});
test('foreign user/session/consumer cannot provide trusted display roles',()=>{for(const [key,value]of Object.entries({userId:'other',sessionId:'other',conversationId:'other',agentId:'other',success:false,code:'DENIED'}))assert.throws(()=>verifiedRoleProfile({...user,[key]:value},expected,'u'),/IDENTITY_MISMATCH/)});
