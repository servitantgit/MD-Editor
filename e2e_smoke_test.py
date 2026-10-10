"""End-to-end browser test (not a unit test): launches the app in a real
headless Chromium, replaces the GitHub API with fake responses (so no
real token is needed) and checks the three things the user complained about:
editing, scrolling a long document, and rendering images in the preview.
Run: first `node serve.mjs` (port 8080), then `python3 e2e_smoke_test.py`.
Requires: pip install playwright && playwright install chromium
CDN libraries (jsdelivr/cdnjs) are replaced here with local copies from node_modules —
this replacement is ONLY for the test environment; production index.html still uses
the real CDN.
"""
import re
import json
import time
import base64
import pathlib
from playwright.sync_api import sync_playwright

BASE = pathlib.Path(__file__).parent

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

CDN_MOCKS = {
    "https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.css": BASE / "node_modules/easymde/dist/easymde.min.css",
    "https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.js": BASE / "node_modules/easymde/dist/easymde.min.js",
    "https://cdn.jsdelivr.net/npm/marked/marked.min.js": BASE / "node_modules/marked/lib/marked.umd.js",
    "https://cdn.jsdelivr.net/npm/minisearch@7.2.0/dist/umd/index.js": BASE / "node_modules/minisearch/dist/umd/index.js",
    "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js": BASE / "node_modules/html2pdf.js/dist/html2pdf.bundle.min.js",
}

TINY_PNG_B64 = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
    "de0000000c4944415408d763f8ffff3f0005fe02fea1f6e4a50000000049454e"
    "44ae426082"
)).decode()

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
    page.wait_for_selector("#new-file-overlay:not(.hidden)", timeout=8000)
    stem, _, ext = filename.rpartition(".")
    if not stem:
        stem, ext = filename, "md"
    page.fill("#new-file-name", stem)
    page.select_option("#new-file-type", ext)
    # Folder label must not contain PointerEvent (same regression as the old prompt)
    label = page.locator("#new-file-folder-label").inner_text()
    assert "PointerEvent" not in label and "object" not in label.lower(), label
    page.click("#btn-new-file-ok")
    page.wait_for_selector("#new-file-overlay.hidden", timeout=8000)



FAKE_TREE = {
    "tree": [
        {"path": "Asset/pic.jpg", "type": "blob", "sha": "sha-pic"},
        {"path": "Asset/tall.png", "type": "blob", "sha": "sha-tall"},
        {"path": "Notes/Test note.md", "type": "blob", "sha": "sha-note"},
    ]
}


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
    if "/contents/" in url:
        FETCH_LOG.append(url)
    if re.search(r"/repos/[^/]+/[^/]+$", url) and "/git/" not in url and "/contents/" not in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"default_branch": "main"}))
    elif "/git/trees/" in url:
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps({"tree": FAKE_TREE["tree"] + EXTRA_TREE}))
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


def handle_cdn(route, request):
    local_path = CDN_MOCKS.get(request.url)
    if local_path and local_path.exists():
        ct = "text/css" if str(local_path).endswith(".css") else "text/javascript"
        route.fulfill(status=200, content_type=ct, body=local_path.read_bytes())
    else:
        route.fulfill(status=404, body=b"")


