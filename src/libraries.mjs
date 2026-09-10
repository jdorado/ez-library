import * as fs from 'node:fs/promises';
import path from 'node:path';
import { atomic, fail, hash, initialize, jsonBytes, locked, rootDir, safePath, settings } from './store.mjs';
import { syncStatus } from './sync.mjs';
import { qmd, succeeded } from './native.mjs';

const initial = { schemaVersion: 1, libraries: [{ name: 'default', description: 'Original library' }] };
const validName = name => typeof name === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(name);
export async function catalog(base) {
  let value = initial;
  try {
    await rootDir(base);
    value = JSON.parse(await fs.readFile(await safePath(base, 'libraries.json'), 'utf8'));
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (value.schemaVersion !== 1 || !Array.isArray(value.libraries) || !value.libraries.length ||
      value.libraries[0]?.name !== 'default' || new Set(value.libraries.map(x => x.name)).size !== value.libraries.length ||
      value.libraries.some(x => !validName(x.name) || typeof x.description !== 'string' || !x.description.trim() || x.description.length > 512)) {
    fail('INVALID', 'Invalid library catalog; preserve state and inspect libraries.json');
  }
  return { ...value, revision: hash(jsonBytes(value)) };
}
export async function libraryRoot(base, name) {
  if (!validName(name)) fail('INVALID', 'Use a library name from sources');
  if (name === 'default') return base;
  // Check every intermediate component before allowing initialize() to create it.
  await safePath(base, `libraries/${name}/settings.json`);
  return path.join(base, 'libraries', name);
}
export async function selectLibrary(base, name) {
  const current = await catalog(base);
  if (!name && current.libraries.length !== 1) fail('INVALID', 'Multiple libraries: supply --library NAME; use sources to choose');
  name ||= current.libraries[0].name;
  if (!current.libraries.some(x => x.name === name)) fail('INVALID', 'Unknown library; use sources or source-add');
  return { name, root: await libraryRoot(base, name) };
}
export async function addLibrary(base, name, description) {
  if (!validName(name) || name === 'default' || typeof description !== 'string' || !description.trim() || description.length > 512 || /[\x00-\x1f\x7f]/.test(description)) {
    fail('INVALID', 'Supply a new lowercase library name and a one-line description (1–512 characters)');
  }
  return locked(base, async base => {
    const current = await catalog(base);
    const existing = current.libraries.find(x => x.name === name);
    if (existing) {
      if (existing.description !== description) fail('CONFLICT', 'Library already exists with another description');
      return { name, revision: current.revision, existing: true };
    }
    await initialize(await libraryRoot(base, name));
    const value = { schemaVersion: 1, libraries: [...current.libraries, { name, description }] };
    await atomic(await safePath(base, 'libraries.json'), jsonBytes(value));
    return { name, revision: hash(jsonBytes(value)), instruction: 'Refresh the workspace TOOLS.md library names and purposes from sources before routing subsequent saves.' };
  });
}
export async function sources(base) {
  const current = await catalog(base);
  const libraries = [];
  for (const entry of current.libraries) {
    const root = await libraryRoot(base, entry.name);
    const policy = await settings(root);
    const sync = await syncStatus(root);
    libraries.push({ ...entry, root, storage: policy.settings.storage, sync });
  }
  return { revision: current.revision, selectionRequired: libraries.length > 1, libraries };
}
export async function searchLibraries(base, { name, all, query, limit = 5 }, search = qmd) {
  if (typeof query !== 'string' || !query.trim() || !Number.isInteger(limit) || limit < 1 || limit > 100 || (all && name)) fail('INVALID', 'Supply a query, limit 1–100, and either --all or --library NAME');
  const entries = all ? (await catalog(base)).libraries : [{ name: (await selectLibrary(base, name)).name }];
  const libraries = [];
  for (const entry of entries) {
    try {
      const root = await libraryRoot(base, entry.name);
      const results = await locked(root, async () => {
        const output = succeeded(await search(root, ['search', query, '--json', '-n', String(limit)]), 'QMD search');
        const matches = JSON.parse(output);
        if (!Array.isArray(matches)) fail('UNAVAILABLE', 'QMD search did not return an array');
        return matches.map(match => ({ ...match, library: entry.name }));
      });
      libraries.push({ library: entry.name, results });
    } catch (error) { libraries.push({ library: entry.name, error: { code: error.code || 'UNAVAILABLE', message: error.message } }); }
  }
  return { complete: libraries.every(x => !x.error), limitPerLibrary: limit, libraries };
}
