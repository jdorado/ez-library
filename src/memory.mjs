import * as fs from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';
import { atomic, fail, hash, jsonBytes, locked, rootDir, safePath } from './store.mjs';

const MEMORY_SCHEMA = 1;
const kinds = new Set(['preference', 'fact', 'decision', 'relationship', 'project']);
const sourceKinds = new Set(['conversation', 'file', 'owner', 'task', 'system']);
const confidences = new Set(['low', 'medium', 'high']);
const statuses = new Set(['active', 'superseded', 'retracted']);
const idPattern = /^[a-z][a-z0-9._-]{0,95}$/;
const keyPattern = /^[A-Za-z0-9:_-]{1,128}$/;
const revisionPattern = /^[a-f0-9]{64}$/;
const directories = ['memory', 'memory/records', 'memory/history', 'memory/operations'];

const recordPath = (root, id) => `memory/records/${id}.json`;
const operationPath = (root, key) => `memory/operations/${hash(key)}.json`;

function validateText(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) {
    fail('INVALID', `${label} must be non-empty text of at most ${max} characters`);
  }
  return value.trim();
}

function validateDate(value, label) {
  if (typeof value !== 'string' || Number.isNaN(Date.parse(value))) fail('INVALID', `${label} must be an ISO date`);
  return new Date(value).toISOString();
}

function validateId(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) fail('INVALID', 'Memory id must start with a lowercase letter and use letters, digits, dot, underscore or hyphen');
  return value;
}

function validateRevision(value, label = 'revision') {
  if (!revisionPattern.test(value || '')) fail('INVALID', `${label} must be a SHA-256`);
  return value;
}

function validateSource(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['type', 'ref', 'sha256'].includes(key))) {
    fail('INVALID', 'Memory source must contain type and ref');
  }
  if (!sourceKinds.has(value.type)) fail('INVALID', 'Memory source type is unsupported');
  const source = { type: value.type, ref: validateText(value.ref, 'Memory source ref', 512) };
  if (value.sha256 !== undefined) source.sha256 = validateRevision(value.sha256, 'source SHA-256');
  return source;
}

function validateTags(value) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 12) fail('INVALID', 'Memory tags must contain at most 12 values');
  const tags = value.map(tag => validateText(tag, 'Memory tag', 48).toLowerCase());
  return [...new Set(tags)].sort();
}

export function normalizeMemoryInput(value, now = new Date()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['id', 'kind', 'content', 'source', 'tags', 'confidence', 'capturedAt', 'reviewAt', 'status'].includes(key))) {
    fail('INVALID', 'Memory input contains unknown or invalid fields');
  }
  if (!kinds.has(value.kind)) fail('INVALID', 'Memory kind must be preference, fact, decision, relationship or project');
  if (value.confidence !== undefined && !confidences.has(value.confidence)) fail('INVALID', 'Memory confidence must be low, medium or high');
  if (value.status !== undefined && !statuses.has(value.status)) fail('INVALID', 'Memory status must be active, superseded or retracted');
  const normalized = {
    id: validateId(value.id),
    kind: value.kind,
    content: validateText(value.content, 'Memory content', 4096),
    source: validateSource(value.source),
    tags: validateTags(value.tags),
    confidence: value.confidence || 'medium',
    capturedAt: value.capturedAt === undefined ? now.toISOString() : validateDate(value.capturedAt, 'capturedAt'),
    status: value.status || 'active',
  };
  if (value.reviewAt !== undefined && value.reviewAt !== null) normalized.reviewAt = validateDate(value.reviewAt, 'reviewAt');
  return normalized;
}

