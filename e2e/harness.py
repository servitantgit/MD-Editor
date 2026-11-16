"""Shared e2e harness: GitHub API mocks, helpers, isolated browser sessions.

After Vite, the app must be served by `npx vite --port 8080 --strictPort`.
Each scenario should call `run_isolated(name, fn)` so mocks and UI state do not
leak from a previous scenario (sidebar query, EXTRA_TREE, PUT queues, etc.).
"""
"""End-to-end browser test (not a unit test): launches the app in a real
headless Chromium, replaces the GitHub API with fake responses (so no
real token is needed) and checks editing, scrolling, images, Print (Save as PDF),
HTML Live preview, and view-only PDF/DOCX open + Download.

Run against the Vite dev server (required after the Vite migration — serve.mjs
cannot resolve js/vendor.js npm imports):

  npx vite --port 8080 --strictPort
  python3 e2e_smoke_test.py

Requires: pip install playwright && playwright install chromium

Core editor libraries (EasyMDE, marked, DOMPurify, MiniSearch, …) come from
js/vendor.js via Vite — they are not mocked here. Mammoth (DOCX preview) still
loads on demand from jsDelivr and is stubbed offline below.
"""
import re
import json
import time
import base64
import pathlib
from playwright.sync_api import sync_playwright

BASE = pathlib.Path(__file__).resolve().parent.parent  # repo root

# Every write the app sends to the contents API, with the DECODED markdown —
# putFile() sends base64, so asserting on the raw body would only ever see noise.
CONTENT_WRITES = []

# Scripted HTTP statuses for the NEXT contents-API PUTs, consumed one per request
# (anything not scripted succeeds with 200). `[409]` makes only the first write
# conflict; `[409, 409]` makes two in a row. Every write is recorded in
# CONTENT_WRITES together with the status it was answered with.
PUT_STATUS_QUEUE = []

# Every contents-API GET the app made (full URLs). Lets a test prove that a tab
# came back from memory instead of being fetched again.
FETCH_LOG = []

# Files added to the mock tree on demand (the tabs scenario needs a second note,
# but the default tree must stay a single note: other scenarios count files).
EXTRA_TREE = []
SECOND_MD = "# Second note\n\nSECOND_NOTE_BODY\n"

# The repo-switch scenario opens a SECOND repository through the in-app switcher.
# Its tree/info are served from these so both repos are addressable at once and
# the switch is observable in the request URLs (see REPO_SWITCH_* logs).
SECOND_REPO = "second-owner/second-repo"
SECOND_TREE = [
    {"path": "Asset/pic.jpg", "type": "blob", "sha": "sha-pic-2"},
    {"path": "Notes/Test note.md", "type": "blob", "sha": "sha-note-2"},
]

# Full URLs of every contents-API PUT, recorded from the moment the scenario
# starts, so "exactly ONE PUT and it went to repo X" is checkable.
PUT_URLS = []

# Git Data API traffic (commitTreeChanges): every POSTed tree with its entries,
# every new blob and every branch-ref update. A folder move must be ONE commit:
# one tree, one ref update, no per-file contents PUT/DELETE.
GIT_TREES = []
GIT_BLOBS = []
GIT_REF_UPDATES = []

# Repositories the switcher lists. Includes the one already open, because the
# real UI marks it "· current" and clicking it is a no-op by design.
USER_REPOS = [
    {"full_name": "test-owner/test-repo", "name": "test-repo",
     "owner": {"login": "test-owner"}, "private": False, "description": "first", "pushed_at": ""},
    {"full_name": SECOND_REPO, "name": "second-repo",
     "owner": {"login": "second-owner"}, "private": False, "description": "second", "pushed_at": ""},
]

TINY_PNG_B64 = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
    "de0000000c4944415408d763f8ffff3f0005fe02fea1f6e4a50000000049454e"
    "44ae426082"
)).decode()

