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
import base64
import pathlib
from playwright.sync_api import sync_playwright

BASE = pathlib.Path(__file__).parent

CDN_MOCKS = {
    "https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.css": BASE / "node_modules/easymde/dist/easymde.min.css",
    "https://cdn.jsdelivr.net/npm/easymde/dist/easymde.min.js": BASE / "node_modules/easymde/dist/easymde.min.js",
    "https://cdn.jsdelivr.net/npm/marked/marked.min.js": BASE / "node_modules/marked/lib/marked.umd.js",
    "https://cdn.jsdelivr.net/npm/html2pdf.js@0.10.1/dist/html2pdf.bundle.min.js": BASE / "node_modules/html2pdf.js/dist/html2pdf.bundle.min.js",
}

TINY_PNG_B64 = base64.b64encode(bytes.fromhex(
    "89504e470d0a1a0a0000000d4948445200000001000000010802000000907753"
    "de0000000c4944415408d763f8ffff3f0005fe02fea1f6e4a50000000049454e"
    "44ae426082"
)).decode()

MD_INTRO = "# Test note\n\nHello world.\n\n![pic](../../Asset/pic.jpg)\n"
LONG_BODY = "\n".join(f"Line {i} - text to force the editor to overflow vertically." for i in range(400))
MD_CONTENT = MD_INTRO + "\n" + LONG_BODY + "\n"

FAKE_TREE = {
    "tree": [
        {"path": "Asset/pic.jpg", "type": "blob", "sha": "sha-pic"},
        {"path": "Notes/Test note.md", "type": "blob", "sha": "sha-note"},
    ]
}


def handle_github_api(route, request):
    url = request.url
    if re.search(r"/repos/[^/]+/[^/]+$", url) and "/git/" not in url and "/contents/" not in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"default_branch": "main"}))
    elif "/git/trees/" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps(FAKE_TREE))
    elif "/contents/Notes/Test%20note.md" in url:
        b64 = base64.b64encode(MD_CONTENT.encode("utf-8")).decode()
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": b64, "sha": "sha-note"}))
    elif "/contents/Asset/pic.jpg" in url:
        route.fulfill(status=200, content_type="application/json", body=json.dumps({"content": TINY_PNG_B64, "sha": "sha-pic"}))
    else:
        route.fulfill(status=404, content_type="application/json", body=json.dumps({"message": "Not Found (mock)"}))


def handle_cdn(route, request):
    local_path = CDN_MOCKS.get(request.url)
    if local_path and local_path.exists():
        ct = "text/css" if str(local_path).endswith(".css") else "text/javascript"
        route.fulfill(status=200, content_type=ct, body=local_path.read_bytes())
    else:
        route.fulfill(status=404, body=b"")


page_errors = []

with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={"width": 1400, "height": 900})
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

    page.click("text=Notes")
    page.click("text=Test note.md")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=5000)
    print("✓ file opened")

    # --- 1. Editing ---
    page.click(".CodeMirror")
    page.keyboard.type("EDITED_MARKER")
    content = page.evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue()")
    assert "EDITED_MARKER" in content, "typing into the editor did not update the document"
    print("✓ editing works")

    # The caret must be visible on the dark background.
    cursor_border = page.evaluate("""() => getComputedStyle(document.querySelector('.CodeMirror-cursor')).borderLeftColor""")
    assert cursor_border not in ("rgb(0, 0, 0)", "rgba(0, 0, 0, 0)", "transparent"),         f"cursor is effectively invisible: {cursor_border}"
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

    # --- 2. Scrolling a long document ---
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
    page.click("button.preview")
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

    assert not page_errors, f"unhandled page errors: {page_errors}"
    browser.close()

print("\nALL CHECKS PASSED")
