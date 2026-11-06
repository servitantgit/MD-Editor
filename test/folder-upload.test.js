import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { setupFolderDropzone } from '../js/folder-upload.js';
import { GitHubClient } from '../js/github-client.js';

// Folder upload from disk: everything dropped lands in the folder under the
// cursor, in ONE commit, or nothing is written. Fake FileSystem entries drive
// the real dropzone; the client is a fake that records every call.

const HTML = '<!doctype html><body><div id="dz"><div id="ov" class="hidden"></div><div id="tree">'
  + '<div class="tree-root-drop" data-target-folder="Active/Sub">into</div>'
  + '<div class="tree-root-drop tree-root-drop-root">root</div>'
  + '<div class="file-item folder" data-path="docs"><span class="name">docs</span></div>'
  + '<div class="file-item" data-path="docs/n.md"><span class="name">n.md</span></div>'
  + '<div id="blank"></div>'
  + '</div></div></body>';

const FOLDER = '.file-item.folder[data-path="docs"]';
const FILE_ROW = '[data-path="docs/n.md"]';
const ACTIVE = '[data-target-folder]';
const ROOT = '.tree-root-drop-root';
const BLANK = '#blank';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fixture({ tree = [], commit = null } = {}) {
  const dom = new JSDOM(HTML);
  const win = dom.window;
  const saved = { FileReader: globalThis.FileReader, document: globalThis.document };
  globalThis.FileReader = win.FileReader;
  globalThis.document = win.document;
  const log = { getTree: 0, commits: [], puts: [], statuses: [], uploaded: 0 };
  let generation = 1;
  const client = {
    async getTree() { log.getTree++; return tree.map((p) => ({ path: p, sha: 'sha-' + p })); },
    async commitFiles(branch, message, files) {
      log.commits.push({ branch, message, files: files.map((x) => ({ path: x.path, contentB64: x.contentB64 })) });
      if (commit) return commit(log.commits.length);
      return { commit: { sha: 'new-commit' }, files: [] };
    },
    async putFile(path, contentB64) { log.puts.push({ path, contentB64 }); return {}; },
  };
  const deps = {
    getClient: () => client,
    getBranch: () => 'main',
    getSessionGeneration: () => generation,
    getAllFiles: () => [],
    onStatus: (m, isError) => { log.statuses.push({ m: String(m), e: !!isError }); },
    onUploaded: () => { log.uploaded++; },
  };
  const doc = win.document;
  const dz = doc.getElementById('dz');
  const ov = doc.getElementById('ov');
  setupFolderDropzone(dz, ov, deps);
  return {
    win, doc, log, deps, dz, ov,
    setGeneration: (g) => { generation = g; },
    file: (name, content) => {
      const file = new win.File([content], name);
      return { isFile: true, isDirectory: false, name, file: (ok) => ok(file) };
    },
    dir: (name, children, batch = 1000) => ({
      isFile: false, isDirectory: true, name,
      createReader() {
        let i = 0;
        return { readEntries(ok) { const b = children.slice(i, i + batch); i += b.length; setTimeout(() => ok(b), 0); } };
      },
    }),
    restore() {
      globalThis.FileReader = saved.FileReader;
      globalThis.document = saved.document;
      win.close();
    },
  };
}

const sample = (f, name = 'X') => f.dir(name, [
  f.file('a.txt', 'hello'),
  f.dir('sub', [f.file('b.pts', new Uint8Array([0, 255, 1]))]),
]);

