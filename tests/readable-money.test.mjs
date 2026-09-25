import test from 'node:test';
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {createRequire} from 'node:module';

const built=await build({entryPoints:['src/workbench/original/workbenches/regionalApproval/models/readableMoney.ts'],bundle:true,write:false,platform:'node',format:'cjs',packages:'external'});
const mod={exports:{}};
new Function('require','module','exports',built.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports);
const {readableMoney}=mod.exports;

test('approval totals use readable amounts while retaining their exact source value for detail',()=>{
 assert.deepEqual(readableMoney('6416787.34'),{display:'¥641.68万',exact:'¥6,416,787.34'});
 assert.deepEqual(readableMoney('711255083.1224575'),{display:'¥7.11亿',exact:'¥711,255,083.1224575'});
 assert.deepEqual(readableMoney('-119910.09'),{display:'−¥11.99万',exact:'−¥119,910.09'});
 assert.deepEqual(readableMoney('0'),{display:'¥0',exact:'¥0'});
 assert.deepEqual(readableMoney(''),{display:'—',exact:'—'});
});
