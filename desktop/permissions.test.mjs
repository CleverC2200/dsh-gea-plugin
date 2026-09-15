import test from 'node:test';
import assert from 'node:assert/strict';
import {allowPermission} from './permissions.cjs';
test('clipboard writes are allowed only for the owning local workbench',()=>{
 const origin='http://127.0.0.1:1234', owner={getURL:()=>origin+'/chat'};
 assert.equal(allowPermission(owner,'clipboard-sanitized-write',origin,origin,owner),true);
 for(const permission of ['clipboard-read','media','notifications'])assert.equal(allowPermission(owner,permission,origin,origin,owner),false);
 assert.equal(allowPermission(owner,'clipboard-sanitized-write','https://foreign.test',origin,owner),false);
 assert.equal(allowPermission(null,'clipboard-sanitized-write',origin,origin,owner),false);
 assert.equal(allowPermission(owner,'clipboard-sanitized-write','invalid',origin,owner),false);
});
