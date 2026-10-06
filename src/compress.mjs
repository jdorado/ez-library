import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { fail, LibraryError, MAX_FILE_BYTES, put, safePath } from './store.mjs';

// Transform an existing Library file inside the existing writer transaction.
// No bulk stdin, external path, subprocess, second writer or source deletion.
export async function gzipFile(root, { path, to, expected, key }) {
  if (!path || !to || path === to || !to.endsWith('.gz')) fail('INVALID', 'Supply distinct --path and --to ending in .gz');
  if (!/^[a-f0-9]{64}$/.test(expected || '')) fail('INVALID', 'Supply the current source SHA-256');
  if (path === 'LIBRARY_SYNC_ACCESS') fail('INVALID', 'The sync access marker is reserved');
  const source = { path, sha256: expected, encoding: 'gzip', level: 9 };
  async function* compressed() {
    // put starts consuming only after it holds the Library writer lock.
    const file = await safePath(root, 'files/' + path);
    const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) fail('UNSAFE_PATH', 'Expected a regular file');
      if (stat.size > MAX_FILE_BYTES) fail('TOO_LARGE', 'Source exceeds the Library file limit');
      let bytes = 0;
      const sha = createHash('sha256');
      const verify = new Transform({
        transform(chunk, encoding, callback) {
          bytes += chunk.length;
          if (bytes > MAX_FILE_BYTES) return callback(new LibraryError('TOO_LARGE', 'Source exceeds the Library file limit'));
          sha.update(chunk); callback(null, chunk);
        },
        flush(callback) {
          if (sha.digest('hex') !== expected) return callback(new LibraryError('CONFLICT', 'Source changed; re-read its metadata before compression'));
          source.bytes = bytes;
          callback();
        },
      });
      const gzip = createGzip({ level: 9 });
      let failure;
      const pumping = pipeline(handle.createReadStream({ autoClose: false }), verify, gzip).catch(error => { failure = error; });
      try { for await (const chunk of gzip) yield chunk; }
      finally { gzip.destroy(); await pumping; }
      if (failure) throw failure;
    } finally { await handle.close(); }
  }
  return put(root, to, Readable.from(compressed()), { key, expected: 'new', source });
}
