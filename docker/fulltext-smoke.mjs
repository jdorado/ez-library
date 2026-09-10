import { execFileSync } from 'node:child_process';
const image = process.env.EZ_LIBRARY_IMAGE;
if (!image) throw Error('Set EZ_LIBRARY_IMAGE to the built runtime');
const script = `
import fs from 'node:fs/promises';
import assert from 'node:assert/strict';
import {refreshIndex} from '/app/src/indexer.mjs';
import {qmd} from '/app/src/native.mjs';
const root='/state';
await fs.mkdir(root+'/files',{recursive:true});await fs.mkdir(root+'/sync',{recursive:true});
await fs.writeFile(root+'/files/note.md','# Calibration\\n\\nPreserve normalization anchors.\\n');
const first=await refreshIndex(root);
assert.equal(first.embedded,false);
const second=await refreshIndex(root);assert.equal(second.indexedAt,first.indexedAt);
const search=await qmd(root,['search','normalization','--json']);assert.equal(search.code,0);assert.match(search.stdout,/note/);
assert.deepEqual(await fs.readdir(root+'/qmd/cache/qmd/models'),[]);
console.log('PASS: offline full-text indexing/search; no embedding model download');
`;
execFileSync('docker', ['run','--rm','--network','none','-e','EZ_LIBRARY_EMBED=0',image,'node','--input-type=module','-e',script], {stdio:'inherit'});