async function ensureDirectory(root, relative) {
  if (typeof relative !== 'string' || !relative || relative.split('/').some(part => !part || part.startsWith('.'))) {
    fail('UNSAFE_PATH', 'Invalid memory state directory');
  }
  let directory = root;
  for (const part of relative.split('/')) {
    directory = path.join(directory, part);
    await fs.mkdir(directory, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_PATH', 'Memory state directories cannot be symlinks');
  }
  return directory;
}

async function ensureMemory(root) {
  root = await rootDir(root, true);
  for (const directory of directories) await ensureDirectory(root, directory);
  return root;
}

async function readJson(file, message) {
  let raw;
  try { raw = await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let value;
  try { value = JSON.parse(raw.toString('utf8')); }
  catch { fail('INVALID', message); }
  return { value, raw, sha256: hash(raw) };
}

async function readRecord(root, id) {
  validateId(id);
  const file = await safePath(root, recordPath(root, id));
  const stored = await readJson(file, 'Memory record is invalid; preserve state and inspect it');
  if (!stored) return null;
  const record = validateStoredRecord(stored.value);
  if (record.id !== id) fail('INVALID', 'Memory record id does not match its path');
  return { record, sha256: stored.sha256, file };
}

async function readReceipt(root, key) {
  const file = await safePath(root, operationPath(root, key));
  return readJson(file, 'Memory operation receipt is invalid; preserve state and inspect it');
}

function validateKey(key) {
  if (typeof key !== 'string' || !keyPattern.test(key)) fail('INVALID', 'Supply a stable memory --key using letters, digits, colon, underscore or hyphen');
  return key;
}

function validateExpected(expected) {
  if (expected !== 'new' && !revisionPattern.test(expected || '')) fail('INVALID', 'Supply --expected new or the current memory SHA-256');
  return expected;
}

function storedRecord(record, updatedAt) {
  return { schemaVersion: MEMORY_SCHEMA, ...record, updatedAt };
}

function validateStoredRecord(value) {
  const { schemaVersion, updatedAt, ...input } = value || {};
  if (schemaVersion !== MEMORY_SCHEMA || updatedAt === undefined) fail('INVALID', 'Memory record schema is unsupported or incomplete');
  const record = storedRecord(normalizeMemoryInput(input), validateDate(updatedAt, 'updatedAt'));
  return record;
}

export async function memoryRemember(root, input, { key, expected } = {}) {
  validateKey(key); validateExpected(expected);
  return locked(root, async root => {
    await ensureMemory(root);
    const receiptFile = await safePath(root, operationPath(root, key));
    const oldReceipt = await readJson(receiptFile, 'Memory operation receipt is invalid; preserve state and inspect it');
    const priorInput = oldReceipt?.value?.request?.input;
    const retryInput = oldReceipt && input && typeof input === 'object' && input.capturedAt === undefined && priorInput?.capturedAt
      ? { ...input, capturedAt: priorInput.capturedAt } : input;
    const normalized = normalizeMemoryInput(retryInput);
    const target = await safePath(root, recordPath(root, normalized.id), true);
    const request = { kind: 'memory', id: normalized.id, expected, input: normalized };
    if (oldReceipt && JSON.stringify(oldReceipt.value.request) !== JSON.stringify(request)) {
      fail('KEY_REUSED', 'Memory operation key was already used with different content or preconditions');
    }
    const before = await readRecord(root, normalized.id);
    if (oldReceipt && before?.sha256 === oldReceipt.value.sha256) {
      return { id: normalized.id, sha256: before.sha256, state: 'stored', replay: true, record: before.record };
    }
    if (oldReceipt && before && before.sha256 !== oldReceipt.value.sha256) {
      fail('CONFLICT', 'Memory changed after the original operation; re-read before retrying');
    }
    if (oldReceipt && !before) {
      validateRevision(oldReceipt.value.sha256, 'memory operation SHA-256');
      const recorded = validateStoredRecord(oldReceipt.value.record);
      if (recorded.id !== normalized.id || hash(jsonBytes(recorded)) !== oldReceipt.value.sha256) {
        fail('INVALID', 'Memory operation receipt does not match its record');
      }
      await atomic(target, jsonBytes(recorded));
      const after = await readRecord(root, normalized.id);
      if (!after || after.sha256 !== oldReceipt.value.sha256) fail('UNCERTAIN', 'Memory recovery readback differs; inspect memory operation before retrying');
      return { id: normalized.id, sha256: after.sha256, state: 'stored', replay: true, record: after.record };
    }
    if (expected === 'new' ? before !== null : before?.sha256 !== expected) {
      fail('CONFLICT', 'Memory changed or does not exist; re-read before replacing');
    }
    const updatedAt = new Date().toISOString();
    const record = storedRecord(normalized, updatedAt);
    const bytes = jsonBytes(record);
    const sha256 = hash(bytes);
    if (before) {
      const historyFile = await safePath(root, `memory/history/${before.sha256}.json`, true);
      await fs.copyFile(before.file, historyFile, constants.COPYFILE_EXCL).catch(error => { if (error.code !== 'EEXIST') throw error; });
      await fs.chmod(historyFile, 0o600);
    }
    const receipt = { schemaVersion: MEMORY_SCHEMA, request, sha256, record };
    await atomic(receiptFile, jsonBytes(receipt));
    await atomic(target, bytes);
    const after = await readRecord(root, normalized.id);
    if (!after || after.sha256 !== sha256) fail('UNCERTAIN', 'Memory write readback differs; inspect memory operation before retrying');
    return { id: normalized.id, sha256, state: 'stored', replay: false, record: after.record };
  });
}

export async function memoryOperation(root, key) {
  validateKey(key);
  root = await rootDir(root);
  const receipt = await readReceipt(root, key);
  if (!receipt) fail('NOT_FOUND', 'Memory operation receipt was not found');
  const { record, sha256 } = receipt.value;
  const current = await readRecord(root, record.id);
  return { ...receipt.value, state: !current ? 'missing' : current.sha256 === sha256 ? 'stored' : 'changed' };
}

async function allRecords(root) {
  const recordsDirectory = await ensureDirectory(root, 'memory/records').catch(error => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (!recordsDirectory) return [];
  const entries = await fs.readdir(recordsDirectory, { withFileTypes: true });
  const records = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!entry.name.endsWith('.json')) continue;
    if (entry.isSymbolicLink() || !entry.isFile()) fail('UNSAFE_PATH', 'Memory records must be regular files');
    const id = entry.name.slice(0, -5);
    const stored = await readRecord(root, id);
    if (stored) records.push(stored);
  }
  return records;
}

function tokens(value) {
  return [...new Set((value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) || []))];
}