def make_clear_document_state(page):
    """Snapshot of the editor's document state (text, undo depth, find marks, find bar, dirty tabs).
    Shared by the scenario modules: it used to be a nested function of the monolith."""
    def clear_document_state():
        return page.evaluate("""() => {
            const cm = document.querySelector('.CodeMirror').CodeMirror;
            return {
                text:cm.getValue(), history:cm.historySize(),
                marks:cm.getAllMarks().filter(m =>
                    m.className === 'md-find-match' ||
                    m.className === 'md-find-current').length,
                findHidden:document.getElementById('find-bar').classList.contains('hidden'),
                dirtyTabs:document.querySelectorAll('#tab-bar .tab.dirty').length
            };
        }""")
    return clear_document_state


def make_solid_png(width, height, rgb):
    """Solid-colour PNG, so the image has measurable ink in the exported PDF."""
    import struct
    import zlib

    def chunk(tag, data):
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    raw = b"".join(b"\x00" + bytes(rgb) * width for _ in range(height))
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9))
            + chunk(b"IEND", b""))


# Taller than one printable A4 page, so without the page-break fix it would be
# sliced in half by the page boundary.
TALL_PNG_B64 = base64.b64encode(make_solid_png(400, 1400, (200, 30, 30))).decode()

MD_INTRO = "# Test note\n\nHello world.\n\n![pic](../../Asset/pic.jpg)\n"
# Filler pushes the tall image across a page boundary, which is what makes the
# "images are never split" assertion below meaningful rather than vacuous.
MD_FILLER = ("\n\n".join(f"Filler paragraph {i}." for i in range(30))
             + "\n\n![tall](../../Asset/tall.png)\n")
LONG_BODY = "\n".join(f"Line {i} - text to force the editor to overflow vertically." for i in range(400))
MD_CONTENT = MD_INTRO + MD_FILLER + LONG_BODY + "\n"

def complete_new_file_dialog(page, filename: str):
    """Drive the in-app New file dialog (name + type). Replaces window.prompt for files."""
    # Open: visible overlay (no .hidden)
    page.wait_for_selector("#new-file-overlay:not(.hidden)", state="visible", timeout=8000)
    stem, _, ext = filename.rpartition(".")
    if not stem:
        stem, ext = filename, "md"
    page.fill("#new-file-name", stem)
    page.select_option("#new-file-type", ext)
    # Folder label must not contain PointerEvent (same regression as the old prompt)
    label = page.locator("#new-file-folder-label").inner_text()
    assert "PointerEvent" not in label and "object" not in label.lower(), label
    page.click("#btn-new-file-ok")
    # Closed overlay has class "hidden" → not visible. Default wait_for_selector
    # requires visible=true, so waiting for "#new-file-overlay.hidden" always times out.
    page.wait_for_selector("#new-file-overlay", state="hidden", timeout=8000)



FAKE_TREE = {
    "tree": [
        {"path": "Asset/pic.jpg", "type": "blob", "sha": "sha-pic"},
        {"path": "Asset/tall.png", "type": "blob", "sha": "sha-tall"},
        {"path": "Notes/Test note.md", "type": "blob", "sha": "sha-note"},
    ]
}

# Minimal valid-enough PDF for native iframe preview (view-only panel).
MINIMAL_PDF_BYTES = (
    b"%PDF-1.1\n"
    b"1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n"
    b"2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n"
    b"3 0 obj<</Type/Page/MediaBox[0 0 300 144]/Parent 2 0 R>>endobj\n"
    b"trailer<</Size 4/Root 1 0 R>>\n"
    b"startxref\n0\n%%EOF\n"
)
MINIMAL_PDF_B64 = base64.b64encode(MINIMAL_PDF_BYTES).decode()