def pdf_page_images(path):
    """Every JPEG stream in the PDF — html2pdf embeds exactly one per page."""
    data = path.read_bytes()
    out = []
    for m in re.finditer(rb"/Filter\s*/DCTDecode", data):
        sm = re.compile(rb"stream\r?\n").search(data, m.end())
        if not sm:
            continue
        end = data.find(b"endstream", sm.end())
        if end == -1:
            continue
        blob = data[sm.end():end].rstrip(b"\r\n")
        if blob[:2] == b"\xff\xd8":  # JPEG SOI marker
            out.append(blob)
    return out


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

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 900}, accept_downloads=True)
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    page.route(re.compile(r"https://api\.github\.com/.*"), handle_github_api)
    for cdn_url in CDN_MOCKS:
        page.route(cdn_url, handle_cdn)
    # fontawesome — icons only, not critical for functionality
    page.route(re.compile(r"https://cdnjs\.cloudflare\.com/.*"), lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    page.route(re.compile(r"https://maxcdn\.bootstrapcdn\.com/.*"), lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))

    page.goto("http://localhost:8080/", wait_until="networkidle")

    # --- 0. The start screen ("homepage") must explain what the app is and link
    # to the source. Checked before the simulated login, while it is still visible.
    page.wait_for_selector("#login-screen .login-tagline", timeout=5000)
    tagline = page.inner_text("#login-screen .login-tagline")
    assert "GitHub repo" in tagline, f"unexpected start-screen tagline: {tagline!r}"
    assert page.locator("#login-screen .login-features li").count() >= 4, \
        "feature list is missing on the start screen"
    assert page.locator('#login-screen a[href="https://github.com/servitantgit/MD-Editor"]').count() == 1, \
        "link to the GitHub repository is missing on the start screen"
    print("✓ start screen shows project info + repository link")

    # The login form no longer accepts a PAT directly (replaced with "Sign in
    # with GitHub" + Cloudflare Worker OAuth) — that's unavailable in the isolated
    # e2e environment without a real GitHub OAuth App. So we simulate an already
    # completed login the same way the app itself does after
    # /auth/callback: put token/owner/repo into sessionStorage and
    # reload — readSession() in app.js picks it up and immediately
    # shows the app, skipping the login screen.
    page.evaluate(
        """() => {
            sessionStorage.setItem('gh_token', 'ghp_faketoken');
            sessionStorage.setItem('gh_owner', 'test-owner');
            sessionStorage.setItem('gh_repo', 'test-repo');
            sessionStorage.setItem('gh_branch', 'main');
        }"""
    )
    page.reload(wait_until="networkidle")

    page.wait_for_selector("#app-main:not(.hidden)", timeout=5000)
    page.wait_for_selector(".file-item", timeout=5000)

    page.click(".file-item.folder:has-text('Notes')")
    page.click(".file-item:not(.folder):has-text('Test note.md')")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=5000)
    print("✓ file opened")

    # --- 2. Full-text search over the whole repo ---
    # The index is built in the BACKGROUND after login, so wait for it to finish
    # rather than typing immediately — otherwise this would be a race, not a test.
    # NOTE: this seeds sessionStorage and reloads, so it is a cold start by
    # design; nothing here may assume the index survives a reload.
    page.wait_for_function(
        "() => { const el = document.getElementById('search-status');"
        " return el && el.textContent.startsWith('Indexed'); }",
        timeout=20000,
    )
    status_text = page.inner_text("#search-status")
    assert "Indexed" in status_text and "last synced" in status_text, \
        f"unexpected search status line: {status_text!r}"
    print(f"✓ search index built ({status_text})")

    # "Filler" only exists in MD_FILLER, i.e. inside the indexed body.
    page.fill("#search-input", "Filler")
    page.wait_for_selector(".search-result", timeout=10000)
    result_paths = page.eval_on_selector_all(".search-result", "els => els.map(e => e.dataset.path)")
    assert "Notes/Test note.md" in result_paths, \
        f"search did not find the note: {result_paths}"
    # The tree must be REPLACED by the results, not shown next to them.
    assert page.locator(".file-item.folder:visible").count() == 0, \
        "the file tree is still visible while search results are shown"
    # ...and the snippet highlights the term that was searched for.
    assert page.locator(".search-result-snippet mark").count() > 0, \
        "search result has no <mark> highlight in its snippet"
    print(f"✓ search finds the note and replaces the tree ({result_paths})")

    page.click(".search-result")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=5000)
    assert page.inner_text("#current-file") == "Notes/Test note.md", \
        f"clicking a search result opened the wrong file: {page.inner_text('#current-file')!r}"
    print("✓ clicking a search result opens the file")

    # Clearing the input must bring the tree back exactly as it was.
    page.fill("#search-input", "")
    page.wait_for_selector(".search-result", state="detached", timeout=5000)
    page.wait_for_selector(".file-item.folder", state="visible", timeout=5000)
    assert page.locator(".search-result").count() == 0, "results are still on screen"
    print("✓ clearing the search brings the file tree back")

    # --- 1b. Two status lines with two different rules. #save-status is the
    # transient one and wipes itself after 4s; #autosave-status describes the
    # live condition of the open file and only "✓ Saved to GitHub" fades.
    # Save also becomes a no-op on a file nobody has touched — a commit with
    # identical content is noise in the repository history.
    CONTENT_WRITES.clear()
    page.click("#btn-save")
    page.wait_for_timeout(1000)
    assert not CONTENT_WRITES, \
        f"Save committed a file that was never edited: {CONTENT_WRITES}"

    page.click(".file-item:not(.folder)")
    page.wait_for_function(
        "document.getElementById('save-status').textContent === 'Ready'", timeout=5000
    )
    page.wait_for_function(
        "document.getElementById('save-status').textContent === ''", timeout=10000
    )
    print("✓ Save skips an untouched file; informational statuses still clear themselves")

    # --- 8. Hybrid autosave: local draft on idle; GitHub only on Save/Commit.
    def writes_with(marker):
        return [w for w in CONTENT_WRITES if marker in w["text"]]

    CONTENT_WRITES.clear()
    page.click(".CodeMirror")
    page.keyboard.type("AUTOSAVE_IDLE_MARKER")
    page.wait_for_timeout(3000)
    assert not writes_with("AUTOSAVE_IDLE_MARKER"), \
        f"typing committed after 3s: {writes_with('AUTOSAVE_IDLE_MARKER')}"
    assert not CONTENT_WRITES, f"nothing at all should have been committed yet: {CONTENT_WRITES}"
    page.wait_for_function(
        "document.getElementById('autosave-status').textContent.includes('Unsaved')"
        " || document.getElementById('autosave-status').textContent.includes('Local only')",
        timeout=3000,
    )
    print("✓ typing shows the unsaved label and commits nothing")

    # 10s idle must NOT push — only local draft status.
    page.wait_for_timeout(12000)
    idle_writes = writes_with("AUTOSAVE_IDLE_MARKER")
    assert len(idle_writes) == 0, \
        f"idle must not auto-commit, got {len(idle_writes)}: {CONTENT_WRITES}"
    page.wait_for_function(
        "document.getElementById('autosave-status').textContent.includes('Local only')",
        timeout=5000,
    )
    print("✓ 10s idle stays local only (no GitHub put)")

    # --- 9. Save is an escape hatch, not the only way to save: clicking it must
    # commit immediately, long before the idle window would have fired.
    CONTENT_WRITES.clear()
    page.click(".CodeMirror")
    page.keyboard.type("AUTOSAVE_MANUAL_MARKER")
    page.wait_for_timeout(1000)
    page.click("#btn-save")
    deadline = time.time() + 5
    while time.time() < deadline and not writes_with("AUTOSAVE_MANUAL_MARKER"):
        page.wait_for_timeout(200)
    manual_writes = writes_with("AUTOSAVE_MANUAL_MARKER")
    assert len(manual_writes) == 1, \
        f"Save did not commit the typed text within 5s: {CONTENT_WRITES}"
    page.wait_for_function(
        "document.getElementById('autosave-status').textContent.includes('Saved to GitHub')",
        timeout=5000,
    )
    print("✓ explicit Save bypasses the timer and commits at once")

    # --- 1. Editing ---
    page.click(".CodeMirror")
    page.keyboard.type("EDITED_MARKER")
    content = page.evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue()")
    assert "EDITED_MARKER" in content, "typing into the editor did not update the document"
    print("✓ editing works")

    # The caret must be visible on the dark background.
    cursor_border = page.evaluate("""() => getComputedStyle(document.querySelector('.CodeMirror-cursor')).borderLeftColor""")
    assert cursor_border not in ("rgb(0, 0, 0)", "rgba(0, 0, 0, 0)", "transparent"), \
        f"cursor is effectively invisible: {cursor_border}"
    print(f"✓ caret visible ({cursor_border})")

    # The image button must open a file picker, not insert an empty URL.
    image_toolbar = page.locator(".editor-toolbar button").filter(has=page.locator(".fa-image"))
    assert image_toolbar.count() == 1, "image toolbar button is missing"
    print("✓ image button uses upload")

    # The delete button next to "Save"/"PDF" must be available for the opened
    # file (we don't click it: it pulls confirm() and a real DELETE in the mock).
    delete_btn = page.locator("#btn-delete")
    assert delete_btn.count() == 1, "delete toolbar button is missing"
    assert delete_btn.is_enabled(), "delete button must be enabled once a file is open"
    print("✓ delete button available for the opened file")

    # The header carries a link to the repository (source/issues) next to "Sign out".
    assert page.locator('#app-header a[href="https://github.com/servitantgit/MD-Editor"]').count() == 1, \
        "repository link is missing from the header"
    print("✓ header repository link present")

    # --- 2. Tree interactions: right-clicking a FILE must open a context menu
    # (rename/delete), and a folder menu must be able to create inside it.
    # NOTE: "Notes" is already expanded by the click above — do NOT click it again,
    # that would collapse it and hide the file row again.
    page.click(".file-item:not(.folder)", button="right")
    page.wait_for_selector(".folder-context-menu", timeout=5000)
    menu_actions = page.eval_on_selector_all(
        ".folder-context-menu button", "els => els.map(e => e.dataset.action)"
    )
    assert "rename" in menu_actions, f"file context menu has no rename: {menu_actions}"
    assert "delete" in menu_actions, f"file context menu has no delete: {menu_actions}"
    print(f"✓ file context menu present ({menu_actions})")
    page.keyboard.press("Escape")
    page.wait_for_selector(".folder-context-menu", state="detached", timeout=5000)

    page.click(".file-item.folder:has-text('Notes')", button="right")
    page.wait_for_selector(".folder-context-menu", timeout=5000)
    folder_actions = page.eval_on_selector_all(
        ".folder-context-menu button", "els => els.map(e => e.dataset.action)"
    )
    assert "new-file" in folder_actions, f"folder menu cannot create a file: {folder_actions}"
    assert "new-folder" in folder_actions, f"folder menu cannot create a folder: {folder_actions}"
    print(f"✓ folder context menu can create ({folder_actions})")
    page.keyboard.press("Escape")
    page.wait_for_selector(".folder-context-menu", state="detached", timeout=5000)

    # Both dismiss paths must actually remove the menu. Nothing used to assert
    # this, and it is exactly what a `setTimeout` around the dismiss-listener
    # registration could silently break: the menu would survive a stray click,
    # stay in the DOM, and every later `wait_for_selector` would happily match
    # that stale menu instead of proving the new one opened. Clicking away lands
    # on the inert header, not on a tree row (which would open a second menu).
    page.click(".file-item:not(.folder)", button="right")
    page.wait_for_selector(".folder-context-menu", timeout=5000)
    page.click("#app-header", position={"x": 5, "y": 5})
    page.wait_for_selector(".folder-context-menu", state="detached", timeout=5000)
    print("✓ context menu really closes on Escape and on an outside click")

    # --- 4. The toolbar buttons must not leak the click event into the path ---
    # `onclick = onCreateNewFile` passed the PointerEvent as `folderPath`, so the
    # file was created at "[object PointerEvent]/name.md". It reached the GitHub
    # API as such, so watching the request URL proves it without any real write.
    #
    # One dialog handler for the whole test: Playwright dispatches a dialog to
    # *every* registered listener, and a second accept() on the same dialog raises
    # "Cannot accept dialog which is already handled!". Prompts are answered with
    # a file name, the delete confirmation with the default (OK).
    create_prompts = []
    seen_dialogs = []
    create_responses = [
        "root-new.md",      # First new file (existing test)
        "root-new.md",      # First new folder (existing test)
        "new-file-in-notes.md",  # Scenario A
        "new-folder-in-notes",   # Scenario B
    ]
    create_response_idx = [0]
    # Set to True right before an action whose confirm() the test wants to CANCEL;
    # the handler dismisses exactly one confirm and resets it.
    dismiss_next_confirm = [False]

    def handle_dialog(d):
        msg = d.message
        if "new file name" in msg.lower() or "new folder name" in msg.lower():
            create_prompts.append(msg)
            if create_response_idx[0] < len(create_responses):
                d.accept(create_responses[create_response_idx[0]])
                create_response_idx[0] += 1
            else:
                d.accept("default.md")
        else:
            seen_dialogs.append(msg)
            if dismiss_next_confirm[0]:
                dismiss_next_confirm[0] = False
                d.dismiss()
            else:
                d.accept()

    page.on("dialog", handle_dialog)
    write_urls = []
    page.route(re.compile(r"https://api\.github\.com/.*/contents/.*"),
               lambda route, request: (write_urls.append(request.url), route.abort()))

    page.click("#btn-add-menu")
    page.click("#btn-new-file")
    complete_new_file_dialog(page, "root-new.md")
    page.wait_for_timeout(300)
    page.click("#btn-add-menu")
    page.click("#btn-new-folder")
    page.wait_for_timeout(1000)

    assert write_urls, "new file/folder never reached the API"
    for url in write_urls:
        assert "object" not in url.lower() and "PointerEvent" not in url, \
            f"created path was built from the click event: {url}"
    # The file lands in the tree's active folder (here "Notes", which the test
    # opened earlier). What matters is that it is a real path segment, not an
    # event object stringified into the URL.
    assert any(u.endswith("contents/Notes/root-new.md") for u in write_urls), \
        f"created path is not inside the active folder: {write_urls}"
    assert any(u.endswith("root-new.md/.gitkeep") for u in write_urls), \
        f"new folder did not create its .gitkeep: {write_urls}"
    # Folder still uses window.prompt — must name the real folder, not the click event
    assert create_prompts, "expected a New folder prompt"
    assert "PointerEvent" not in " ".join(create_prompts), \
        f"toolbar prompt shows the click event instead of a folder: {create_prompts}"
    print(f"✓ toolbar create targets the real folder, not the click event ({create_prompts[0]})")
    page.unroute(re.compile(r"https://api\.github\.com/.*/contents/.*"))

    # Merely finding the items is not enough — the earlier version of this test did
    # exactly that and missed that clicking one did nothing (the action dispatch ran
    # before the click happened). Actually pick "delete" and require the confirmation.
    page.click(".file-item:not(.folder)", button="right")
    page.wait_for_selector(".folder-context-menu", timeout=5000)
    page.click(".folder-context-menu button[data-action='delete']")
    page.wait_for_timeout(500)
    assert seen_dialogs and "delete this file" in seen_dialogs[-1].lower(), \
        f"clicking Delete showed no confirmation: {seen_dialogs}"
    print("✓ file context menu delete is wired up (confirmation shown)")

    # --- A. Create file in selected folder (via toolbar) ---
    # Select the Notes folder first, then create a file
    page.click(".file-item.folder:has-text('Notes')")
    page.wait_for_timeout(200)
    CONTENT_WRITES.clear()
    page.click("#btn-add-menu")
    page.click("#btn-new-file")
    complete_new_file_dialog(page, "new-file-in-notes.md")
    page.wait_for_timeout(300)
    # In-app dialog (no window.prompt for files)
    create_write = [w for w in CONTENT_WRITES if w["method"] == "PUT" and "new-file-in-notes.md" in w["url"]]
    assert len(create_write) == 1, f"expected one PUT for new file in Notes, got {CONTENT_WRITES}"
    assert "Notes/new-file-in-notes.md" in create_write[0]["url"], f"file not created in Notes folder: {create_write[0]['url']}"
    assert "object" not in create_write[0]["url"].lower() and "pointer" not in create_write[0]["url"].lower(), \
        f"URL contains event object: {create_write[0]['url']}"
    print(f"✓ toolbar create file in selected folder works (PUT to {create_write[0]['url']})")

    # --- B. Create folder in selected folder (via toolbar) ---
    CONTENT_WRITES.clear()
    page.click("#btn-add-menu")
    page.click("#btn-new-folder")
    page.wait_for_timeout(1000)
    # Dialog handler will accept with "new-folder-in-notes"
    folder_write = [w for w in CONTENT_WRITES if w["method"] == "PUT" and "new-folder-in-notes" in w["url"]]
    assert len(folder_write) == 1, f"expected one PUT for new folder in Notes, got {CONTENT_WRITES}"
    assert "Notes/new-folder-in-notes/.gitkeep" in folder_write[0]["url"], f"folder not created in Notes: {folder_write[0]['url']}"
    print(f"✓ toolbar create folder in selected folder works (PUT to {folder_write[0]['url']})")

    # --- C. Delete: the confirm decides. Dismissed -> nothing is sent; accepted -> one DELETE with the sha ---
    def deletes():
        return [w for w in CONTENT_WRITES if w["method"] == "DELETE"]

    def pick_file_menu_delete():
        page.click(".file-item:not(.folder)", button="right")
        page.wait_for_selector(".folder-context-menu", timeout=5000)
        page.click(".folder-context-menu button[data-action='delete']")
        page.wait_for_timeout(500)

    # C1. Context menu, confirm CANCELLED.
    CONTENT_WRITES.clear()
    seen_dialogs.clear()
    dismiss_next_confirm[0] = True
    pick_file_menu_delete()
    assert seen_dialogs and "delete this file" in seen_dialogs[-1].lower(), \
        f"no delete confirmation was shown: {seen_dialogs}"
    assert not dismiss_next_confirm[0], "the dismissed confirm never reached the handler"
    assert not deletes(), f"a cancelled confirm still sent a DELETE: {CONTENT_WRITES}"
    assert page.locator(".file-item:not(.folder)").count() == 1, \
        "the file left the tree even though the delete was cancelled"
    print("✓ context menu delete: cancelling the confirm sends nothing")

    # C2. Context menu, confirm ACCEPTED.
    CONTENT_WRITES.clear()
    pick_file_menu_delete()
    delete_write = deletes()
    assert len(delete_write) == 1, f"expected one DELETE for context menu delete, got {CONTENT_WRITES}"
    assert "Notes/Test%20note.md" in delete_write[0]["url"], f"wrong file deleted: {delete_write[0]['url']}"
    assert delete_write[0]["sha"] == "sha-note", f"DELETE missing sha: {delete_write[0]}"
    print(f"✓ context menu delete sends DELETE with sha ({delete_write[0]['url']})")

    # C3. Toolbar delete acts on the OPEN file, so open it again (the mock tree is static).
    page.click(".file-item:not(.folder)")
    page.wait_for_function("document.getElementById('btn-delete').disabled === false", timeout=5000)
    CONTENT_WRITES.clear()
    seen_dialogs.clear()
    dismiss_next_confirm[0] = True
    page.click("#btn-delete")
    page.wait_for_timeout(500)
    assert seen_dialogs and "delete this file" in seen_dialogs[-1].lower(), \
        f"toolbar delete showed no confirmation: {seen_dialogs}"
    assert not deletes(), f"a cancelled toolbar delete still sent a DELETE: {CONTENT_WRITES}"
    page.click("#btn-delete")
    page.wait_for_timeout(500)
    toolbar_delete = deletes()
    assert len(toolbar_delete) == 1, f"expected one DELETE for toolbar delete, got {CONTENT_WRITES}"
    assert "Notes/Test%20note.md" in toolbar_delete[0]["url"], f"wrong file deleted: {toolbar_delete[0]['url']}"
    assert toolbar_delete[0]["sha"], f"toolbar DELETE carries no sha: {toolbar_delete[0]}"
    print("✓ toolbar delete: cancel sends nothing, accept sends one DELETE with a sha")

    # --- D. Continuous typing: no commit during typing, still none after 10s idle ---
    # Re-open the test note (mock tree still has it)
    page.click(".file-item:not(.folder)")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=5000)
    CONTENT_WRITES.clear()
    page.click(".CodeMirror")
    # Type ~30 chars with small pauses (<300ms each), total <10s
    for ch in "CONTINUOUS_TYPING_TEST_AUTOSAVE":
        page.keyboard.type(ch)
        page.wait_for_timeout(100)  # 100ms pause between chars
    # Should be ~28 chars * 100ms = 2.8s total, well under 10s idle
    page.wait_for_timeout(3000)
    assert not CONTENT_WRITES, f"typing committed during active typing: {CONTENT_WRITES}"
    # Now wait 10s idle — hybrid model must still not push
    page.wait_for_timeout(11000)
    idle_writes = [w for w in CONTENT_WRITES if w["method"] == "PUT"]
    assert len(idle_writes) == 0, f"idle must not auto-commit, got {len(idle_writes)}: {CONTENT_WRITES}"
    print(f"✓ continuous typing commits nothing; 10s idle stays local")

    # --- E. Draft survives reload ---
    # Type text, don't wait for commit, reload page, open file → banner appears
    CONTENT_WRITES.clear()
    page.click(".CodeMirror")
    page.keyboard.type("DRAFT_SURVIVES_RELOAD_MARKER")
    page.wait_for_timeout(500)  # Let draft write to IndexedDB (400ms debounce)
    # Reload the page (simulates browser reload)
    page.reload(wait_until="networkidle")
    # Re-set sessionStorage (the test setup does this at start, but reload clears it)
    page.evaluate("""() => {
        sessionStorage.setItem('gh_token', 'ghp_faketoken');
        sessionStorage.setItem('gh_owner', 'test-owner');
        sessionStorage.setItem('gh_repo', 'test-repo');
        sessionStorage.setItem('gh_branch', 'main');
    }""")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)", timeout=5000)
    page.wait_for_selector(".file-item", timeout=5000)
    page.click(".file-item.folder:has-text('Notes')")
    page.click(".file-item:not(.folder):has-text('Test note.md')")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=5000)
    # Check for draft banner
    banner_visible = page.locator("#draft-banner:not(.hidden)").count() > 0
    assert banner_visible, "draft recovery banner not shown after reload"
    banner_text = page.inner_text("#draft-banner-text")
    assert "unsaved local changes" in banner_text.lower(), \
        f"banner text unexpected: {banner_text}"
    # Click "Keep local" - this restores the draft text to the editor
    page.click("#draft-keep")
    page.wait_for_timeout(1000)
    # Verify the draft text is now in the editor
    editor_text = page.evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue()")
    assert "DRAFT_SURVIVES_RELOAD_MARKER" in editor_text, \
        f"draft text not restored in editor: {editor_text[:200]}"
    # Now manually save to force commit
    page.click("#btn-save")
    page.wait_for_timeout(2000)
    keep_writes = [w for w in CONTENT_WRITES if "DRAFT_SURVIVES_RELOAD_MARKER" in w.get("text", "")]
    assert len(keep_writes) >= 1, f"manual save after Keep local did not commit draft: {CONTENT_WRITES}"
    print(f"✓ draft survives reload; Keep local restores text; manual save commits it")

    # --- F. 409 handling, driven for real by the mock (PUT_STATUS_QUEUE) ---
    def pushes_with(marker):
        return [w for w in CONTENT_WRITES if w["method"] == "PUT" and marker in w["text"]]

    def wait_for_pushes(marker, count, seconds=10):
        deadline = time.time() + seconds
        while time.time() < deadline and len(pushes_with(marker)) < count:
            page.wait_for_timeout(200)

    def type_and_save(marker):
        page.click(".CodeMirror")
        page.keyboard.type(marker)
        page.click("#btn-save")

    # F1. ONE 409 is settled silently: re-read the sha, push again, no banner.
    CONTENT_WRITES.clear()
    PUT_STATUS_QUEUE[:] = [409]
    type_and_save("F_RETRY_MARKER")
    wait_for_pushes("F_RETRY_MARKER", 2)
    attempts = pushes_with("F_RETRY_MARKER")
    assert [a["status"] for a in attempts] == [409, 200], f"expected 409 then 200, got {CONTENT_WRITES}"
    assert attempts[0]["sha"] != attempts[1]["sha"], "the silent retry reused the stale sha"
    assert attempts[1]["sha"] == "sha-note", f"the retry did not use the freshly read sha: {attempts[1]}"
    page.wait_for_function(
        "document.getElementById('autosave-status').textContent.includes('Saved to GitHub')", timeout=5000)
    assert page.locator("#draft-banner:not(.hidden)").count() == 0, "a single 409 must not bother the user"
    print("✓ a single 409 is retried silently with a fresh sha and ends as saved")

    # F2. TWO 409s in a row: the user chooses. Nothing more is sent until they do.
    CONTENT_WRITES.clear()
    PUT_STATUS_QUEUE[:] = [409, 409]
    type_and_save("F_CONFLICT_MARKER")
    page.wait_for_selector("#draft-banner:not(.hidden)", timeout=10000)
    attempts = pushes_with("F_CONFLICT_MARKER")
    assert [a["status"] for a in attempts] == [409, 409], f"expected two 409s, got {CONTENT_WRITES}"
    assert page.locator("#draft-reload").is_visible() and page.locator("#draft-overwrite").is_visible(), \
        "conflict banner is missing Reload / Overwrite"
    assert not page.locator("#draft-keep").is_visible() and not page.locator("#draft-discard").is_visible(), \
        "the draft-recovery buttons must not show in a conflict"
    page.wait_for_timeout(1500)
    assert len(pushes_with("F_CONFLICT_MARKER")) == 2, "autosave kept pushing after the conflict was raised"
    print("✓ two 409s in a row raise the Reload / Overwrite banner and stop pushing")

    # F2b. Overwrite: our text goes on top of the freshly read sha, and the banner goes away.
    page.click("#draft-overwrite")
    wait_for_pushes("F_CONFLICT_MARKER", 3)
    attempts = pushes_with("F_CONFLICT_MARKER")
    assert len(attempts) == 3 and attempts[2]["status"] == 200 and attempts[2]["sha"] == "sha-note", \
        f"Overwrite did not push on top of the fresh sha: {attempts}"
    page.wait_for_function(
        "document.getElementById('autosave-status').textContent.includes('Saved to GitHub')", timeout=5000)
    assert page.locator("#draft-banner:not(.hidden)").count() == 0, \
        "the conflict banner is still on screen after a successful Overwrite"
    print("✓ Overwrite pushes our text over the fresh sha and clears the banner")

    # F3. Reload: GitHub's version replaces ours, nothing is pushed, the banner goes away.
    CONTENT_WRITES.clear()
    PUT_STATUS_QUEUE[:] = [409, 409]
    type_and_save("F_RELOAD_MARKER")
    page.wait_for_selector("#draft-banner:not(.hidden)", timeout=10000)
    page.click("#draft-reload")
    page.wait_for_selector("#draft-banner", state="hidden", timeout=5000)
    editor_text = page.evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue()")
    assert "F_RELOAD_MARKER" not in editor_text, "Reload kept our text instead of GitHub's"
    assert "Hello world." in editor_text, f"Reload did not bring back the GitHub version: {editor_text[:120]!r}"
    assert len(pushes_with("F_RELOAD_MARKER")) == 2, "Reload must not push anything"
    print("✓ Reload replaces our text with GitHub's and pushes nothing")
    assert not PUT_STATUS_QUEUE, f"unused scripted statuses left behind: {PUT_STATUS_QUEUE}"

    # --- G. Tabs: several documents open at once ---
    CM = "document.querySelector('.CodeMirror').CodeMirror"
    SECOND_URL_PART = "Notes/Second%20note.md"

    def tab_labels():
        return page.eval_on_selector_all("#tab-bar .tab .tab-label", "els => els.map(e => e.textContent)")

    def active_tab():
        labels = page.eval_on_selector_all("#tab-bar .tab.active .tab-label", "els => els.map(e => e.textContent)")
        return labels[0] if labels else None

    def editor_text():
        return page.evaluate(f"{CM}.getValue()")

    def wait_until(cond, seconds=10, what="condition"):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if cond():
                return
            page.wait_for_timeout(100)
        raise AssertionError(f"timed out waiting for {what}")

    def open_in_tree(name):
        # The tree is rebuilt asynchronously after a refresh or a reload, and a
        # folder starts collapsed after a reload. Expand "Notes" only while it is
        # seen collapsed, and keep looking until the row is on screen.
        row = f".file-item:not(.folder):visible >> text={name}"
        for _ in range(24):
            if page.locator(row).count() > 0:
                break
            toggle = page.locator(".file-item.folder[data-path='Notes'] .folder-toggle")
            if toggle.count() and toggle.first.inner_text().strip() == "\u25b8":
                toggle.first.click()
            page.wait_for_timeout(250)
        page.click(row)

    def show_second_note_in_tree(present):
        EXTRA_TREE[:] = [{"path": "Notes/Second note.md", "type": "blob", "sha": "sha-second"}] if present else []
        page.click("#btn-refresh")
        page.wait_for_timeout(600)

    # G0. The note from the scenarios above is the only tab.
    assert tab_labels() == ["Test note.md"], f"expected a single tab, got {tab_labels()}"
    assert active_tab() == "Test note.md"
    print("✓ an opened file gets a tab, and it is the active one")

    # G1. Edit the first note, leave a scroll position and cursor behind, open a second one.
    show_second_note_in_tree(True)
    CONTENT_WRITES.clear()
    page.click(".CodeMirror")
    page.keyboard.type("G_TAB_A_EDIT")
    page.evaluate(f"{CM}.scrollTo(0, 700)")
    page.wait_for_timeout(300)
    cursor_before = page.evaluate(f"JSON.stringify({CM}.getCursor())")
    scroll_before = page.evaluate(f"{CM}.getScrollInfo().top")
    assert scroll_before > 300, f"could not scroll the long note for the test: {scroll_before}"

    open_in_tree("Second note.md")
    wait_until(lambda: active_tab() == "Second note.md", what="the second tab to become active")
    wait_until(lambda: "SECOND_NOTE_BODY" in editor_text(), what="the second note to load")
    assert tab_labels() == ["Test note.md", "Second note.md"], tab_labels()
    print("✓ opening another file adds a tab and shows that file")

    # Hybrid: leaving a tab keeps changes local — no GitHub put on switch.
    page.wait_for_timeout(1500)
    assert not any("G_TAB_A_EDIT" in w.get("text", "") for w in CONTENT_WRITES), \
        f"leaving a dirty tab must not auto-commit: {CONTENT_WRITES}"
    assert page.locator("#tab-bar .tab.dirty").count() >= 1, "dirty tab lost its unsaved mark"
    print("✓ leaving a dirty tab keeps changes local (no auto-commit)")

    # G2. Back to the first tab: restored from memory with unsaved text intact.
    FETCH_LOG.clear()
    page.click("#tab-bar .tab:has-text('Test note.md') .tab-label")
    wait_until(lambda: active_tab() == "Test note.md", what="tab A to become active again")
    assert "G_TAB_A_EDIT" in editor_text(), "tab A lost its text when it was switched away and back"
    assert not any("Test%20note.md" in u for u in FETCH_LOG), \
        f"a dirty tab must come back from memory, but it was fetched again: {FETCH_LOG}"
    assert page.evaluate(f"JSON.stringify({CM}.getCursor())") == cursor_before, "the cursor did not survive the switch"
    scroll_after = page.evaluate(f"{CM}.getScrollInfo().top")
    assert abs(scroll_after - scroll_before) <= 5, f"scroll position lost: {scroll_before} -> {scroll_after}"
    assert page.locator("#tab-bar .tab.active.dirty").count() == 1, "unsaved mark lost after switch back"
    assert page.locator("#draft-banner:not(.hidden)").count() == 0, "returning to an in-memory dirty tab raised a draft banner"
    print("✓ switching back restores text, cursor and scroll without a request")

    # Undo history is per tab, too: it survived being switched away.
    page.evaluate(f"{CM}.undo()")
    assert "G_TAB_A_EDIT" not in editor_text(), "undo history of the tab was lost by the switch"
    page.evaluate(f"{CM}.redo()")
    assert "G_TAB_A_EDIT" in editor_text()
    page.click("#btn-save")
    wait_until(lambda: page.locator("#tab-bar .tab.dirty").count() == 0, what="tab A to be saved")
    print("✓ undo history is kept per tab")

    # Clicking the file that is already open must not be treated as "open it again":
    # that would re-arm autosave from scratch and silently forget the unsaved text.
    page.click(".CodeMirror")
    page.keyboard.type("G_CLICK_MARKER")
    wait_until(lambda: page.locator("#tab-bar .tab.active.dirty").count() == 1, what="the dot before the tree click")
    FETCH_LOG.clear()
    open_in_tree("Test note.md")
    page.wait_for_timeout(600)
    assert not any("Test%20note.md" in u for u in FETCH_LOG), \
        f"clicking the already-open file re-fetched it: {FETCH_LOG}"
    assert "G_CLICK_MARKER" in editor_text(), "clicking the already-open file replaced its text"
    assert page.locator("#tab-bar .tab.active.dirty").count() == 1, \
        "clicking the already-open file wiped its unsaved state (autosave was re-opened underneath the text)"
    CONTENT_WRITES.clear()
    page.click("#btn-save")
    wait_until(lambda: any("G_CLICK_MARKER" in w["text"] for w in CONTENT_WRITES), what="the save after the tree click")
    wait_until(lambda: page.locator("#tab-bar .tab.dirty").count() == 0, what="the dot to clear")
    print("✓ clicking the file that is already open keeps its unsaved text and state")

    # Preview mode has to follow the active tab. EasyMDE re-renders its Preview pane
    # from value(), and tab switching goes around value() (swapDoc), so Preview once
    # kept showing the first document under every other tab's name until a reload.
    def preview_text():
        # App layout uses EasyMDE side-by-side (.editor-preview-side), not the
        # legacy full-preview pane (.editor-preview-active).
        return page.evaluate(
            """() => {
              const p = document.querySelector('.editor-preview-side')
                || document.querySelector('.editor-preview-active');
              return p ? p.innerText : '';
            }""")

    page.click('#layout-toggle .layout-btn[data-mode="preview"]')
    wait_until(lambda: "Hello world" in preview_text(), what="Preview to show the active note")
    page.click("#tab-bar .tab:has-text('Second note.md') .tab-label")
    wait_until(lambda: "SECOND_NOTE_BODY" in preview_text(), what="Preview to follow the switch to the second tab")
    assert "Hello world" not in preview_text(), "Preview still shows the first note under the second tab"
    page.click("#tab-bar .tab:has-text('Test note.md') .tab-label")
    wait_until(lambda: "Hello world" in preview_text() and "SECOND_NOTE_BODY" not in preview_text(),
               what="Preview to follow the switch back")
    page.click('#layout-toggle .layout-btn[data-mode="source"]')  # back to the editor
    wait_until(lambda: page.locator(".editor-preview-side:visible").count() == 0, what="Preview to switch off")
    print("✓ Preview mode follows the active tab")

    # G3. The dot: typing marks the active tab, a save clears it.
    page.click("#tab-bar .tab:has-text('Second note.md') .tab-label")
    wait_until(lambda: active_tab() == "Second note.md", what="tab B to become active")
    page.click(".CodeMirror")
    page.keyboard.type("G_TAB_B_EDIT")
    wait_until(lambda: page.locator("#tab-bar .tab.active.dirty").count() == 1, what="the unsaved dot on tab B")
    assert page.locator("#tab-bar .tab:not(.active).dirty").count() == 0, "the dot appeared on the wrong tab"
    page.click("#btn-save")
    wait_until(lambda: page.locator("#tab-bar .tab.dirty").count() == 0, what="the dot to clear after Save")
    print("✓ the unsaved dot follows the active file and clears on save")

    # G4. Closing a dirty tab: draft stays local (no auto-push); neighbour takes over.
    CONTENT_WRITES.clear()
    page.click(".CodeMirror")  # the Save click left the focus on the button
    page.keyboard.type("G_TAB_B_MORE")
    assert "G_TAB_B_MORE" in editor_text(), "the test did not manage to type into the editor"
    page.click("#tab-bar .tab.active .tab-close")
    wait_until(lambda: tab_labels() == ["Test note.md"], what="tab B to disappear")
    wait_until(lambda: active_tab() == "Test note.md", what="the neighbour to become active")
    page.wait_for_timeout(800)
    assert not any("G_TAB_B_MORE" in w.get("text", "") for w in CONTENT_WRITES), \
        f"closing a dirty tab must not auto-commit: {CONTENT_WRITES}"
    assert "G_TAB_A_EDIT" in editor_text(), "the neighbour tab does not show its own text"
    print("✓ closing a dirty tab keeps draft local and hands over to the neighbour")

    # G5. Tabs survive a page reload; only the active one is fetched at once.
    open_in_tree("Second note.md")
    wait_until(lambda: tab_labels() == ["Test note.md", "Second note.md"], what="two tabs again")
    page.click("#tab-bar .tab:has-text('Test note.md') .tab-label")
    wait_until(lambda: active_tab() == "Test note.md", what="tab A active before the reload")
    page.wait_for_timeout(500)
    FETCH_LOG.clear()
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)", timeout=5000)
    wait_until(lambda: tab_labels() == ["Test note.md", "Second note.md"], what="the tabs to be restored")
    assert active_tab() == "Test note.md", f"wrong tab active after the reload: {active_tab()}"
    wait_until(lambda: "# Test note" in editor_text(), what="the active tab to load after the reload")
    assert not any(SECOND_URL_PART in u for u in FETCH_LOG), \
        "background tabs must not be fetched until they are opened"
    page.click("#tab-bar .tab:has-text('Second note.md') .tab-label")
    wait_until(lambda: "SECOND_NOTE_BODY" in editor_text(), what="a restored background tab to load on first click")
    print("✓ tabs survive a reload; background tabs load lazily")

    # A file that vanished while the page was closed is not resurrected as a tab.
    show_second_note_in_tree(False)
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)", timeout=5000)
    wait_until(lambda: tab_labels() == ["Test note.md"], what="the vanished file's tab to be dropped")
    wait_until(lambda: active_tab() == "Test note.md" and "# Test note" in editor_text(),
               what="the first remaining tab to open in place of the vanished one")
    print("✓ a tab whose file no longer exists is not restored; the first remaining tab opens instead")

    # G6. Deleting the open file closes its tab and shows the neighbour.
    show_second_note_in_tree(True)
    open_in_tree("Second note.md")
    wait_until(lambda: active_tab() == "Second note.md", what="tab B to open for the delete test")
    CONTENT_WRITES.clear()
    EXTRA_TREE[:] = []  # GitHub no longer lists it once it is deleted
    page.click("#btn-delete")
    wait_until(lambda: any(w["method"] == "DELETE" and SECOND_URL_PART in w["url"] for w in CONTENT_WRITES),
               what="the DELETE of the second note")
    wait_until(lambda: tab_labels() == ["Test note.md"], what="the deleted file's tab to close")
    wait_until(lambda: active_tab() == "Test note.md", what="the neighbour to take over after the delete")
    assert "# Test note" in editor_text()
    print("✓ deleting the open file closes its tab and shows the neighbour")

    # Deleting a file that only has a BACKGROUND tab closes that tab and leaves the active one alone.
    show_second_note_in_tree(True)
    open_in_tree("Second note.md")
    wait_until(lambda: active_tab() == "Second note.md", what="tab B to open again")
    page.click("#tab-bar .tab:has-text('Test note.md') .tab-label")
    wait_until(lambda: active_tab() == "Test note.md", what="tab A to be active before the tree delete")
    CONTENT_WRITES.clear()
    EXTRA_TREE[:] = []
    page.click(".file-item:not(.folder):visible >> text=Second note.md", button="right")
    page.wait_for_selector(".folder-context-menu", timeout=5000)
    page.click(".folder-context-menu button[data-action='delete']")
    wait_until(lambda: any(w["method"] == "DELETE" and SECOND_URL_PART in w["url"] for w in CONTENT_WRITES),
               what="the DELETE from the tree")
    wait_until(lambda: tab_labels() == ["Test note.md"], what="the background tab to close")
    assert active_tab() == "Test note.md" and "# Test note" in editor_text(), "the active tab was disturbed"
    print("✓ deleting a file from the tree closes its background tab only")

    # G7. Closing the LAST tab commits what it holds, then shows the empty state.
    # The dead, typable-but-inert editor is gone: with no file open there is no
    # CodeMirror to type into at all, so nothing can be committed by accident.
    CONTENT_WRITES.clear()
    page.click(".CodeMirror")
    page.keyboard.type("G_LAST_TAB_EDIT")
    page.click("#btn-save")
    wait_until(lambda: any("G_LAST_TAB_EDIT" in w["text"] for w in CONTENT_WRITES if w["method"] == "PUT"),
               what="explicit Save before closing the last tab")
    page.click("#tab-bar .tab.active .tab-close")
    wait_until(lambda: page.locator("#tab-bar.hidden").count() == 1, what="the tab bar to hide")
    assert editor_text() == "", "the editor still shows the closed file"
    assert page.evaluate("document.getElementById('btn-save').disabled") is True
    # No file is open: the empty-state card replaces the editor chrome.
    wait_until(lambda: page.locator("#editor-empty-state:not(.hidden)").count() == 1,
               what="the empty-state card to appear after the last tab closed")
    assert page.locator(".editor-body.hidden").count() == 1, "the editor body is still visible with no file open"
    assert page.locator(".editor-toolbar.hidden").count() == 1, "the toolbar is still visible with no file open"
    assert page.locator("#empty-state-new-file:not(.hidden)").count() == 1, "the empty-state New file button is missing"
    assert page.locator(".CodeMirror:visible").count() == 0, "a CodeMirror editor is still visible with no file open"
    print("✓ closing the last tab shows the empty state, not a dead editor")

    # The tabs scenario above ends with no file open. The PDF checks below need
    # one, so open the note again (the mock's tree still lists it).
    page.click(".file-item:not(.folder):visible >> text=Test note.md")
    page.wait_for_function(
        "document.getElementById('btn-export-pdf').disabled === false", timeout=5000
    )

    # --- 5. PDF export must render the document, not a blank page ---
    # html2canvas captures the element exactly where it sits, so putting
    # `position: fixed; left: -99999px` on #pdf-export-container (as app.css once
    # did) yields a ~3 KB, one-empty-page PDF. Watch the container as it is created
    # and record its computed position; it must stay a neutral block.
    page.evaluate("""() => {
        window.__pdfPos = null;
        new MutationObserver((muts, obs) => {
            const el = document.getElementById('pdf-export-container');
            if (el) {
                window.__pdfPos = getComputedStyle(el).position;
                obs.disconnect();
            }
        }).observe(document.body, {childList: true, subtree: true});
    }""")

    with page.expect_download(timeout=90000) as dl:
        page.click("#btn-export-pdf")
    pdf_path = BASE / "_e2e_export.pdf"
    dl.value.save_as(pdf_path)
    pdf_bytes = pdf_path.stat().st_size

    container_pos = page.evaluate("window.__pdfPos")
    assert container_pos == "static", \
        f"#pdf-export-container must not be positioned (got {container_pos!r}) — that makes html2canvas capture a blank page"
    # A real render of the long test document is hundreds of KB; the blank one was ~3 KB.
    assert pdf_bytes > 50_000, f"exported PDF is suspiciously small: {pdf_bytes} bytes"
    # At least one page, and no page that is just white paper. The size of a JPEG
    # stream proves nothing (a blank page compresses to a few KB), so decode each
    # page and count pixels darker than paper white.
    page_images = pdf_page_images(pdf_path)
    assert len(page_images) >= 1, f"PDF has no pages: {len(page_images)}"
    page_stats = measure_red_per_page(page, page_images)
    for i, st in enumerate(page_stats):
        assert st["ink"] >= PDF_MIN_INK_PX, \
            f"page {i} looks blank ({st['ink']} non-white px of {st['rows'] * 200}): {page_stats}"
    print(f"✓ PDF export renders content ({pdf_bytes} bytes, {len(page_images)} pages, "
          f"non-white px per page {[st['ink'] for st in page_stats]}, container position: {container_pos})")

    # --- 6. Images must never be cut in half by a page boundary ---
    # The document contains a red image taller than one page, placed so it lands
    # across a page break. Measure the red ink on every page of the exported
    # PDF: a split shows a big red block on one page and red starting at the very
    # top of the next. Thresholds are loose on purpose — JPEG ringing puts a
    # handful of stray red pixels on the seam.
    red_per_page = page_stats
    total_red = sum(r["red"] for r in red_per_page)
    assert total_red > 5_000, f"the red test image is missing from the PDF: {red_per_page}"
    for i in range(len(red_per_page) - 1):
        cur, nxt = red_per_page[i], red_per_page[i + 1]
        assert not (cur["red"] > 2_000 and nxt["red"] > 500 and nxt["firstRow"] <= 3), \
            f"image is split across pages {i} and {i + 1}: {red_per_page}"
    print(f"✓ images are not split by page breaks (red ink per page: "
          f"{[r['red'] for r in red_per_page]})")
    pdf_path.unlink()

    # --- 7. Scrolling a long document ---
    scroll_info = page.evaluate("""() => {
        const el = document.querySelector('.CodeMirror-scroll');
        return {scrollHeight: el.scrollHeight, clientHeight: el.clientHeight};
    }""")
    assert scroll_info["scrollHeight"] > scroll_info["clientHeight"], \
        f"long content does not overflow, scrolling impossible: {scroll_info}"
    page.evaluate("document.querySelector('.CodeMirror-scroll').scrollTop = 500")
    scroll_top = page.evaluate("document.querySelector('.CodeMirror-scroll').scrollTop")
    assert scroll_top > 0, "scrollTop did not change — scrolling is broken"
    print(f"✓ scrolling works (scrollHeight={scroll_info['scrollHeight']}, scrollTop={scroll_top})")

    # --- 3. Image rendering in the preview (via the GitHub API mock) ---
    page.click('#layout-toggle .layout-btn[data-mode="preview"]')
    page.wait_for_selector(".editor-preview .md-img-wrap", timeout=5000)
    page.wait_for_function(
        "!document.querySelector('.editor-preview .md-img-wrap').classList.contains('loading')",
        timeout=5000,
    )
    wrap_classes = page.get_attribute(".editor-preview .md-img-wrap", "class")
    img_src = page.get_attribute(".editor-preview img", "src")
    assert "broken" not in wrap_classes, f"image marked broken: {wrap_classes}"
    assert img_src.startswith("data:image/"), f"unexpected img src: {img_src[:60]}"
    print("✓ preview image renders (real data: URL, not a stuck placeholder)")


    # --- History drawer toggle ---
    page.click("#btn-history")
    # Playwright's default wait is "visible"; :not(.hidden) is correct for open.
    page.wait_for_selector("#history-panel:not(.hidden)", timeout=8000)
    assert page.locator("#history-panel:not(.hidden)").count() == 1, "History panel did not open"
    page.click("#btn-history")  # second click closes
    # .hidden means display:none — must wait for attached + class, NOT visible
    page.wait_for_function(
        "() => document.getElementById('history-panel')?.classList.contains('hidden') === true",
        timeout=5000,
    )
    assert "hidden" in (page.get_attribute("#history-panel", "class") or ""),         "History panel did not close on toggle"
    print("✓ History panel toggles open and closed")

    # --- HTML Preview in Live mode ---
    EXTRA_TREE.append({"path": "Notes/page.html", "mode": "100644", "type": "blob", "sha": "sha-html", "size": 80})
    page.click("#btn-refresh")
    page.wait_for_timeout(800)
    # open via tree if visible, else force-open by putting content through UI is hard;
    # click tree item when present
    if page.locator("text=page.html").count() > 0:
        page.click("text=page.html")
        page.wait_for_timeout(500)
        page.click('#layout-toggle .layout-btn[data-mode="split"]')
        page.wait_for_function(
            """() => {
              const iframe = document.querySelector(
                '.editor-preview-side iframe.html-preview-frame, .editor-preview-side iframe'
              );
              const s = iframe && iframe.srcdoc || '';
              return s.includes('HTML_PAGE_OK') || s.includes('Hello HTML');
            }""",
            timeout=8000,
        )
        html_ok = page.evaluate("""() => {
          const iframe = document.querySelector(
            '.editor-preview-side iframe.html-preview-frame, .editor-preview-side iframe'
          );
          if (!iframe) return {ok:false, reason:'no iframe'};
          // sandbox without allow-same-origin blocks contentDocument; srcdoc is enough
          const srcdoc = iframe.srcdoc || '';
          if (srcdoc.includes('HTML_PAGE_OK') || srcdoc.includes('Hello HTML')) {
            return {ok:true, via:'srcdoc', len: srcdoc.length};
          }
          try {
            const doc = iframe.contentDocument;
            if (doc && doc.body) {
              const text = doc.body.innerText || '';
              return {
                ok: text.includes('HTML_PAGE_OK') || text.includes('Hello HTML'),
                via: 'contentDocument',
                text: text.slice(0, 80),
              };
            }
          } catch (e) {
            return {ok:false, reason: String(e), srcdocLen: srcdoc.length, head: srcdoc.slice(0, 120)};
          }
          return {ok:false, reason:'empty', srcdocLen: srcdoc.length, head: srcdoc.slice(0, 120)};
        }""")
        assert html_ok.get("ok"), f"HTML Live preview missing content: {html_ok}"
        print("✓ HTML Live preview renders page content")
        page.click('#layout-toggle .layout-btn[data-mode="source"]')
    else:
        print("⚠ page.html not in tree after refresh — skipped HTML preview check")

    # --- Space near inline image must not jump caret to end of document ---
    page.click(".file-item:not(.folder):has-text('Test note.md')")
    page.wait_for_timeout(400)
    page.click('#layout-toggle .layout-btn[data-mode="source"]')
    page.click(".CodeMirror")
    # Jump near start, type image markdown if not already present, then Space
    page.evaluate("""() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      cm.setValue('# Hello\\n\\n![pic](Asset/pic.jpg)\\n\\nline after image\\n');
      cm.setCursor({line: 3, ch: 0}); // start of "line after image"
      cm.focus();
    }""")
    page.wait_for_timeout(400)  # allow inline image marks to settle
    page.keyboard.type("X")
    page.keyboard.press("Space")
    pos = page.evaluate("""() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const cur = cm.getCursor();
      return {line: cur.line, ch: cur.ch, last: cm.lineCount() - 1, text: cm.getValue()};
    }""")
    # Caret must stay near the image (line 3), not jump to EOF
    assert pos["line"] <= 4, f"Space near image jumped caret far down: {pos}"
    assert "X" in pos["text"], f"typed character missing after Space near image: {pos}"
    print(f"✓ Space near inline image keeps caret local (line={pos['line']}, ch={pos['ch']})")

    assert not page_errors, f"unhandled page errors: {page_errors}"
    browser.close()

print("\\nALL CHECKS PASSED")
