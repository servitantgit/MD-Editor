from e2e.harness import *  # mocks, helpers, constants

def run_commit_search_upload(page, page_errors, browser):
    """Commit confirmation, history, find/search nav, folder upload (fresh browser)."""
    # Shared UI helpers — close over `page` (track reassignment after new_page).
    CM = "document.querySelector('.CodeMirror').CodeMirror"

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
        row = f".file-item:not(.folder):visible >> text={name}"
        for _ in range(24):
            if page.locator(row).count() > 0:
                break
            toggle = page.locator(".file-item.folder[data-path='Notes'] .folder-toggle")
            if toggle.count() and toggle.first.inner_text().strip() == "▸":
                toggle.first.click()
            page.wait_for_timeout(250)
        page.click(row)

    # --- J. COMMIT SNAPSHOT CONFIRMATION ---
    # RED is established by module tests, not an old-code run of this scenario.
    print("\n--- J. Commit: snapshots, recovery drafts and delayed ref update ---")
    page.close()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.add_init_script(MAMMOTH_STUB_JS.decode("utf-8"))
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))

    j_a = "Notes/Test note.md"
    j_b = "Notes/Second note.md"
    j_remote = {
        j_a: {"text": "# Commit A\n\nA ORIGINAL\n", "sha": "j-old-a"},
        j_b: {"text": "# Commit B\n\nB ORIGINAL\n", "sha": "j-old-b"},
    }
    j_blobs = {}
    j_trees = []
    j_commits = []
    j_refs = []
    j_contents_writes = []
    j_hold = {"enabled": False, "route": None, "body": None}

    def j_accept_ref(route, body):
        for entry in j_trees[-1]["tree"]:
            j_remote[entry["path"]] = {
                "text": j_blobs[entry["sha"]], "sha": entry["sha"]
            }
        route.fulfill(status=200, content_type="application/json", body=json.dumps({
            "object": {"sha": body["sha"]}
        }))

    def j_api(route, request):
        url = request.url.split("?", 1)[0]
        method = request.method
        body = json.loads(request.post_data or "{}")
        if "/contents/" in url and method in ("PUT", "DELETE"):
            j_contents_writes.append({"url": url, "method": method})
            raise AssertionError("Commit must not use Contents writes")
        for path, suffix in [
            (j_a, "/contents/Notes/Test%20note.md"),
            (j_b, "/contents/Notes/Second%20note.md")
        ]:
            if method == "GET" and url.endswith(suffix):
                item = j_remote[path]
                route.fulfill(status=200, content_type="application/json",
                    body=json.dumps({
                        "content": base64.b64encode(item["text"].encode("utf-8")).decode(),
                        "sha": item["sha"]
                    }))
                return
        if method == "GET" and "/git/trees/" in url:
            # Deliberately stale tree SHAs: Commit result supplies confirmed SHAs.
            route.fulfill(status=200, content_type="application/json",
                body=json.dumps({"tree": [
                    {"path": j_a, "type": "blob", "sha": "j-old-a"},
                    {"path": j_b, "type": "blob", "sha": "j-old-b"}
                ]}))
            return
        if method == "POST" and url.endswith("/git/blobs"):
            sha = "j-blob-" + str(len(j_blobs) + 1)
            j_blobs[sha] = base64.b64decode(body["content"]).decode("utf-8")
            route.fulfill(status=200, content_type="application/json",
                body=json.dumps({"sha": sha}))
            return
        if method == "POST" and url.endswith("/git/trees"):
            j_trees.append(body)
            route.fulfill(status=200, content_type="application/json",
                body=json.dumps({"sha": "j-tree-" + str(len(j_trees))}))
            return
        if method == "POST" and url.endswith("/git/commits"):
            j_commits.append(body)
            route.fulfill(status=200, content_type="application/json",
                body=json.dumps({"sha": "j-commit-" + str(len(j_commits))}))
            return
        if method == "PATCH" and "/git/refs/heads/" in url:
            j_refs.append(body)
            assert body["force"] is False, body
            if j_hold["enabled"]:
                assert j_hold["route"] is None, "duplicate pending ref update"
                j_hold["route"] = route
                j_hold["body"] = body
            else:
                j_accept_ref(route, body)
            return
        handle_github_api(route, request)

    page.route(re.compile(r"https://api\.github\.com/.*"), j_api)
    page.route(re.compile(r"https://cdnjs\.cloudflare\.com/.*"),
        lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    page.route(re.compile(r"https://maxcdn\.bootstrapcdn\.com/.*"),
        lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    # Scenario J needs "Second note.md" in the tree. In the old monolith an earlier
    # scenario (G) left it there; run_isolated() resets the mocks, so it is declared here.
    EXTRA_TREE[:] = [{"path": "Notes/Second note.md", "type": "blob", "sha": "sha-second"}]
    page.goto("http://localhost:8080/", wait_until="networkidle")
    page.evaluate("""() => {
        sessionStorage.setItem('gh_token', 'ghp_faketoken');
        sessionStorage.setItem('gh_owner', 'test-owner');
        sessionStorage.setItem('gh_repo', 'test-repo');
        sessionStorage.setItem('gh_branch', 'main');
    }""")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)", timeout=8000)

    def j_drafts():
        return page.evaluate("""async () => {
            const db = await new Promise((resolve, reject) => {
                const r = indexedDB.open('md-editor-drafts');
                r.onsuccess = () => resolve(r.result);
                r.onerror = () => reject(r.error);
            });
            try {
                return await new Promise((resolve, reject) => {
                    const tx = db.transaction('drafts', 'readonly');
                    const r = tx.objectStore('drafts').getAll();
                    let records;
                    r.onsuccess = () => { records = r.result; };
                    tx.oncomplete = () => resolve(records.filter(
                        x => x.key.startsWith('test-owner/test-repo@main:')));
                    tx.onerror = () => reject(tx.error);
                });
            } finally { db.close(); }
        }""")

    def j_commit(message):
        page.click("#btn-commit")
        page.wait_for_selector("#commit-panel:not(.hidden)")
        page.fill("#commit-message", message)
        page.click("#btn-commit-push")

    def j_wait_finished():
        page.wait_for_function(
            "document.getElementById('commit-panel').classList.contains('hidden')",
            timeout=10000)

    open_in_tree("Test note.md")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    page.evaluate(f"{CM}.setValue('# Commit A\\n\\nA SNAPSHOT\\n')")
    open_in_tree("Second note.md")
    page.wait_for_function("document.getElementById('current-file').textContent === 'Notes/Second note.md'")
    page.evaluate(f"{CM}.setValue('# Commit B\\n\\nB SNAPSHOT\\n')")
    page.click("#tab-bar .tab:has-text('Test note.md') .tab-label")
    page.wait_for_function("document.getElementById('current-file').textContent === 'Notes/Test note.md'")
    assert page.inner_text("#commit-badge") == "2"
    j_commit("J two files")
    j_wait_finished()
    assert len(j_blobs) == 2 and len(j_trees) == 1 and len(j_commits) == 1 and len(j_refs) == 1
    assert j_commits[0]["message"] == "J two files"
    assert {e["path"] for e in j_trees[0]["tree"]} == {j_a, j_b}
    assert j_remote[j_a]["text"] == "# Commit A\n\nA SNAPSHOT\n"
    assert j_remote[j_b]["text"] == "# Commit B\n\nB SNAPSHOT\n"
    assert page.locator("#tab-bar .tab.dirty").count() == 0
    assert page.locator("#commit-badge.hidden").count() == 1
    assert page.is_disabled("#btn-discard")
    assert j_drafts() == []
    j_delay = page.evaluate("""async () => {
        const a = await import('./js/autosave.js');
        return a.IDLE_MS + a.LOCAL_WRITE_DEBOUNCE_MS + 1;
    }""")
    page.wait_for_timeout(j_delay)
    assert j_drafts() == [], "committed drafts returned after idle"
    page.reload(wait_until="networkidle")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    assert page.locator("#draft-banner:not(.hidden)").count() == 0
    assert "A SNAPSHOT" in editor_text()
    assert not j_contents_writes
    print("\u2713 Commit writes two exact snapshots once; drafts stay absent after idle and reload")

    page.evaluate(f"{CM}.setValue('# Commit A\\n\\nJ SENT SNAPSHOT\\n')")
    j_hold["enabled"] = True
    j_commit("J delayed ref")
    wait_until(lambda: j_hold["route"] is not None, what="PATCH ref to be held")
    assert len(j_refs) == 2 and len(j_commits) == 2
    page.evaluate(f"""() => {{
        const cm = {CM};
        const line = cm.lastLine();
        cm.setCursor({{line, ch: cm.getLine(line).length}});
        cm.focus();
    }}""")
    page.keyboard.type("J LATE TEXT")
    page.wait_for_timeout(500)
    assert "J LATE TEXT" in editor_text()
    j_hold["enabled"] = False
    j_accept_ref(j_hold["route"], j_hold["body"])
    j_hold["route"] = None
    j_wait_finished()
    assert "J LATE TEXT" not in j_remote[j_a]["text"]
    assert j_remote[j_a]["text"] == "# Commit A\n\nJ SENT SNAPSHOT\n"
    assert page.locator("#tab-bar .tab.active.dirty").count() == 1
    assert page.inner_text("#commit-badge") == "1"
    assert not page.is_disabled("#btn-discard")
    j_saved = j_drafts()
    assert len(j_saved) == 1 and j_saved[0]["path"] == j_a, j_saved
    assert j_saved[0]["text"] == editor_text(), j_saved
    assert j_saved[0]["baseSha"] == j_remote[j_a]["sha"], j_saved
    assert "newer local changes remain" in page.inner_text("#save-status")
    assert not j_contents_writes
    print("\u2713 Typing during held PATCH ref keeps the newer text, dot, badge and rebased draft")

    j_final_text = editor_text()
    j_commit("J remaining changes")
    j_wait_finished()
    assert len(j_refs) == 3 and len(j_commits) == 3 and len(j_trees) == 3
    assert len(j_trees[-1]["tree"]) == 1
    assert j_remote[j_a]["text"] == j_final_text
    assert j_drafts() == []
    assert page.locator("#tab-bar .tab.dirty").count() == 0
    assert not j_contents_writes
    print("\u2713 Next Commit saves the remaining changes and clears their draft")

    # --- K. HISTORY / RESTORE GUARD ---
    # Ordinary behaviour already passed a browser probe; no new feature or fix.
    print("\n--- K. History / Restore: another note, tabs and draft recovery ---")
    k_commit = "abc1234abcdef"
    k_historical = "# Commit B\n\nK HISTORICAL VERSION\n"
    k_current_b = j_remote[j_b]["text"]
    k_current_a = j_remote[j_a]["text"]
    k_reads = []
    k_writes = []
    k_ref_count = len(j_refs)
    k_content_count = len(j_contents_writes)

    def k_api(route, request):
        from urllib.parse import urlsplit, unquote, parse_qs
        url = urlsplit(request.url)
        path = unquote(url.path)
        query = parse_qs(url.query)
        if request.method != "GET":
            k_writes.append({"method": request.method, "path": path})
            route.abort()
            return
        if path == "/repos/test-owner/test-repo/commits":
            reply = [{
                "sha": k_commit,
                "commit": {
                    "message": "K historical edit",
                    "author": {"name": "Tester", "date": "2026-11-01T12:00:00Z"}
                }
            }]
        elif path == "/repos/test-owner/test-repo/commits/" + k_commit:
            reply = {
                "sha": k_commit, "commit": {"message": "K historical edit"},
                "files": [{
                    "filename": j_b, "sha": "k-historical-blob",
                    "status": "modified", "additions": 1, "deletions": 1,
                    "patch": "@@ -1,3 +1,3 @@\n # Commit B\n \n-B SNAPSHOT\n+K HISTORICAL VERSION"
                }]
            }
        elif path == "/repos/test-owner/test-repo/contents/" + j_b and query.get("ref") == [k_commit]:
            k_reads.append({"path": j_b, "ref": k_commit})
            reply = {
                "content": base64.b64encode(k_historical.encode("utf-8")).decode(),
                "sha": "k-historical-blob"
            }
        else:
            route.fallback()
            return
        route.fulfill(status=200, content_type="application/json",
                      body=json.dumps(reply))

    page.route(re.compile(r"https://api\.github\.com/.*"), k_api)
    # Reload first: the active tab is A; B is a lazy restored background tab.
    page.reload(wait_until="networkidle")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    assert page.inner_text("#current-file") == j_a
    assert editor_text() == k_current_a
    assert j_drafts() == []

    page.click("#btn-history")
    page.wait_for_selector("#history-list .hist-item[data-sha='" + k_commit + "']")
    assert page.locator("#history-list .hist-msg").inner_text() == "K historical edit"
    page.click("#history-list .hist-item[data-sha='" + k_commit + "']")
    page.wait_for_selector("#history-detail .btn-restore")
    assert page.locator("#history-detail .diff-fname").inner_text() == j_b
    assert page.locator("#history-detail .diff-del").inner_text() == "-B SNAPSHOT"
    assert page.locator("#history-detail .diff-add").inner_text() == "+K HISTORICAL VERSION"

    page.once("dialog", lambda dialog: dialog.dismiss())
    page.click("#history-detail .btn-restore")
    assert editor_text() == k_current_a
    assert page.inner_text("#current-file") == j_a
    assert k_reads == []
    assert j_drafts() == []
    assert not k_writes
    print("\u2713 History shows the selected file and diff; cancelling Restore changes nothing")

    page.once("dialog", lambda dialog: dialog.accept())
    page.click("#history-detail .btn-restore")
    page.wait_for_function(
        "document.getElementById('current-file').textContent === 'Notes/Second note.md'")
    page.wait_for_function(
        "document.querySelector('.CodeMirror').CodeMirror.getValue().includes('K HISTORICAL VERSION')")
    assert editor_text() == k_historical
    assert page.locator("#tab-bar .tab.active.dirty").count() == 1
    assert page.inner_text("#commit-badge") == "1"
    assert not page.is_disabled("#btn-discard")
    assert k_reads == [{"path": j_b, "ref": k_commit}]
    assert j_remote[j_b]["text"] == k_current_b
    assert not k_writes

    page.click("#tab-bar .tab:has-text('Test note.md') .tab-label")
    page.wait_for_function(
        "document.getElementById('current-file').textContent === 'Notes/Test note.md'")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    assert editor_text() == k_current_a, f"K tab A text mismatch: {editor_text()!r}"
    page.click("#tab-bar .tab:has-text('Second note.md') .tab-label")
    page.wait_for_function(
        "document.getElementById('current-file').textContent === 'Notes/Second note.md'")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    assert editor_text() == k_historical, f"K tab B text mismatch: {editor_text()!r}"
    assert page.locator("#tab-bar .tab.active.dirty").count() == 1
    k_draft = j_drafts()
    assert len(k_draft) == 1 and k_draft[0]["path"] == j_b, k_draft
    assert k_draft[0]["text"] == k_historical, k_draft
    assert k_draft[0]["baseSha"] == j_remote[j_b]["sha"], k_draft
    assert not k_writes
    print("\u2713 Restore opens the other note as local work; tab switches preserve it and leave A unchanged")

    page.reload(wait_until="networkidle")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    assert page.inner_text("#current-file") == j_b
    page.wait_for_selector("#draft-banner:not(.hidden)")
    assert editor_text() == k_current_b
    page.click("#draft-keep")
    page.wait_for_function(
        "document.querySelector('.CodeMirror').CodeMirror.getValue().includes('K HISTORICAL VERSION')")
    assert editor_text() == k_historical
    assert page.locator("#tab-bar .tab.active.dirty").count() == 1
    assert not k_writes
    assert len(j_refs) == k_ref_count
    assert len(j_contents_writes) == k_content_count
    assert j_remote[j_a]["text"] == k_current_a
    assert j_remote[j_b]["text"] == k_current_b
    print("\u2713 Restored draft survives reload; Keep local recovers it without any remote write")

    # --- L. FIND HIGHLIGHTS AND REPLACEMENT ---
    # Module RED and browser probes established the new requirements.
    print("\n--- L. Find: highlights, navigation, replacement and cleanup ---")
    page.click('#layout-toggle .layout-btn[data-mode="source"]')
    page.evaluate("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        cm.setValue('cat CAT cat');
        cm.setCursor({line:0,ch:0});
    }""")
    l_write_count = len(k_writes)

    def l_snapshot():
        return page.evaluate("""() => {
            const cm = document.querySelector('.CodeMirror').CodeMirror;
            return {
                text:cm.getValue(), selection:cm.getSelection(),
                count:document.getElementById('find-count').textContent,
                marks:cm.getAllMarks().filter(
                    m => m.className === 'md-find-match').length,
                currentMarks:cm.getAllMarks().filter(
                    m => m.className === 'md-find-current').length
            };
        }""")

    def l_count(value):
        page.wait_for_function(
            "v => document.getElementById('find-count').textContent === v",
            arg=value, timeout=5000)

    page.keyboard.press("Control+f")
    page.wait_for_selector("#find-bar:not(.hidden)")
    assert page.evaluate("document.activeElement.id") == "find-input"
    page.fill("#find-input", "cat")
    page.press("#find-input", "Enter")
    l_count("1 / 3")
    l_first = l_snapshot()
    assert l_first["text"] == "cat CAT cat"
    assert l_first["selection"] == "cat" and l_first["marks"] == 3
    assert l_first["currentMarks"] == 1
    l_colors = page.evaluate("""() => ({
        matches:[...document.querySelectorAll('.md-find-match')]
            .map(e => getComputedStyle(e).backgroundColor),
        current:[...document.querySelectorAll('.md-find-current')]
            .map(e => getComputedStyle(e).backgroundColor)
    })""")
    assert "rgb(102, 83, 0)" in l_colors["matches"], l_colors
    assert "rgb(179, 92, 0)" in l_colors["current"], l_colors
    page.click("#find-next")
    l_count("2 / 3")
    assert l_snapshot()["selection"] == "CAT"
    page.press("#find-input", "Shift+Enter")
    l_count("1 / 3")
    assert l_snapshot()["selection"] == "cat"
    page.click("#find-next")
    l_count("2 / 3")
    print("\u2713 Find highlights all matches and the current one; next/previous update the counter")

    page.keyboard.press("Control+h")
    assert page.evaluate("document.activeElement.id") == "replace-input"
    page.fill("#replace-input", "dog")
    page.click("#find-replace")
    l_count("0 / 2")
    l_replaced = l_snapshot()
    assert l_replaced["text"] == "cat dog cat" and l_replaced["marks"] == 2, l_replaced
    page.click("#find-replace-all")
    l_count("0 / 0")
    l_all = l_snapshot()
    assert l_all["text"] == "dog dog dog" and l_all["marks"] == 0, l_all
    page.evaluate("document.querySelector('.CodeMirror').CodeMirror.undo()")
    l_count("0 / 2")
    l_undo = l_snapshot()
    assert l_undo["text"] == "cat dog cat" and l_undo["marks"] == 2, l_undo
    print("\u2713 Replace/All and Undo preserve exact text and refresh the match count")

    page.evaluate("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        window.__lOriginalScrollIntoView = cm.scrollIntoView;
        const original = cm.scrollIntoView.bind(cm);
        window.__lFindNavigationCalls = 0;
        cm.scrollIntoView = (...args) => {
            window.__lFindNavigationCalls++;
            return original(...args);
        };
        cm.replaceRange(' cat', {line:0,ch:cm.getLine(0).length});
        window.__lFindNavigationCalls = 0;
    }""")
    try:
        l_count("0 / 3")
        page.wait_for_timeout(300)
        assert page.evaluate("window.__lFindNavigationCalls") == 0
        l_edited = l_snapshot()
        assert l_edited["text"] == "cat dog cat cat" and l_edited["marks"] == 3, l_edited
    finally:
        page.evaluate("""() => {
            const cm = document.querySelector('.CodeMirror').CodeMirror;
            cm.scrollIntoView = window.__lOriginalScrollIntoView;
            delete window.__lOriginalScrollIntoView;
            delete window.__lFindNavigationCalls;
        }""")
    page.press("#find-input", "Escape")
    page.wait_for_selector("#find-bar", state="hidden")
    l_closed = l_snapshot()
    assert l_closed["marks"] == 0 and l_closed["currentMarks"] == 0, l_closed
    assert l_closed["count"] == "", l_closed
    page.wait_for_timeout(300)
    assert l_snapshot()["marks"] == 0
    assert len(k_writes) == l_write_count
    assert len(j_refs) == k_ref_count
    assert len(j_contents_writes) == k_content_count
    print("\u2713 Editing refreshes highlights without navigation; Escape removes them without remote writes")

    # --- M. SEARCH TICKS AND LIVE SYNC ---
    # Drawing and dense-row ordering have module RED coverage.
    print("\n--- M. Minimap search ticks and unchanged Live sync ---")
    page.evaluate("(text) => document.querySelector('.CodeMirror').CodeMirror.setValue(text)", MD_CONTENT)
    page.click('#layout-toggle .layout-btn[data-mode="split"]')
    page.wait_for_function("""() => {
        const pv = document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side');
        return pv && pv.querySelectorAll('.md-img-wrap').length >= 2
            && !pv.querySelector('.md-img-wrap.loading')
            && pv.scrollHeight > pv.clientHeight + 200;
    }""", timeout=10000)
    if page.locator("#minimap-wrap:not(.hidden)").count():
        page.click("#btn-minimap")

    def m_pixels():
        return page.evaluate("""() => {
            const c = document.getElementById('minimap');
            const d = c.getContext('2d').getImageData(0,0,c.width,c.height).data;
            let normal = 0, current = 0;
            for (let i = 0; i < d.length; i += 4) {
                if (d[i] === 255 && d[i+1] === 213 && d[i+2] === 79) normal++;
                if (d[i] === 255 && d[i+1] === 140 && d[i+2] === 66) current++;
            }
            return {normal, current};
        }""")

    def m_settle():
        return page.evaluate("""() => new Promise((resolve, reject) => {
            const cm = document.querySelector('.CodeMirror').CodeMirror;
            const pv = document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side');
            let last = '', same = 0, frames = 0;
            const step = () => {
                const value = cm.getScrollInfo().top + ':' + pv.scrollTop;
                same = value === last ? same + 1 : 0;
                last = value;
                if (same >= 8) return resolve({
                    source: cm.getScrollInfo().top, preview: pv.scrollTop
                });
                if (++frames > 300) return reject(new Error('M: panes did not settle'));
                requestAnimationFrame(step);
            };
            requestAnimationFrame(step);
        })""")

    def m_check_sync(label):
        page.evaluate("document.querySelector('.CodeMirror').CodeMirror.scrollTo(null,1000)")
        m_settle()
        page.evaluate("document.querySelector('.CodeMirror').CodeMirror.scrollTo(null,1600)")
        forward = m_settle()
        assert forward["source"] > 0 and forward["preview"] > 100, (label, forward)
        page.evaluate("""() => {
            document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side').scrollTop = 0;
        }""")
        backward = m_settle()
        assert backward["source"] < 50, (label, backward)

    page.keyboard.press("Control+f")
    page.fill("#find-input", "Line 10")
    page.press("#find-input", "Enter")
    assert page.locator("#minimap-wrap.hidden").count() == 1
    assert editor_text() == MD_CONTENT
    page.click("#btn-minimap")
    wait_until(lambda: m_pixels()["normal"] > 0 and m_pixels()["current"] > 0,
               what="search ticks after opening minimap")
    m_first_count = page.inner_text("#find-count")
    page.click("#find-next")
    assert page.inner_text("#find-count") != m_first_count
    # Wait for the following paint, not merely the counter update.
    page.wait_for_timeout(200)
    m_next_pixels = m_pixels()
    assert m_next_pixels["normal"] > 0 and m_next_pixels["current"] > 0, m_next_pixels
    assert editor_text() == MD_CONTENT
    print("\u2713 Minimap shows all search rows and retains the current tick after Next")

    m_check_sync("map open, Find active")
    print("\u2713 Live sync works both ways with search marks and the minimap open")

    page.click("#find-close")
    wait_until(lambda: m_pixels() == {"normal": 0, "current": 0},
               what="search ticks to clear")
    assert l_snapshot()["marks"] == 0 and l_snapshot()["currentMarks"] == 0
    assert editor_text() == MD_CONTENT
    page.click("#btn-minimap")
    m_check_sync("map closed")
    assert len(k_writes) == l_write_count
    assert len(j_refs) == k_ref_count
    assert len(j_contents_writes) == k_content_count
    print("\u2713 Closing Find clears canvas ticks; Live sync still works with the map closed")

    # --- N. SEARCH RESULT NAVIGATION ---
    # Module RED and browser RED established metadata, highlighting and UI requirements.
    print("\n--- N. Search result: prefix tokens, Source navigation and minimap ---")
    page.close()
    page = browser.new_page(viewport={"width": 1440, "height": 1000})
    page.on("pageerror", lambda exc: page_errors.append(str(exc)))
    n_body = ("# Search navigation\n\ncat\n"
              + "\n".join("ordinary row " + str(i) for i in range(180))
              + "\nprinting\nordinary separator\nprinting\n")
    j_remote[j_a] = {"text": n_body, "sha": "n-head-a"}
    j_remote[j_b] = {"text": "# Other note\n\nUnrelated content\n", "sha": "n-head-b"}
    n_contents_before = len(j_contents_writes)
    n_refs_before = len(j_refs)
    page.route(re.compile(r"https://api\.github\.com/.*"), j_api)
    page.route(re.compile(r"https://cdnjs\.cloudflare\.com/.*"),
        lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    page.route(re.compile(r"https://maxcdn\.bootstrapcdn\.com/.*"),
        lambda r, _: r.fulfill(status=200, content_type="text/css", body=b""))
    page.goto("http://localhost:8080/", wait_until="networkidle")
    page.evaluate("""() => {
        sessionStorage.setItem('gh_token', 'ghp_faketoken');
        sessionStorage.setItem('gh_owner', 'test-owner');
        sessionStorage.setItem('gh_repo', 'test-repo');
        sessionStorage.setItem('gh_branch', 'main');
    }""")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)")
    open_in_tree("Test note.md")
    page.wait_for_function("document.getElementById('btn-save').disabled === false")
    assert editor_text() == n_body
    n_history = page.evaluate(f"{CM}.historySize()")
    page.click('#layout-toggle .layout-btn[data-mode="preview"]')
    page.fill("#search-input", "cat print")
    page.wait_for_selector(".search-result[data-path='Notes/Test note.md']", timeout=10000)
    page.click(".search-result[data-path='Notes/Test note.md']")
    l_count("2 / 3")
    n_first = l_snapshot()
    assert n_first["selection"] == "printing" and n_first["marks"] == 3, n_first
    assert editor_text() == n_body
    assert page.evaluate(f"{CM}.historySize()") == n_history
    assert page.evaluate("localStorage.getItem('md_layout')") == "source"
    assert page.locator('#layout-toggle .layout-btn[data-mode="source"].active').count() == 1
    assert page.evaluate(f"{CM}.getScrollInfo().top") > 500
    assert page.is_disabled("#find-replace") and page.is_disabled("#find-replace-all")
    assert page.input_value("#find-input") == "cat print"
    print("\u2713 Search opens Source and selects the actual longest prefix token without editing text")

    page.click("#find-next")
    l_count("3 / 3")
    assert l_snapshot()["selection"] == "printing"
    page.press("#find-input", "Shift+Enter")
    l_count("2 / 3")
    if not page.locator("#minimap-wrap:not(.hidden)").count():
        page.click("#btn-minimap")
    wait_until(lambda: m_pixels()["normal"] > 0 and m_pixels()["current"] > 0,
               what="Search result ticks on minimap")
    print("\u2713 Search-mode next/previous and minimap show all matched tokens")

    page.evaluate("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        window.__nOriginalScroll = cm.scrollIntoView;
        const original = cm.scrollIntoView.bind(cm);
        window.__nNavigationCalls = 0;
        cm.scrollIntoView = (...args) => {
            window.__nNavigationCalls++;
            return original(...args);
        };
        cm.replaceRange('printing\\n', {
            line: cm.lastLine(), ch: cm.getLine(cm.lastLine()).length
        });
        window.__nNavigationCalls = 0;
    }""")
    try:
        l_count("0 / 4")
        page.wait_for_timeout(250)
        assert page.evaluate("window.__nNavigationCalls") == 0
        assert l_snapshot()["marks"] == 4
        assert page.is_disabled("#find-replace")
    finally:
        page.evaluate("""() => {
            const cm = document.querySelector('.CodeMirror').CodeMirror;
            cm.scrollIntoView = window.__nOriginalScroll;
            delete window.__nOriginalScroll;
            delete window.__nNavigationCalls;
        }""")
    page.click("#find-next")
    l_count("1 / 4")
    assert l_snapshot()["selection"] == "cat"
    # Click the same indexed result again: search must use current local text,
    # not replace it with the older remote body.
    n_local = editor_text()
    page.click(".search-result[data-path='Notes/Test note.md']")
    l_count("2 / 4")
    assert editor_text() == n_local
    assert l_snapshot()["selection"] == "printing"
    print("\u2713 Local edits refresh Search highlights without navigation and survive reopening the result")

    page.fill("#find-input", "printing")
    l_count("0 / 3")
    assert not page.is_disabled("#find-replace")
    assert not page.is_disabled("#find-replace-all")
    page.press("#find-input", "Enter")
    l_count("1 / 3")
    assert l_snapshot()["selection"] == "printing"
    page.press("#find-input", "Escape")
    page.wait_for_selector("#find-bar", state="hidden")
    assert l_snapshot()["marks"] == 0 and l_snapshot()["currentMarks"] == 0
    wait_until(lambda: m_pixels() == {"normal": 0, "current": 0},
               what="Search canvas ticks to clear")
    assert len(j_contents_writes) == n_contents_before
    assert len(j_refs) == n_refs_before
    assert j_remote[j_a]["text"] == n_body
    print("\u2713 Editing the Find field enables literal replacement; Escape clears marks without remote writes")

    # --- O. WRAP / FOLD GUARDS ---
    # Existing behaviour passed a browser probe; application code is unchanged.
    print("\n--- O. Wrap / Fold: display-only actions and Find navigation ---")

    def o_cm(expression):
        return page.evaluate(
            "() => { const cm = document.querySelector('.CodeMirror').CodeMirror; "
            + expression + " }")

    def o_collapsed():
        return o_cm("return cm.getAllMarks().filter(m => m.collapsed).length;")

    page.click('#layout-toggle .layout-btn[data-mode="source"]')
    o_writes_before = len(j_contents_writes)
    o_refs_before = len(j_refs)
    o_long_text = "ordinary words " * 100
    page.evaluate("text => document.querySelector('.CodeMirror').CodeMirror.setValue(text)",
                  o_long_text)
    o_history = o_cm("return cm.historySize();")
    o_wrap_before = o_cm("return cm.getOption('lineWrapping');")
    page.click("#btn-wrap")
    assert o_cm("return cm.getOption('lineWrapping');") is not o_wrap_before
    assert editor_text() == o_long_text
    assert o_cm("return cm.historySize();") == o_history
    page.click("#btn-wrap")
    assert o_cm("return cm.getOption('lineWrapping');") == o_wrap_before

    if not o_cm("return cm.getOption('lineWrapping');"):
        page.click("#btn-wrap")
    o_wrapped_height = o_cm(
        "return cm.heightAtLine(1, 'local') - cm.heightAtLine(0, 'local');")
    page.click("#btn-wrap")
    o_unwrapped_height = o_cm(
        "return cm.heightAtLine(1, 'local') - cm.heightAtLine(0, 'local');")
    assert o_wrapped_height > o_unwrapped_height, (o_wrapped_height, o_unwrapped_height)
    assert editor_text() == o_long_text
    assert o_cm("return cm.historySize();") == o_history
    # Restore the initial Wrap option before testing Fold.
    if o_cm("return cm.getOption('lineWrapping');") != o_wrap_before:
        page.click("#btn-wrap")
    print("\u2713 Wrap changes visual line height and toggles back without changing text or undo")

    o_note = (
        "# First\n"
        + "\n".join("First section line " + str(i) for i in range(30))
        + "\n## Child\nTARGET_NEEDLE\nChild body\n"
        + "# Second\n"
        + "\n".join("Second section line " + str(i) for i in range(30))
        + "\n"
    )
    page.evaluate("text => document.querySelector('.CodeMirror').CodeMirror.setValue(text)",
                  o_note)
    o_history = o_cm("return cm.historySize();")
    assert o_collapsed() == 0
    o_full_height = o_cm("return cm.getScrollInfo().height;")
    page.click("#btn-fold")
    assert o_collapsed() == 3, o_collapsed()
    o_folded_height = o_cm("return cm.getScrollInfo().height;")
    assert o_folded_height < o_full_height, (o_full_height, o_folded_height)
    assert editor_text() == o_note
    assert o_cm("return cm.historySize();") == o_history
    page.click("#btn-fold")
    assert o_collapsed() == 0
    assert editor_text() == o_note
    assert o_cm("return cm.historySize();") == o_history
    print("\u2713 Fold collapses three sections and expands them on the next click; text and undo unchanged")

    page.click("#btn-fold")
    assert o_collapsed() > 0
    page.keyboard.press("Control+f")
    page.fill("#find-input", "TARGET_NEEDLE")
    page.press("#find-input", "Enter")
    l_count("1 / 1")
    assert o_cm("return cm.getSelection();") == "TARGET_NEEDLE"
    assert o_cm(
        "return cm.findMarksAt(cm.getCursor('from')).filter(m => m.collapsed).length;"
    ) == 0, "Find target remains hidden inside a fold"
    assert editor_text() == o_note
    assert o_cm("return cm.historySize();") == o_history
    page.press("#find-input", "Escape")
    assert l_snapshot()["marks"] == 0 and l_snapshot()["currentMarks"] == 0
    assert len(j_contents_writes) == o_writes_before
    assert len(j_refs) == o_refs_before
    assert j_remote[j_a]["text"] == n_body
    print("\u2713 Find unfolds and selects its hidden target without text edits or remote writes")

    # --- P. CLEAR SEARCH ON PHONE ---
    print("\n--- P. Clear search: mobile geometry and keyboard activation ---")
    clear_document_state = make_clear_document_state(page)
    p_before = clear_document_state()
    p_writes_before = len(j_contents_writes)
    p_refs_before = len(j_refs)
    page.set_viewport_size({"width": 420, "height": 800})
    if not page.evaluate("document.body.classList.contains('mobile-sidebar-open')"):
        page.click("#btn-mobile-files")
    page.wait_for_selector("#search-input", state="visible")
    # Reset the sidebar query left by scenario N with the clear button.
    # Escape is not used here: the global phone handler also closes the drawer.
    assert page.locator("#btn-search-clear").is_visible()
    page.click("#btn-search-clear")
    assert page.input_value("#search-input") == ""
    assert page.locator(".search-result").count() == 0
    assert clear_document_state() == p_before
    assert page.locator("#btn-search-clear").is_hidden()
    assert page.evaluate("document.body.classList.contains('mobile-sidebar-open')")
    page.fill("#search-input", "printing")
    page.wait_for_selector(".search-result", state="visible")

    p_geometry = page.evaluate("""() => new Promise((resolve, reject) => {
        let last = '', same = 0, frames = 0;
        const step = () => {
            const input = document.getElementById('search-input');
            const button = document.getElementById('btn-search-clear');
            const a = input.getBoundingClientRect(), b = button.getBoundingClientRect();
            const value = JSON.stringify([a.left,a.top,a.width,a.height,b.left,b.top,b.width,b.height]);
            same = value === last ? same + 1 : 0;
            last = value;
            if (same >= 12) return resolve({
                inside:b.left >= a.left && b.right <= a.right &&
                    b.top >= a.top && b.bottom <= a.bottom,
                inputInsideViewport:a.left >= 0 && a.right <= innerWidth,
                padding:parseFloat(getComputedStyle(input).paddingRight),
                buttonWidth:b.width,
                overflow:document.documentElement.scrollWidth > innerWidth
            });
            if (++frames > 300) return reject(new Error('Clear button geometry did not settle'));
            requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    })""")
    assert p_geometry["inside"] and p_geometry["inputInsideViewport"], p_geometry
    assert p_geometry["padding"] >= p_geometry["buttonWidth"], p_geometry
    assert not p_geometry["overflow"], p_geometry
    page.click("#btn-search-clear")
    assert page.input_value("#search-input") == ""
    assert page.locator(".search-result").count() == 0
    assert page.locator("#file-tree").is_visible()
    assert page.locator("#btn-search-clear").is_hidden()
    assert page.evaluate("document.activeElement.id") == "search-input"
    assert clear_document_state() == p_before

    page.fill("#search-input", "printing")
    page.wait_for_selector(".search-result", state="visible")
    page.focus("#btn-search-clear")
    page.keyboard.press("Enter")
    assert page.input_value("#search-input") == ""
    assert page.evaluate("document.activeElement.id") == "search-input"
    assert clear_document_state() == p_before
    assert len(j_contents_writes) == p_writes_before
    assert len(j_refs) == p_refs_before
    print("\u2713 Mobile clear button fits the field; click and keyboard clear Search without changing local work")

    # --- boundary: folder upload must not inherit search UI state ---
    page.goto("http://localhost:8080/", wait_until="networkidle")
    page.evaluate("""() => {
        sessionStorage.setItem('gh_token', 'ghp_faketoken');
        sessionStorage.setItem('gh_owner', 'test-owner');
        sessionStorage.setItem('gh_repo', 'test-repo');
        sessionStorage.setItem('gh_branch', 'main');
    }""")
    page.reload(wait_until="networkidle")
    page.wait_for_selector("#app-main:not(.hidden)", timeout=15000)

    # --- Q. FOLDER UPLOAD FROM DISK ---
    print("\n--- Q. Folder upload: target folder, one commit, conflicts ---")
    page.set_viewport_size({"width": 1440, "height": 1000})
    page.wait_for_timeout(300)
    assert not j_hold["enabled"], "scenario J left the ref hold on"
    page.wait_for_selector(".file-item.folder[data-path='Notes']", timeout=5000)
    q_writes_before = len(j_contents_writes)

    def q_wait(cond, what, seconds=10):
        for _ in range(int(seconds * 20)):
            if cond():
                return
            page.wait_for_timeout(50)
        raise AssertionError("timed out waiting for " + what + "; status: " + q_status())

    def q_status():
        return page.evaluate("() => (document.getElementById('save-status') || {}).textContent || ''")

    def q_drop(selector, items):
        # Synthetic OS drop: a real DataTransfer exposes no webkitGetAsEntry,
        # so the drop carries fake FileSystem entries over real File objects.
        return page.evaluate("""(spec) => {
            const mk = (n) => n.dir ? {
                isFile: false, isDirectory: true, name: n.name,
                createReader() {
                    let done = false;
                    return { readEntries(ok) {
                        const b = done ? [] : n.dir.map(mk);
                        done = true;
                        setTimeout(() => ok(b), 0);
                    } };
                }
            } : {
                isFile: true, isDirectory: false, name: n.name,
                file(ok) { ok(new File([n.text], n.name, { type: 'text/plain' })); }
            };
            const entries = spec.items.map(mk);
            const dt = {
                types: ['Files'], files: [], effectAllowed: 'all', dropEffect: 'none',
                getData: () => '',
                items: entries.map((en) => ({ kind: 'file', type: '', webkitGetAsEntry: () => en }))
            };
            const el = document.querySelector(spec.selector);
            if (!el) throw new Error('drop target not found: ' + spec.selector);
            const ev = new Event('drop', { bubbles: true, cancelable: true });
            Object.defineProperty(ev, 'dataTransfer', { value: dt });
            el.dispatchEvent(ev);
            return ev.defaultPrevented;
        }""", {"selector": selector, "items": items})

    # Q1 - a folder dropped on the Notes row lands in Notes/, in ONE commit.
    q_trees, q_refs = len(j_trees), len(j_refs)
    assert q_drop(".file-item.folder[data-path='Notes']", [{"name": "QDrop", "dir": [
        {"name": "a.txt", "text": "alpha\n"},
        {"name": "Thumbs.db", "text": "x"},
        {"name": "sub", "dir": [
            {"name": "b.txt", "text": "beta\n"},
            {"name": "empty.txt", "text": ""},
        ]},
    ]}])
    q_wait(lambda: len(j_refs) == q_refs + 1, "the folder upload commit")
    q_wait(lambda: "Uploaded 3 file(s) to Notes" in q_status(), "the folder upload success status")
    assert len(j_trees) == q_trees + 1, j_trees[q_trees:]
    q_entries = {e["path"]: j_blobs[e["sha"]] for e in j_trees[-1]["tree"]}
    assert q_entries == {
        "Notes/QDrop/a.txt": "alpha\n",
        "Notes/QDrop/sub/b.txt": "beta\n",
        "Notes/QDrop/sub/empty.txt": "",
    }, q_entries
    assert j_commits[-1]["message"] == "Upload folder QDrop", j_commits[-1]
    assert j_refs[-1]["force"] is False, j_refs[-1]
    print("\u2713 A folder dropped on a folder row is committed into it once; system files skipped, empty file kept")

    # Q2 - a single file dropped on the root strip lands in the repository root.
    # The one drop strip follows the active folder (see AGENTS.md): a fixed
    # sequence makes the root active, whatever the scenarios above left behind.
    page.click(".file-item.folder[data-path='Notes']")
    page.wait_for_function(
        "document.getElementById('active-folder-path').textContent.trim() === 'Notes'", timeout=5000)
    page.wait_for_selector(".tree-home", state="visible", timeout=5000)
    page.click(".tree-home")
    page.wait_for_selector(".tree-root-drop-root", timeout=5000)
    q_path = page.inner_text("#active-folder-path").strip()
    assert q_path == "/", q_path
    q_trees, q_refs = len(j_trees), len(j_refs)
    assert q_drop(".tree-root-drop-root", [{"name": "q-root.txt", "text": "root\n"}])
    q_wait(lambda: len(j_refs) == q_refs + 1, "the root upload commit")
    q_wait(lambda: "Uploaded 1 file(s) to /" in q_status(), "the root upload success status")
    assert len(j_trees) == q_trees + 1, j_trees[q_trees:]
    q_entries = {e["path"]: j_blobs[e["sha"]] for e in j_trees[-1]["tree"]}
    assert q_entries == {"q-root.txt": "root\n"}, q_entries
    assert j_commits[-1]["message"] == "Upload q-root.txt", j_commits[-1]
    print("\u2713 A file dropped on the root strip is committed to the repository root")

    # Q3 - an existing path cancels the whole upload: no blob, tree or ref.
    q_trees, q_refs, q_blobs = len(j_trees), len(j_refs), len(j_blobs)
    assert q_drop(".file-item.folder[data-path='Notes']", [{"name": "Test note.md", "text": "dup\n"}])
    q_wait(lambda: "Upload cancelled" in q_status(), "the conflict status")
    assert "Notes/Test note.md" in q_status(), q_status()
    page.wait_for_timeout(500)
    assert (len(j_trees), len(j_refs), len(j_blobs)) == (q_trees, q_refs, q_blobs), \
        (j_trees[q_trees:], j_refs[q_refs:])
    assert len(j_contents_writes) == q_writes_before, j_contents_writes
    print("\u2713 A drop onto an existing path writes nothing and names the conflict; no Contents writes")

    assert not page_errors, f"unhandled page errors: {page_errors}"

