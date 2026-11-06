import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { uploadImage, setupImageDropzone, pickImageFiles } from '../js/upload.js';
import { updateReferencesInFile, rewriteOwnRelativeLinks } from '../js/reference-rewriter.js';
import { auditImages } from '../js/image-audit.js';

// Image upload (js/upload.js): paste, a drop on the editor and the toolbar
// button all end in uploadImage. These guard tests pin the current behaviour:
// path, commit message, inserted link, preview cache, statuses, and that the
// link it writes is read by the rewriter and the image audit (Architecture
// rule 3). A real Ctrl+V and a drop onto CodeMirror's own DOM are checked by
// hand in production (see AGENTS.md).

const T = 1700000000000;
const NOTE = 'AI corrected/BOBAM/file.md';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** FileReader stand-in: reads File and Blob alike and yields a data: URL. */
class FakeFileReader {
  readAsDataURL(blob) {
    blob.arrayBuffer().then(
      (buf) => {
        this.result = 'data:' + (blob.type || 'application/octet-stream') + ';base64,' + Buffer.from(buf).toString('base64');
        if (this.onload) this.onload();
      },
      () => { if (this.onerror) this.onerror(); },
    );
  }
}

function restoreGlobal(name, value) {
  if (value === undefined) delete globalThis[name];
  else globalThis[name] = value;
}

// Date.now is fixed so the committed path can be compared exactly.
async function withEnv(body) {
  const saved = { FileReader: globalThis.FileReader, now: Date.now };
  globalThis.FileReader = FakeFileReader;
  Date.now = () => T;
  try {
    return await body();
  } finally {
    restoreGlobal('FileReader', saved.FileReader);
    Date.now = saved.now;
  }
}

// Date.now is faked inside withEnv, so waiting uses performance.now().
async function waitFor(pred, max = 2000) {
  const start = performance.now();
  while (performance.now() - start < max) {
    if (pred()) return true;
    await sleep(10);
  }
  return pred();
}

function deferred() {
  let resolve;
  const promise = new Promise((ok) => { resolve = ok; });
  return { promise, resolve };
}

function makeDeps({ currentPath = NOTE, allFiles = ['Asset/x.jpg', NOTE], put = null } = {}) {
  const log = { puts: [], inserted: [], statuses: [], uploaded: 0, cache: [] };
  const makeClient = (name) => ({
    async putFile(path, data, msg) {
      log.puts.push({ client: name, path, b64: data, msg });
      if (put) return put(path, log.puts.length);
      return {};
    },
  });
  const state = { client: makeClient('A') };
  const deps = {
    getClient: () => state.client,
    getImageResolver: () => ({ cache: { set: (key, value) => log.cache.push([key, value]) } }),
    getCurrentPath: () => currentPath,
    getAllFiles: () => allFiles.map((p) => ({ path: p })),
    insertText: (text) => log.inserted.push(text),
    onStatus: (m, isError) => log.statuses.push([String(m), !!isError]),
    onUploaded: () => { log.uploaded++; },
  };
  return { log, deps, state, makeClient };
}

const added = (log) => log.statuses.filter((s) => s[0] === 'Image added \u2713').length;

function dropzone() {
  const dom = new JSDOM('<!doctype html><body><div id="dz"></div><div id="ov" class="hidden"></div></body>');
  const doc = dom.window.document;
  const dz = doc.getElementById('dz');
  const ov = doc.getElementById('ov');
  const fire = (type, dataTransfer) => {
    const ev = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, 'dataTransfer', { value: dataTransfer });
    dz.dispatchEvent(ev);
    return ev;
  };
  return { dom, dz, ov, fire };
}
const osFiles = (files) => ({ types: ['Files'], files, items: [], getData: () => '' });
const internalDrag = () => ({
  types: ['application/x-md-folder', 'text/plain'], files: [], items: [],
  getData: (t) => (t === 'text/plain' ? 'docs' : ''),
});

test('upload (guard): a pasted image is committed to the nearest Asset folder and linked relatively', async () => {
  await withEnv(async () => {
    const { log, deps } = makeDeps();
    const bytes = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
    await uploadImage(new File([bytes], 'my [shot] (1).png', { type: 'image/png' }), deps);
    const path = 'Asset/' + T + '_my__shot___1_.png';
    assert.deepEqual(log.puts, [{ client: 'A', path, b64: b64(bytes), msg: 'Add image ' + path }]);
    assert.deepEqual(log.inserted, ['![my shot (1).png](../../Asset/' + T + '_my__shot___1_.png)']);
    assert.deepEqual(log.cache, [[path, 'data:image/png;base64,' + b64(bytes)]]);
    assert.deepEqual(log.statuses, [['Uploading image...', false], ['Image added \u2713', false]]);
    assert.equal(log.uploaded, 1);
  });
});