function external(entries) {
  return {
    types: ['Files'],
    items: entries.map((en) => ({ kind: 'file', type: '', webkitGetAsEntry: () => en })),
    files: [], effectAllowed: 'all', dropEffect: 'none', getData: () => '',
  };
}
function internal() {
  return {
    types: ['application/x-md-folder', 'text/plain'],
    items: [{ kind: 'string', type: 'text/plain', webkitGetAsEntry: () => null }],
    files: [], effectAllowed: 'move', dropEffect: 'none',
    getData: (t) => (t === 'text/plain' ? 'docs' : ''),
  };
}
function fire(f, selector, type, dataTransfer) {
  const ev = new f.win.Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
  f.doc.querySelector(selector).dispatchEvent(ev);
  return ev;
}
async function settle(log, max = 2000) {
  const sig = () => [log.statuses.length, log.commits.length, log.puts.length, log.uploaded, log.getTree].join(',');
  const start = Date.now();
  let last = sig();
  let since = Date.now();
  while (Date.now() - start < max) {
    await sleep(10);
    const s = sig();
    if (s !== last) { last = s; since = Date.now(); } else if (Date.now() - since >= 120) return;
  }
}
async function waitFor(pred, max = 1500) {
  const start = Date.now();
  while (Date.now() - start < max) { if (pred()) return true; await sleep(10); }
  return pred();
}
async function run(opts, body) {
  const f = fixture(opts);
  try { await body(f); } finally { await settle(f.log, 500); f.restore(); }
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const paths = (c) => c.files.map((x) => x.path).sort();
const byPath = (list) => [...list].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
const errors = (log) => log.statuses.filter((s) => s.e).map((s) => s.m).join(' | ');

test('folder upload: drop on a folder row commits once into that folder', async () => {
  await run({}, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1, 'exactly one commitFiles');
    const c = f.log.commits[0];
    assert.equal(c.branch, 'main');
    assert.equal(c.message, 'Upload folder X');
    assert.deepEqual(byPath(c.files), [
      { path: 'docs/X/a.txt', contentB64: 'aGVsbG8=' },
      { path: 'docs/X/sub/b.pts', contentB64: 'AP8B' },
    ]);
    assert.equal(f.log.uploaded, 1);
    assert.ok(f.log.statuses.some((s) => !s.e && /^Uploaded 2 file/.test(s.m)), 'success status');
  });
});

test('folder upload: drop on a file row commits into that file folder', async () => {
  await run({}, async (f) => {
    fire(f, FILE_ROW, 'drop', external([sample(f)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.deepEqual(paths(f.log.commits[0]), ['docs/X/a.txt', 'docs/X/sub/b.pts']);
  });
});

test('folder upload: drop on the active-folder strip commits into the active folder', async () => {
  await run({}, async (f) => {
    fire(f, ACTIVE, 'drop', external([sample(f)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.deepEqual(paths(f.log.commits[0]), ['Active/Sub/X/a.txt', 'Active/Sub/X/sub/b.pts']);
  });
});

test('folder upload: drop on the root strip or empty space commits into the root', async () => {
  await run({}, async (f) => {
    fire(f, ROOT, 'drop', external([sample(f, 'X')]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.equal(f.log.commits[0].message, 'Upload folder X');
    assert.deepEqual(paths(f.log.commits[0]), ['X/a.txt', 'X/sub/b.pts']);
  });
  await run({}, async (f) => {
    fire(f, BLANK, 'drop', external([sample(f, 'Y')]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.deepEqual(paths(f.log.commits[0]), ['Y/a.txt', 'Y/sub/b.pts']);
  });
});

test('folder upload: an existing path in the fresh tree writes nothing', async () => {
  await run({ tree: ['docs/X/a.txt'] }, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 0, 'no commit on conflict');
    assert.ok(f.log.getTree >= 1, 'conflicts are checked against a fresh getTree');
    assert.ok(errors(f.log).includes('docs/X/a.txt'), 'status names the conflicting path');
    assert.equal(f.log.uploaded, 0);
  });
});

test('folder upload: a conflict differing only in letter case writes nothing', async () => {
  await run({ tree: ['docs/X/A.TXT'] }, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 0, 'no commit on a case-only conflict');
    assert.ok(errors(f.log).length > 0, 'an error status is shown');
  });
});

test('folder upload: .git, Thumbs.db and Office lock files are skipped and counted as items', async () => {
  await run({}, async (f) => {
    const x = f.dir('X', [
      f.dir('.git', [f.file('HEAD', 'ref'), f.file('config', 'x')]),
      f.file('Thumbs.db', 't'),
      f.file('~$a.docx', 'l'),
      f.file('a.txt', 'hello'),
    ]);
    fire(f, ROOT, 'drop', external([x]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.deepEqual(paths(f.log.commits[0]), ['X/a.txt']);
    assert.ok(f.log.statuses.some((s) => /skipped 3/i.test(s.m)), 'status reports 3 skipped items');
  });
});

test('folder upload: directory entries read in batches (100 + 50) all reach the commit', async () => {
  await run({}, async (f) => {
    const children = Array.from({ length: 150 }, (_, i) => f.file('f' + String(i).padStart(3, '0') + '.txt', 'x'));
    fire(f, ROOT, 'drop', external([f.dir('X', children, 100)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.equal(f.log.commits[0].files.length, 150);
  });
});

test('folder upload: a 0-byte file is committed with empty content', async () => {
  await run({}, async (f) => {
    fire(f, ROOT, 'drop', external([f.dir('X', [f.file('empty.txt', ''), f.file('a.txt', 'hello')])]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.deepEqual(byPath(f.log.commits[0].files), [
      { path: 'X/a.txt', contentB64: 'aGVsbG8=' },
      { path: 'X/empty.txt', contentB64: '' },
    ]);
  });
});

test('folder upload: a rejected commit writes nothing else and reports the error', async () => {
  await run({ commit: () => Promise.reject(new Error('boom')) }, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f)]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.equal(f.log.uploaded, 0, 'the tree is not reloaded after a failure');
    assert.match(errors(f.log), /boom/);
  });
});

test('folder upload: a second drop during an upload is refused', async () => {
  const d = deferred();
  await run({ commit: (n) => (n === 1 ? d.promise : { commit: { sha: 'c2' }, files: [] }) }, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f, 'X')]));
    assert.ok(await waitFor(() => f.log.commits.length === 1), 'the first upload reaches commitFiles');
    fire(f, FOLDER, 'drop', external([sample(f, 'Y')]));
    await settle(f.log);
    d.resolve({ commit: { sha: 'c1' }, files: [] });
    await settle(f.log);
    assert.equal(f.log.commits.length, 1, 'exactly one commit');
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.ok(f.log.statuses.some((s) => /in progress/i.test(s.m)), 'the second drop is told an upload is in progress');
  });
});

test('folder upload: a session change during the commit skips reload and success status', async () => {
  const d = deferred();
  await run({ commit: () => d.promise }, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f)]));
    assert.ok(await waitFor(() => f.log.commits.length === 1), 'the upload reaches commitFiles');
    f.setGeneration(2);
    d.resolve({ commit: { sha: 'c' }, files: [] });
    await settle(f.log);
    assert.equal(f.log.uploaded, 0, 'a stale session must not reload the tree');
    assert.ok(!f.log.statuses.some((s) => !s.e && /^Uploaded/.test(s.m)), 'no success status in the new session');
  });
});