def _minimal_docx_bytes():
    """Tiny OOXML package with one paragraph — enough for Mammoth/stub paths."""
    import io
    import zipfile
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as z:
        z.writestr(
            "[Content_Types].xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/word/document.xml" '
            'ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
            '</Types>',
        )
        z.writestr(
            "_rels/.rels",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" '
            'Target="word/document.xml"/>'
            '</Relationships>',
        )
        z.writestr(
            "word/document.xml",
            '<?xml version="1.0" encoding="UTF-8"?>'
            '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
            '<w:body><w:p><w:r><w:t>DOCX_BODY_OK</w:t></w:r></w:p></w:body>'
            '</w:document>',
        )
    return buf.getvalue()


MINIMAL_DOCX_BYTES = _minimal_docx_bytes()
MINIMAL_DOCX_B64 = base64.b64encode(MINIMAL_DOCX_BYTES).decode()

# Stub Mammoth so e2e does not depend on the real CDN (offline CI).
MAMMOTH_STUB_JS = b"""
window.mammoth = {
  convertToHtml: function () {
    return Promise.resolve({ value: '<p>DOCX_PREVIEW_OK</p>', messages: [] });
  }
};
"""


def handle_github_api(route, request):
    url = request.url
    # Writes first: the content GETs below match on URL alone, so a PUT would
    # otherwise be answered with a file body and no `content.sha` for the app to
    # remember. Autosave commits land here, which is what makes the "exactly one
    # PUT, with this text in it" assertions below possible.
    if "/contents/" in url and request.method in ("PUT", "DELETE"):
        body = {}
        try:
            body = json.loads(request.post_data or "{}")
        except ValueError:
            pass
        text = ""
        if body.get("content"):
            try:
                text = base64.b64decode(body["content"]).decode("utf-8", "replace")
            except Exception:
                pass
        status = PUT_STATUS_QUEUE.pop(0) if (request.method == "PUT" and PUT_STATUS_QUEUE) else 200
        CONTENT_WRITES.append({
            "url": url,
            "method": request.method,
            "message": body.get("message"),
            "sha": body.get("sha"),
            "text": text,
            "status": status,
        })
        if request.method == "PUT":
            # Lets the repo-switch scenario prove WHICH repository a write landed
            # in — that is the whole regression (see the scenario near the end).
            PUT_URLS.append(url)
        if status == 409:
            route.fulfill(status=409, content_type="application/json", body=json.dumps(
                {"message": "sha does not match (mock)"}))
            return
        if request.method == "PUT":
            route.fulfill(status=200, content_type="application/json", body=json.dumps(
                {"content": {"sha": f"sha-put-{len(CONTENT_WRITES)}"}, "commit": {"sha": "c"}}))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({"commit": {"sha": "c"}}))
        return
    # Git Data API: the ONE atomic commit behind folder moves (commitTreeChanges):
    # ref -> parent commit -> [blobs] -> tree -> commit -> ref update. The
    # recursive tree GET (/git/trees/<ref>) is NOT handled here: it falls through.
    git_path = url.split("?", 1)[0]
    if "/git/" in git_path and (request.method != "GET" or "/git/ref/heads/" in git_path or "/git/commits/" in git_path):
        body = {}
        try:
            body = json.loads(request.post_data or "{}")
        except ValueError:
            pass
        if request.method == "GET" and "/git/ref/heads/" in git_path:
            data = {"object": {"sha": f"c-head-{len(GIT_REF_UPDATES)}"}}
        elif request.method == "GET":
            data = {"sha": git_path.rsplit("/", 1)[-1], "tree": {"sha": "t-base"}}
        elif request.method == "POST" and git_path.endswith("/git/blobs"):
            GIT_BLOBS.append(url)
            data = {"sha": f"b-new-{len(GIT_BLOBS)}"}
        elif request.method == "POST" and git_path.endswith("/git/trees"):
            GIT_TREES.append({"url": url, "base_tree": body.get("base_tree"), "tree": body.get("tree") or []})
            data = {"sha": f"t-new-{len(GIT_TREES)}"}
        elif request.method == "POST" and git_path.endswith("/git/commits"):
            data = {"sha": f"c-new-{len(GIT_TREES)}", "tree": {"sha": body.get("tree")}}
        elif request.method == "PATCH" and "/git/refs/heads/" in git_path:
            GIT_REF_UPDATES.append({"url": url, "sha": body.get("sha")})
            data = {"ref": "refs/heads/main", "object": {"sha": body.get("sha")}}
        else:
            route.fulfill(status=404, content_type="application/json", body=json.dumps({"message": "Not Found (mock git)"}))
            return
        route.fulfill(status=200, content_type="application/json", body=json.dumps(data))
        return
    if "/contents/" in url:
        FETCH_LOG.append(url)
    # The in-app repo switcher lists the user's repositories.
    if "/user/repos" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps(USER_REPOS))
        return
    if re.search(r"/repos/[^/]+/[^/]+$", url) and "/git/" not in url and "/contents/" not in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"default_branch": "main"}))
    elif "/git/trees/" in url:
        # Repository-aware: the recursive tree must describe the repo actually
        # being opened, otherwise the switch is invisible to the app.
        tree = SECOND_TREE if SECOND_REPO in url else FAKE_TREE["tree"] + EXTRA_TREE
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"tree": tree}))
    elif "/contents/Notes/Test%20note.md" in url:
        b64 = base64.b64encode(MD_CONTENT.encode("utf-8")).decode()
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": b64, "sha": "sha-note"}))
    elif "/contents/Notes/Second%20note.md" in url:
        b64 = base64.b64encode(SECOND_MD.encode("utf-8")).decode()
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": b64, "sha": "sha-second"}))
    elif "/contents/Asset/pic.jpg" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": TINY_PNG_B64, "sha": "sha-pic"}))
    elif "/contents/Asset/tall.png" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": TALL_PNG_B64, "sha": "sha-tall"}))
    elif "/contents/Notes/page.html" in url:
        html_body = "<!DOCTYPE html><html><body><h1>HTML_PAGE_OK</h1><p>Hello HTML preview</p></body></html>"
        b64 = base64.b64encode(html_body.encode("utf-8")).decode()
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": b64, "sha": "sha-html"}))
    elif "/contents/Docs/sample.pdf" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "content": MINIMAL_PDF_B64, "sha": "sha-pdf", "size": len(MINIMAL_PDF_BYTES),
        }))
    elif "/contents/Docs/sample.docx" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "content": MINIMAL_DOCX_B64, "sha": "sha-docx", "size": len(MINIMAL_DOCX_BYTES),
        }))
    elif "/contents/DragSrc/move-me.txt" in url or "/contents/DragTarget/DragSrc/move-me.txt" in url:
        # Scenario I: moveFile reads the source before PUTting it at the new path.
        b64 = base64.b64encode(b"move me please\n").decode()
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": b64, "sha": "sha-mv1"}))
    elif re.search(r"/repos/[^/]+/[^/]+/commits(/[a-f0-9]+)?(\?|$)", url) and request.method == "GET":
        # History panel: list or single commit
        if url.rstrip("/").endswith("/commits") or "/commits?" in url:
            route.fulfill(status=200, content_type="application/json", body=json.dumps([
                {
                    "sha": "abc1234deadbeef",
                    "commit": {
                        "message": "Mock history commit",
                        "author": {"name": "Tester", "date": "2026-01-15T12:00:00Z"},
                    },
                    "html_url": "https://github.com/test-owner/test-repo/commit/abc1234deadbeef",
                }
            ]))
        else:
            route.fulfill(status=200, content_type="application/json", body=json.dumps({
                "sha": "abc1234deadbeef",
                "commit": {
                    "message": "Mock history commit",
                    "author": {"name": "Tester", "date": "2026-01-15T12:00:00Z"},
                },
                "files": [],
            }))
    else:
        route.fulfill(status=404, content_type="application/json", body=json.dumps({"message": "Not Found (mock)"}))