test('upload (guard): the inserted link is read by the reference rewriter and the image audit', async () => {
  await withEnv(async () => {
    const { log, deps } = makeDeps();
    await uploadImage(new File([new Uint8Array([1, 2, 3])], 'my [shot] (1).png', { type: 'image/png' }), deps);
    const putPath = log.puts[0].path;
    const text = log.inserted[0] + '\n';

    const moved = updateReferencesInFile(text, 'AI corrected/BOBAM', putPath, 'Asset/moved/pic.png');
    assert.equal(moved.changed, true, 'moving the image must update the inserted link');
    assert.equal(moved.text, '![my shot (1).png](../../Asset/moved/pic.png)\n');

    assert.equal(
      rewriteOwnRelativeLinks(text, 'AI corrected/BOBAM', 'AI corrected'),
      '![my shot (1).png](../Asset/' + T + '_my__shot___1_.png)\n',
    );

    const audit = auditImages({
      files: [{ path: NOTE, sha: 'n' }, { path: 'Asset/x.jpg', sha: 'x' }, { path: putPath, sha: 'p' }],
      texts: new Map([[NOTE, text]]),
    });
    assert.equal(audit.valid, true);
    assert.equal(audit.used.get(putPath), 1);
    assert.deepEqual(audit.unused, ['Asset/x.jpg']);
    assert.deepEqual(audit.broken, []);
  });
});

test('upload (guard): an opaque PNG is compressed, committed, linked and cached as JPEG', async () => {
  await withEnv(async () => {
    const saved = { createImageBitmap: globalThis.createImageBitmap, document: globalThis.document };
    const jpeg = new Uint8Array([255, 216, 255, 1, 2, 3, 4, 5, 6, 7]);
    const calls = [];
    globalThis.createImageBitmap = async () => ({ width: 40, height: 20, close() {} });
    globalThis.document = {
      createElement: () => ({
        width: 0,
        height: 0,
        getContext: () => ({
          drawImage() {},
          getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4).fill(255) }),
        }),
        toBlob: (cb, mime, quality) => { calls.push([mime, quality]); cb(new Blob([jpeg], { type: mime })); },
      }),
    };
    try {
      const { log, deps } = makeDeps();
      await uploadImage(new File([new Uint8Array(200)], 'Screenshot 1.png', { type: 'image/png' }), deps);
      const path = 'Asset/' + T + '_Screenshot_1.jpg';
      assert.deepEqual(calls, [['image/jpeg', 0.85]]);
      assert.deepEqual(log.puts, [{ client: 'A', path, b64: b64(jpeg), msg: 'Add image ' + path }]);
      assert.deepEqual(log.inserted, ['![Screenshot 1.jpg](../../Asset/' + T + '_Screenshot_1.jpg)']);
      assert.deepEqual(log.cache, [[path, 'data:image/jpeg;base64,' + b64(jpeg)]]);
    } finally {
      restoreGlobal('createImageBitmap', saved.createImageBitmap);
      restoreGlobal('document', saved.document);
    }
  });
});

test('upload (guard) current behaviour: a non-markdown file still gets a Markdown image link', async () => {
  await withEnv(async () => {
    const { log, deps } = makeDeps({ currentPath: 'src/app.js', allFiles: ['Asset/x.jpg', 'src/app.js'] });
    await uploadImage(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }), deps);
    assert.deepEqual(log.puts.map((p) => p.path), ['Asset/' + T + '_pic.png']);
    assert.deepEqual(log.inserted, ['![pic.png](../Asset/' + T + '_pic.png)']);
  });
});

test('upload (guard): with no file open nothing is written and an error is shown', async () => {
  await withEnv(async () => {
    const { log, deps } = makeDeps({ currentPath: null });
    await uploadImage(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }), deps);
    assert.deepEqual(log.puts, []);
    assert.deepEqual(log.inserted, []);
    assert.deepEqual(log.cache, []);
    assert.deepEqual(log.statuses, [['Open an .md file first', true]]);
    assert.equal(log.uploaded, 0);
  });
});