function score(record, query, queryTokens) {
  if (!queryTokens.length) return 0;
  const content = record.content.toLocaleLowerCase();
  const phrase = query.toLocaleLowerCase();
  const id = record.id.toLocaleLowerCase();
  const tagText = record.tags.join(' ').toLocaleLowerCase();
  const source = record.source.ref.toLocaleLowerCase();
  let total = content.includes(phrase) ? 5 : 0;
  for (const token of queryTokens) {
    if (id === token) total += 5;
    if (record.kind === token) total += 3;
    if (record.tags.includes(token)) total += 3;
    if (content.includes(token)) total += 1;
    if (tagText.includes(token)) total += 1;
    if (source.includes(token)) total += 1;
  }
  return total;
}

export async function memoryRecall(root, query = '', { limit = 5, kind, tag, includeInactive = false } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) fail('INVALID', 'Memory recall limit must be 1..50');
  if (kind !== undefined && !kinds.has(kind)) fail('INVALID', 'Memory kind filter is unsupported');
  if (tag !== undefined) tag = validateText(tag, 'Memory tag filter', 48).toLowerCase();
  if (typeof query !== 'string' || query.length > 512 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(query)) {
    fail('INVALID', 'Memory recall query must be at most 512 characters');
  }
  query = query.trim();
  const queryTokens = tokens(query);
  root = await rootDir(root, true);
  const records = await allRecords(root);
  const matches = records.filter(({ record }) => {
    if (!includeInactive && record.status !== 'active') return false;
    if (kind !== undefined && record.kind !== kind) return false;
    if (tag !== undefined && !record.tags.includes(tag)) return false;
    return !queryTokens.length || score(record, query, queryTokens) > 0;
  }).map(({ record, sha256 }) => ({
    id: record.id,
    kind: record.kind,
    content: record.content,
    source: record.source,
    tags: record.tags,
    confidence: record.confidence,
    capturedAt: record.capturedAt,
    updatedAt: record.updatedAt,
    ...(record.reviewAt ? { reviewAt: record.reviewAt } : {}),
    status: record.status,
    sha256,
    ...(queryTokens.length ? { score: score(record, query, queryTokens) } : {}),
  }));
  matches.sort((a, b) => (b.score || 0) - (a.score || 0) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
  return { query, limit, results: matches.slice(0, limit), truncated: matches.length > limit };
}

export async function memoryGet(root, id) {
  root = await rootDir(root);
  const stored = await readRecord(root, id);
  if (!stored) fail('NOT_FOUND', 'Memory record was not found');
  return { id, sha256: stored.sha256, record: stored.record };
}

export async function memoryStatus(root, now = new Date()) {
  root = await rootDir(root, true);
  const records = await allRecords(root);
  const active = records.filter(({ record }) => record.status === 'active');
  const due = active.filter(({ record }) => record.reviewAt && Date.parse(record.reviewAt) <= now.getTime());
  const timestamps = records.map(({ record }) => ({ capturedAt: record.capturedAt, updatedAt: record.updatedAt }));
  return {
    schemaVersion: MEMORY_SCHEMA,
    state: records.length ? 'ready' : 'empty',
    directory: 'memory/records',
    total: records.length,
    active: active.length,
    inactive: records.length - active.length,
    dueForReview: due.length,
    oldestCapturedAt: timestamps.length ? timestamps.map(x => x.capturedAt).sort()[0] : null,
    newestUpdatedAt: timestamps.length ? timestamps.map(x => x.updatedAt).sort().at(-1) : null,
  };
}