def measure_red_per_page(page, streams):
    """Decode each page image in the browser and measure it.

    Returns one dict per page: `red` = pixels of the red test image, `firstRow` =
    first row containing red, `rows` = rows sampled, and `ink` = pixels darker than
    paper white (text, code blocks, images) — what tells a rendered page from a
    blank one.
    """
    results = []
    for blob in streams:
        b64 = base64.b64encode(blob).decode()
        results.append(page.evaluate("""async (b64) => {
            const img = new Image();
            img.src = 'data:image/jpeg;base64,' + b64;
            await img.decode();
            const c = document.createElement('canvas');
            c.width = 200;
            c.height = Math.max(1, Math.round(200 * img.height / img.width));
            const ctx = c.getContext('2d');
            ctx.drawImage(img, 0, 0, c.width, c.height);
            const d = ctx.getImageData(0, 0, c.width, c.height).data;
            let red = 0, firstRow = -1, ink = 0;
            for (let i = 0; i < d.length; i += 4) {
                if ((d[i] + d[i + 1] + d[i + 2]) / 3 < 200) ink++;
                if (d[i] > 120 && d[i] > d[i + 1] + 40 && d[i] > d[i + 2] + 40) {
                    red++;
                    if (firstRow < 0) firstRow = Math.floor(i / 4 / c.width);
                }
            }
            return {red: red, firstRow: firstRow, rows: c.height, ink: ink};
        }""", b64))
    return results