test('upload (guard): a failed commit shows the error and inserts nothing', async () => {
  await withEnv(async () => {
    const { log, deps } = makeDeps({ put: () => { throw new Error('boom'); } });
    await uploadImage(new File([new Uint8Array([1])], 'pic.png', { type: 'image/png' }), deps);
    assert.equal(log.puts.length, 1);
    assert.deepEqual(log.statuses, [['Uploading image...', false], ['Image error: boom', true]]);
    assert.deepEqual(log.inserted, []);
    assert.deepEqual(log.cache, []);
    assert.equal(log.uploaded, 0);
  });
});

test('upload (guard): a drop of OS files uploads only the images, one after another; an internal drag is ignored', async () => {
  await withEnv(async () => {
    const gate = deferred();
    const { log, deps } = makeDeps({ put: (path, n) => (n === 1 ? gate.promise : {}) });
    const z = dropzone();
    try {
      setupImageDropzone(z.dz, z.ov, deps);

      const inside = internalDrag();
      assert.equal(z.fire('dragenter', inside).defaultPrevented, false);
      assert.equal(z.fire('dragover', inside).defaultPrevented, false);
      assert.equal(z.ov.classList.contains('hidden'), true, 'an internal drag must not show the overlay');
      assert.equal(z.fire('drop', inside).defaultPrevented, false);
      await sleep(30);
      assert.equal(log.puts.length, 0, 'an internal drag uploads nothing');

      const files = osFiles([
        new File([new Uint8Array([1])], 'a.png', { type: 'image/png' }),
        new File(['text'], 'note.txt', { type: 'text/plain' }),
        new File([new Uint8Array([2])], 'b.jpg', { type: 'image/jpeg' }),
      ]);
      z.fire('dragenter', files);
      assert.equal(z.ov.classList.contains('hidden'), false, 'OS files show the overlay');
      assert.equal(z.fire('dragover', files).defaultPrevented, true);
      assert.equal(z.fire('drop', files).defaultPrevented, true);
      assert.equal(z.ov.classList.contains('hidden'), true, 'the overlay hides on drop');

      assert.ok(await waitFor(() => log.puts.length === 1), 'the first image should start uploading');
      await sleep(30);
      assert.equal(log.puts.length, 1, 'the second image must wait for the first');
      gate.resolve({});
      assert.ok(await waitFor(() => added(log) === 2), 'both images should finish');
      assert.deepEqual(log.puts.map((p) => p.path), ['Asset/' + T + '_a.png', 'Asset/' + T + '_b.jpg']);
      assert.deepEqual(log.inserted, [
        '![a.png](../../Asset/' + T + '_a.png)',
        '![b.jpg](../../Asset/' + T + '_b.jpg)',
      ]);
    } finally {
      z.dom.window.close();
    }
  });
});

test('upload (guard): a second setupImageDropzone is ignored and a drop uses the client current at drop time', async () => {
  await withEnv(async () => {
    const { log, deps, state, makeClient } = makeDeps();
    const z = dropzone();
    try {
      setupImageDropzone(z.dz, z.ov, deps);
      setupImageDropzone(z.dz, z.ov, { ...deps, getClient: () => makeClient('second-setup') });
      state.client = makeClient('B');
      z.fire('drop', osFiles([new File([new Uint8Array([1])], 'a.png', { type: 'image/png' })]));
      assert.ok(await waitFor(() => added(log) === 1), 'the image should be uploaded');
      await sleep(30);
      assert.deepEqual(log.puts.map((p) => p.client), ['B']);
    } finally {
      z.dom.window.close();
    }
  });
});

test('upload (guard): the toolbar picker binds once, uploads every picked file in order and clears the input', async () => {
  await withEnv(async () => {
    const { log, deps } = makeDeps();
    const dom = new JSDOM('<!doctype html><body><input type="file" id="i"></body>');
    try {
      const input = dom.window.document.getElementById('i');
      pickImageFiles(input, deps);
      pickImageFiles(input, deps);
      let value = 'C:/fakepath/one.png';
      Object.defineProperty(input, 'value', { configurable: true, get: () => value, set: (v) => { value = v; } });
      Object.defineProperty(input, 'files', {
        configurable: true,
        value: [
          new File([new Uint8Array([1])], 'one.png', { type: 'image/png' }),
          new File([new Uint8Array([2])], 'two.jpg', { type: 'image/jpeg' }),
        ],
      });
      input.dispatchEvent(new dom.window.Event('change'));
      assert.ok(await waitFor(() => added(log) === 2), 'both files should be uploaded');
      await sleep(30);
      assert.deepEqual(log.puts.map((p) => p.path), ['Asset/' + T + '_one.png', 'Asset/' + T + '_two.jpg']);
      assert.equal(value, '', 'the input must be cleared');
    } finally {
      dom.window.close();
    }
  });
});
