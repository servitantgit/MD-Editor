import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moveFile } from '../js/file-mover.js';
import { utf8ToB64, b64ToUtf8 } from '../js/github-client.js';

/** Мінімальний фейковий клієнт із тим самим інтерфейсом, що й GitHubClient, поверх Map у пам'яті. */
class FakeClient {
  constructor(files) {
    // files: { path: text }
    this.files = new Map(Object.entries(files).map(([p, text]) => [p, { text, sha: 'sha-' + p }]));
    this.puts = [];
    this.deletes = [];
  }
  async getFileB64(path) {
    const f = this.files.get(path);
    if (!f) { const e = new Error(`Not Found (${path})`); e.status = 404; throw e; }
    return { b64: utf8ToB64(f.text), sha: f.sha };
  }
  async putFile(path, b64, message) {
    this.files.set(path, { text: b64ToUtf8(b64), sha: 'sha-' + path });
    this.puts.push({ path, message });
    return { content: { sha: 'sha-' + path } };
  }
  async deleteFile(path) {
    this.files.delete(path);
    this.deletes.push(path);
  }
}

test('moveFile relocates content, keeps own relative links correct, and returns no-op when path unchanged', async () => {
  const client = new FakeClient({
    'AI corrected/BOBAM/Laser sensor.md': '![sensor](../../Asset/Laser_sensor_image_0001.jpg)\n',
  });
  const allFiles = [{ path: 'AI corrected/BOBAM/Laser sensor.md' }];

  const result = await moveFile(client, allFiles, 'AI corrected/BOBAM/Laser sensor.md', 'AI corrected/BOBAM');
  assert.equal(result.skipped, true);

  const result2 = await moveFile(client, allFiles, 'AI corrected/BOBAM/Laser sensor.md', 'AI corrected/BOBAM/sub');
  assert.equal(result2.newPath, 'AI corrected/BOBAM/sub/Laser sensor.md');
  assert.equal(client.files.has('AI corrected/BOBAM/Laser sensor.md'), false);
  const moved = client.files.get('AI corrected/BOBAM/sub/Laser sensor.md');
  assert.equal(moved.text, '![sensor](../../../Asset/Laser_sensor_image_0001.jpg)\n');
});

test('moveFile updates references in OTHER md files across the repo (relative and root-relative)', async () => {
  const client = new FakeClient({
    'Asset/pic.jpg': 'binary-ish-content',
    'AI corrected/BOBAM/file.md': '# noop',
    'AI corrected/Other/refA.md': '![p](../../Asset/pic.jpg)\n',
    'AI corrected/Other/refB.md': '![p](/Asset/pic.jpg)\n',
    'AI corrected/Other/refC.md': '![p](../../Asset/unrelated.jpg)\n',
  });
  const allFiles = [
    { path: 'Asset/pic.jpg' },
    { path: 'AI corrected/BOBAM/file.md' },
    { path: 'AI corrected/Other/refA.md' },
    { path: 'AI corrected/Other/refB.md' },
    { path: 'AI corrected/Other/refC.md' },
  ];

  const result = await moveFile(client, allFiles, 'Asset/pic.jpg', 'Asset/sub');
  assert.equal(result.newPath, 'Asset/sub/pic.jpg');
  assert.deepEqual(result.updatedFiles.sort(), ['AI corrected/Other/refA.md', 'AI corrected/Other/refB.md']);

  assert.equal(client.files.get('AI corrected/Other/refA.md').text, '![p](../../Asset/sub/pic.jpg)\n');
  assert.equal(client.files.get('AI corrected/Other/refB.md').text, '![p](/Asset/sub/pic.jpg)\n');
  // непов'язаний файл лишається без змін
  assert.equal(client.files.get('AI corrected/Other/refC.md').text, '![p](../../Asset/unrelated.jpg)\n');
});

test('moveFile does not choke when one referencing file fails to update (keeps going, reports only successes)', async () => {
  const client = new FakeClient({
    'Asset/pic.jpg': 'x',
    'AI corrected/A/ref.md': '![p](/Asset/pic.jpg)\n',
  });
  const allFiles = [
    { path: 'Asset/pic.jpg' },
    { path: 'AI corrected/A/ref.md' },
    { path: 'AI corrected/B/missing.md' }, // існує в дереві, але зник із "репо" -> getFileB64 кине помилку
  ];

  const result = await moveFile(client, allFiles, 'Asset/pic.jpg', 'Asset/new');
  assert.deepEqual(result.updatedFiles, ['AI corrected/A/ref.md']);
});
