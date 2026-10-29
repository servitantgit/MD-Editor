import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveFile } from '../js/file-mover.js';
import { renameFolder } from '../js/folder-manager.js';

/** In-memory client; selected paths fail on read (403) or write (409). */
class Client {
  constructor(files, { failGet = [], failPut = [], raw = {} } = {}) {
    this.files = new Map(Object.entries(files).map(([p, t]) => [p, { text: t, sha: 'sha-' + p }]));
    this.failGet = new Set(failGet);
    this.failPut = new Set(failPut);
    this.raw = raw;
  }
  async getFileB64(path) {
    if (this.failGet.has(path)) { const e = new Error('rate limited'); e.status = 403; throw e; }
    if (this.raw[path]) return { b64: this.raw[path], sha: 'sha-' + path };
    const f = this.files.get(path);
    if (!f) { const e = new Error('Not Found'); e.status = 404; throw e; }
    return { b64: Buffer.from(f.text).toString('base64'), sha: f.sha };
  }
  async putFile(path, b64) {
    if (this.failPut.has(path)) { const e = new Error('conflict'); e.status = 409; throw e; }
    this.files.set(path, { text: Buffer.from(b64, 'base64').toString('utf-8'), sha: 'sha2-' + path });
    return { content: { sha: 'sha2-' + path } };
  }
  async deleteFile(path) { this.files.delete(path); }
}

const listOf = (files, raw = {}) => Object.keys(files).concat(Object.keys(raw)).map((p) => ({ path: p, sha: 'sha-' + p }));

test('link failures: a note that cannot be READ is reported in failedFiles', async () => {
  const files = { 'A/x.md': '# x', 'B/ref1.md': '[x](../A/x.md)', 'B/ref2.md': '[x](../A/x.md)', 'B/plain.md': 'no links' };
  const client = new Client(files, { failGet: ['B/ref2.md'] });
  const result = await moveFile(client, listOf(files), 'A/x.md', 'C');
  assert.deepEqual(result.failedFiles, ['B/ref2.md']);
  assert.deepEqual(result.updatedFiles.slice().sort(), ['B/ref1.md']);
});

test('link failures: a note that cannot be WRITTEN is reported in failedFiles', async () => {
  const files = { 'A/x.md': '# x', 'B/ref1.md': '[x](../A/x.md)', 'B/ref2.md': '[x](../A/x.md)' };
  const client = new Client(files, { failPut: ['B/ref2.md'] });
  const result = await moveFile(client, listOf(files), 'A/x.md', 'C');
  assert.deepEqual(result.failedFiles, ['B/ref2.md']);
  assert.deepEqual(result.updatedFiles.slice().sort(), ['B/ref1.md']);
});

test('link failures: no false failures for the moved file itself or a binary .md', async () => {
  const files = { 'A/x.md': '# x', 'B/ref1.md': '[x](../A/x.md)' };
  const raw = { 'B/bin.md': Buffer.from([0xff, 0xfe, 0x00, 0x80]).toString('base64') };
  const client = new Client(files, { raw });
  const result = await moveFile(client, listOf(files, raw), 'A/x.md', 'C');
  assert.deepEqual(result.failedFiles, []);
  assert.deepEqual(result.updatedFiles, ['B/ref1.md']);
});

test('link failures: renameFolder reports notes whose links could not be updated', async () => {
  const files = { 'Docs/a.md': '# a', 'Notes/ref.md': '[a](../Docs/a.md)', 'Notes/ref2.md': '[a](/Docs/a.md)' };
  const client = new Client(files, { failGet: ['Notes/ref2.md'] });
  const result = await renameFolder(client, listOf(files), 'Docs', 'Archive');
  assert.deepEqual(result.failedFiles, ['Notes/ref2.md']);
  assert.ok(result.updatedFiles.includes('Notes/ref.md'));
});
