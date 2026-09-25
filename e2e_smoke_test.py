"""
Наскрізний браузерний тест (не юніт-тест): піднімає застосунок у справжньому
headless Chromium, підміняє GitHub API фейковими відповідями (щоб не потрібен
був реальний токен) і перевіряє три речі, на які скаржився користувач:
редагування, прокрутку довгого документа та рендер зображень у прев'ю.

Запуск: спочатку `node serve.mjs` (порт 8080), потім `python3 e2e_smoke_test.py`.
Потребує: pip install playwright && playwright install chromium

CDN-бібліотеки (jsdelivr/cdnjs) тут підмінені локальними копіями з node_modules —
це підміна ЛИШЕ для тестового середовища; продакшн index.html і далі використовує
реальний CDN.
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
    # fontawesome — суто іконки, не критично для функціональності
    page.route(re.compile(r"https://cdnjs\.cloudflare\.com/.*"), lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    page.route(re.compile(r"https://maxcdn\.bootstrapcdn\.com/.*"), lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))

    page.goto("http://localhost:8080/", wait_until="networkidle")

    page.fill("#input-owner", "test-owner")
    page.fill("#input-repo", "test-repo")
    page.fill("#input-token", "ghp_faketoken")
    page.click("#btn-login")

    page.wait_for_selector("#app-main:not(.hidden)", timeout=5000)
    page.wait_for_selector(".file-item", timeout=5000)

    page.click("text=Notes")
    page.click("text=Test note.md")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=5000)
    print("✓ файл відкрито")

    # --- 1. Редагування ---
    page.click(".CodeMirror")
    page.keyboard.type("EDITED_MARKER")
    content = page.evaluate("document.querySelector('.CodeMirror').CodeMirror.getValue()")
    assert "EDITED_MARKER" in content, "typing into the editor did not update the document"
    print("✓ редагування працює")

    # --- 2. Прокрутка довгого документа ---
    scroll_info = page.evaluate("""() => {
        const el = document.querySelector('.CodeMirror-scroll');
        return {scrollHeight: el.scrollHeight, clientHeight: el.clientHeight};
    }""")
    assert scroll_info["scrollHeight"] > scroll_info["clientHeight"], \
        f"long content does not overflow, scrolling impossible: {scroll_info}"
    page.evaluate("document.querySelector('.CodeMirror-scroll').scrollTop = 500")
    scroll_top = page.evaluate("document.querySelector('.CodeMirror-scroll').scrollTop")
    assert scroll_top > 0, "scrollTop did not change — scrolling is broken"
    print(f"✓ прокрутка працює (scrollHeight={scroll_info['scrollHeight']}, scrollTop={scroll_top})")

    # --- 3. Рендер зображення у прев'ю (через мок GitHub API) ---
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
    print("✓ зображення в прев'ю рендериться (реальний data: URL, не застрягла заглушка)")

    assert not page_errors, f"необроблені помилки сторінки: {page_errors}"
    browser.close()

print("\nУСІ ПЕРЕВІРКИ ПРОЙШЛИ")