test('folder upload (guard): an internal tree drag dropped on the zone uploads nothing', async () => {
  await run({}, async (f) => {
    fire(f, FOLDER, 'drop', internal());
    await settle(f.log);
    assert.equal(f.log.getTree, 0);
    assert.equal(f.log.commits.length, 0);
    assert.equal(f.log.puts.length, 0);
    assert.equal(f.log.statuses.length, 0);
  });
});

function mockGit({ failBlobAt = 0 } = {}) {
  const calls = [];
  let blobs = 0;
  const res = (ok, status, body) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body), headers: { get: () => null } });
  globalThis.fetch = async (url, options = {}) => {
    const u = String(url);
    const method = options.method || 'GET';
    calls.push({ u, method, body: options.body ? JSON.parse(options.body) : null });
    if (method === 'GET' && u.includes('/git/ref/heads/')) return res(true, 200, { object: { sha: 'parent-sha' } });
    if (method === 'GET' && u.includes('/git/commits/')) return res(true, 200, { sha: 'parent-sha', tree: { sha: 'base-tree' } });
    if (method === 'POST' && u.includes('/git/blobs')) {
      blobs++;
      if (blobs === failBlobAt) return res(false, 422, { message: 'blob failed (mock)' });
      return res(true, 201, { sha: 'blob-' + blobs });
    }
    if (method === 'POST' && u.includes('/git/trees')) return res(true, 201, { sha: 'new-tree' });
    if (method === 'POST' && u.includes('/git/commits')) return res(true, 201, { sha: 'new-commit' });
    if (method === 'PATCH' && u.includes('/git/refs/heads/')) return res(true, 200, { object: { sha: 'new-commit' } });
    return res(false, 404, { message: 'unexpected ' + method + ' ' + u });
  };
  return calls;
}