# A rendered page has text or an image on it; a blank one has (almost) no pixel darker
# than paper white. Measured on a 200px-wide copy of the page; the threshold is
# deliberately far below any real page.
PDF_MIN_INK_PX = 50

page_errors = []



BASE_URL = "http://localhost:8080/"


def reset_mock_state():
    """Clear every global the mock handlers and scenarios mutate."""
    CONTENT_WRITES.clear()
    FETCH_LOG.clear()
    EXTRA_TREE.clear()
    PUT_URLS.clear()
    GIT_TREES.clear()
    GIT_BLOBS.clear()
    GIT_REF_UPDATES.clear()
    # optional queues used by 409 / hold scenarios
    global PUT_STATUS_QUEUE
    try:
        PUT_STATUS_QUEUE.clear()
    except NameError:
        pass


def install_routes(page):
    page.route(re.compile(r"https://api\.github\.com/.*"), handle_github_api)
    # Legacy icon CDN hosts (Font Awesome is bundled). Harmless empty CSS.
    page.route(re.compile(r"https://cdnjs\.cloudflare\.com/.*"),
               lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    page.route(re.compile(r"https://maxcdn\.bootstrapcdn\.com/.*"),
               lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    # Mammoth may still be requested only if a build falls back to CDN; stub offline.
    page.route(
        re.compile(r"https://cdn\.jsdelivr\.net/npm/mammoth@[^/]+/mammoth\.browser\.min\.js"),
        lambda route, _: route.fulfill(status=200, content_type="text/javascript", body=MAMMOTH_STUB_JS),
    )


def login_test_user(page):
    page.evaluate("""() => {
        sessionStorage.setItem('gh_token', 'ghp_faketoken');
        sessionStorage.setItem('gh_owner', 'test-owner');
        sessionStorage.setItem('gh_repo', 'test-repo');
        sessionStorage.setItem('gh_branch', 'main');
    }""")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)", timeout=15000)


def run_isolated(name, fn):
    """Fresh browser + mocks + optional login inside fn. No state from prior scenarios."""
    reset_mock_state()
    print(f"\n=== scenario: {name} ===")
    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
        page_errors = []
        page.on("pageerror", lambda exc: page_errors.append(str(exc)))
        install_routes(page)
        page.add_init_script(MAMMOTH_STUB_JS.decode("utf-8"))
        page.goto(BASE_URL, wait_until="networkidle")
        try:
            # browser is passed so a scenario can open a fresh page (legacy J/N style)
            fn(page, page_errors, browser)
            if page_errors:
                raise AssertionError(f"{name}: unhandled page errors: {page_errors}")
            print(f"✓ scenario {name} finished")
        finally:
            browser.close()