test('folder upload (guard): GitHubClient.commitFiles sends base64 blobs, one non-forced ref update, no PUT', async () => {
  const saved = globalThis.fetch;
  const calls = mockGit();
  try {
    const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
    await client.commitFiles('main', 'Upload folder X', [
      { path: 'X/a.txt', contentB64: 'aGVsbG8=' },
      { path: 'X/empty.txt', contentB64: '' },
    ]);
    const blobs = calls.filter((c) => c.method === 'POST' && c.u.includes('/git/blobs')).map((c) => c.body);
    assert.deepEqual(blobs, [{ content: 'aGVsbG8=', encoding: 'base64' }, { content: '', encoding: 'base64' }]);
    const refs = calls.filter((c) => c.method === 'PATCH');
    assert.equal(refs.length, 1);
    assert.equal(refs[0].body.force, false);
    assert.equal(calls.filter((c) => c.method === 'PUT').length, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('folder upload (guard): a failed second blob means no commit and no branch update', async () => {
  const saved = globalThis.fetch;
  const calls = mockGit({ failBlobAt: 2 });
  try {
    const client = new GitHubClient({ token: 't', owner: 'o', repo: 'r' });
    await assert.rejects(client.commitFiles('main', 'Upload folder X', [
      { path: 'X/a.txt', contentB64: 'aGVsbG8=' },
      { path: 'X/b.txt', contentB64: 'eA==' },
    ]));
    assert.equal(calls.filter((c) => c.method === 'POST' && c.u.includes('/git/commits')).length, 0);
    assert.equal(calls.filter((c) => c.method === 'PATCH').length, 0);
  } finally {
    globalThis.fetch = saved;
  }
});

test('folder upload (guard): setting the dropzone up twice writes each file once', async () => {
  await run({}, async (f) => {
    setupFolderDropzone(f.dz, f.ov, f.deps);
    fire(f, ROOT, 'drop', external([sample(f)]));
    await settle(f.log);
    const written = f.log.puts.map((p) => p.path)
      .concat(f.log.commits.flatMap((c) => c.files.map((x) => x.path)))
      .sort();
    assert.deepEqual(written, ['X/a.txt', 'X/sub/b.pts']);
  });
});

test('folder upload: an internal dragenter/dragover is left to the tree (no preventDefault, no overlay)', async () => {
  await run({}, async (f) => {
    const enter = fire(f, FOLDER, 'dragenter', internal());
    const over = fire(f, FOLDER, 'dragover', internal());
    assert.equal(enter.defaultPrevented, false, 'dragenter');
    assert.equal(over.defaultPrevented, false, 'dragover');
    assert.equal(f.ov.classList.contains('hidden'), true, 'overlay stays hidden');
  });
});

test('folder upload: a single dropped file gets an "Upload <name>" message', async () => {
  await run({}, async (f) => {
    fire(f, ROOT, 'drop', external([f.file('a.txt', 'hello')]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 1);
    assert.equal(f.log.commits[0].message, 'Upload a.txt');
    assert.deepEqual(paths(f.log.commits[0]), ['a.txt']);
  });
});

test('folder upload: two dropped paths differing only in case write nothing', async () => {
  await run({}, async (f) => {
    fire(f, ROOT, 'drop', external([f.dir('X', [f.file('A.png', 'a'), f.file('a.png', 'b')])]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 0);
    assert.ok(errors(f.log).length > 0, 'an error status is shown');
  });
});

test('folder upload: a file whose path is an existing folder writes nothing', async () => {
  await run({ tree: ['docs/X/y.md'] }, async (f) => {
    fire(f, FOLDER, 'drop', external([f.file('X', 'z')]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 0);
    assert.ok(errors(f.log).length > 0, 'an error status is shown');
  });
});

test('folder upload: after a rejected commit the next drop commits', async () => {
  await run({ commit: (n) => (n === 1 ? Promise.reject(new Error('boom')) : { commit: { sha: 'c2' }, files: [] }) }, async (f) => {
    fire(f, FOLDER, 'drop', external([sample(f, 'X')]));
    await settle(f.log);
    fire(f, FOLDER, 'drop', external([sample(f, 'Y')]));
    await settle(f.log);
    assert.equal(f.log.puts.length, 0, 'no per-file PUT /contents/');
    assert.equal(f.log.commits.length, 2);
    assert.deepEqual(paths(f.log.commits[1]), ['docs/Y/a.txt', 'docs/Y/sub/b.pts']);
    assert.equal(f.log.uploaded, 1);
  });
});
