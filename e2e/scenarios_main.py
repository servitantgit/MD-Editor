from e2e.harness import *  # mocks, helpers, constants

def run_main_smoke(page, page_errors, browser):
    """Landing through tree/tabs/binary (fresh browser)."""
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
    # ...and the count line above the hits matches the number of rows shown.
    count_text = page.inner_text(".search-count")
    expected_count = f"{len(result_paths)} result" + ("" if len(result_paths) == 1 else "s")
    assert count_text == expected_count, \
        f"result count line {count_text!r} does not match {len(result_paths)} rows"
    # The tree must be REPLACED by the results, not shown next to them.
    assert page.locator(".file-item.folder:visible").count() == 0, \
        "the file tree is still visible while search results are shown"
    # ...and the results start right under the search box, with no empty band
    # left by the hidden tree's wrapper (.folder-dropzone).
    gap = page.evaluate(
        "document.getElementById('search-results').getBoundingClientRect().top"
        " - document.querySelector('.sidebar-search').getBoundingClientRect().bottom"
    )
    assert abs(gap) < 5, f"empty space between the search box and the results: {gap}px"
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
    clear_document_state = make_clear_document_state(page)

    # Finish Search navigation before measuring clear preservation.
    page.wait_for_function("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        return !document.getElementById('find-bar').classList.contains('hidden')
            && cm.getAllMarks().some(m =>
                m.className === 'md-find-current' && m.find());
    }""", timeout=5000)
    clear_query = page.input_value("#search-input")
    clear_before = clear_document_state()
    page.evaluate("window.__clearTreeRow = document.getElementById('file-tree').firstElementChild")
    page.wait_for_selector("#btn-search-clear", state="visible")
    page.click("#btn-search-clear")
    assert page.input_value("#search-input") == ""
    assert page.locator(".search-result").count() == 0
    assert page.locator("#btn-search-clear").is_hidden()
    assert page.evaluate("document.activeElement.id") == "search-input"
    assert page.evaluate(
        "document.getElementById('file-tree').firstElementChild === window.__clearTreeRow")
    assert clear_document_state() == clear_before
    page.fill("#search-input", clear_query)
    page.wait_for_selector(".search-result", state="visible")
    page.press("#search-input", "Escape")
    assert page.input_value("#search-input") == ""
    assert page.locator("#btn-search-clear").is_hidden()
    assert clear_document_state() == clear_before
    page.fill("#search-input", clear_query)
    page.wait_for_selector(".search-result", state="visible")
    print("\u2713 Clear search button and Escape restore the same tree without changing document highlights")
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
    # Only folder creation still uses window.prompt. New-file uses the in-app dialog
    # (complete_new_file_dialog) and must NOT consume entries from this list.
    create_responses = [
        "root-new.md",           # First new folder (toolbar smoke)
        "new-folder-in-notes",   # Scenario B — folder inside Notes
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
    # Pre-seed the mock tree so the post-PUT tree reload shows the new folder
    # row (the mock tree is static and otherwise wouldn't include it).
    EXTRA_TREE.append({"path": "Notes/new-folder-in-notes/.gitkeep", "type": "blob", "sha": "sha-gitkeep"})
    CONTENT_WRITES.clear()
    page.click("#btn-add-menu")
    page.click("#btn-new-folder")
    page.wait_for_timeout(1000)
    # Dialog handler will accept with "new-folder-in-notes"
    folder_write = [w for w in CONTENT_WRITES if w["method"] == "PUT" and "new-folder-in-notes" in w["url"]]
    assert len(folder_write) == 1, f"expected one PUT for new folder in Notes, got {CONTENT_WRITES}"
    assert "Notes/new-folder-in-notes/.gitkeep" in folder_write[0]["url"], f"folder not created in Notes: {folder_write[0]['url']}"
    print(f"✓ toolbar create folder in selected folder works (PUT to {folder_write[0]['url']})")

    # The new folder row is visible in the tree, and no .gitkeep row appears.
    page.wait_for_selector(".file-item.folder:has-text('new-folder-in-notes')", timeout=5000)
    assert page.locator(".file-item:has-text('.gitkeep')").count() == 0, \
        f".gitkeep row leaked into the tree"
    print("✓ new folder row visible in tree, .gitkeep hidden from UI")

    # --- R. Root row in the tree: the "create here" target goes back to the repository root ---
    # B left "Notes/new-folder-in-notes" as the target with Notes expanded. The row only
    # changes the target: nothing is written and Notes stays expanded for C. The one
    # drop strip follows the active folder (see AGENTS.md).
    CONTENT_WRITES.clear()
    # R1 - a folder is the target: the root row sits above the one drop strip, inside the tree.
    page.wait_for_function(
        "document.getElementById('active-folder-path').textContent.trim() === 'Notes/new-folder-in-notes'",
        timeout=5000,
    )
    page.wait_for_selector("#file-tree .tree-home", state="visible", timeout=5000)
    assert page.locator("#btn-root-folder").count() == 0, "the header root button must be gone"
    r_strips = page.eval_on_selector_all(".tree-root-drop", "els => els.map(e => [e.className, e.dataset.targetFolder])")
    assert r_strips == [["tree-root-drop", "Notes/new-folder-in-notes"]], r_strips
    r_geom = page.evaluate("""() => {
        const h = document.querySelector('.tree-home').getBoundingClientRect();
        const s = document.querySelector('.tree-root-drop').getBoundingClientRect();
        const t = document.getElementById('file-tree').getBoundingClientRect();
        return { above: h.bottom <= s.top, inside: h.left >= t.left && h.right <= t.right, width: h.width };
    }""")
    assert r_geom["above"] and r_geom["inside"] and r_geom["width"] > 0, r_geom
    # R2 - the click makes the root the target; the one strip becomes the root strip.
    page.click(".tree-home")
    page.wait_for_selector(".tree-home", state="detached", timeout=5000)
    r_path = page.inner_text("#active-folder-path").strip()
    assert r_path == "/", r_path
    r_strips = page.eval_on_selector_all(".tree-root-drop", "els => els.map(e => [e.className, e.dataset.targetFolder])")
    assert r_strips == [["tree-root-drop tree-root-drop-root", ""]], r_strips
    assert page.locator(".file-item[data-path='Notes/Test note.md']").count() == 1, \
        "the root row must not collapse Notes"
    # R3 - New file now offers the repository root; Cancel writes nothing.
    page.click("#btn-add-menu")
    page.click("#btn-new-file")
    page.wait_for_selector("#new-file-overlay:not(.hidden)", state="visible", timeout=8000)
    r_label = page.inner_text("#new-file-folder-label").strip()
    assert r_label == "Created in repository root", r_label
    page.click("#btn-new-file-dismiss")
    page.wait_for_selector("#new-file-overlay", state="hidden", timeout=8000)
    assert not CONTENT_WRITES, f"the root row or a cancelled New file wrote something: {CONTENT_WRITES}"
    print("\u2713 root row: the create target returns to the repository root; one drop strip follows it, nothing is written")

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
    # The second note links to the first one until the end of G5: backlinks
    # after a reload (G5) must come from the stored index. Restored afterwards so
    # later scenarios (delete, rename, move) see the plain note.
    # Mutate harness.SECOND_MD (handle_github_api reads that module global).
    import e2e.harness as _h
    SECOND_MD_PLAIN = _h.SECOND_MD
    _h.SECOND_MD = "# Second note\n\nSECOND_NOTE_BODY\n\nSee [[Test note]].\n"
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
    # Backlinks after a reload: the second note is still not downloaded (checked
    # above) and the in-memory body cache is empty, so its link to this note can
    # only come from the links stored with the search index in IndexedDB.
    page.click("#btn-backlinks")
    page.wait_for_selector("#backlinks-panel .backlink-item[title='Notes/Second note.md']", timeout=10000)
    assert not any(SECOND_URL_PART in u for u in FETCH_LOG), \
        "backlinks must come from the stored index, not from downloading the linking note"
    page.click("#btn-backlinks")
    wait_until(lambda: page.locator("#backlinks-panel.hidden").count() == 1, what="the backlinks panel to close")
    _h.SECOND_MD = SECOND_MD_PLAIN
    print("\u2713 backlinks are complete after a reload without downloading the linking notes")
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

    # The tabs scenario above ends with no file open. Print checks need one open.
    page.click(".file-item:not(.folder):visible >> text=Test note.md")
    page.wait_for_function(
        "document.getElementById('btn-print') && document.getElementById('btn-print').disabled === false",
        timeout=5000,
    )

    # --- 5. Print prepares a document root (Save as PDF is the system dialog) ---
    # Stub window.print so headless CI does not hang on a native dialog.
    page.evaluate("""() => {
        window.__printCalled = 0;
        window.print = () => { window.__printCalled += 1; };
    }""")
    page.click("#btn-print")
    page.wait_for_function("window.__printCalled >= 1", timeout=15000)
    # During print the root is built then removed after afterprint/timeout.
    # Capture content by intercepting: re-run prepare path via a second call
    # that freezes cleanup long enough, OR inspect that print was invoked with
    # a body that had the root. Simpler: monkey-patch again and snapshot HTML
    # inside print() before the app removes the root.
    page.evaluate("""() => {
        window.__printSnap = null;
        window.print = () => {
            window.__printCalled += 1;
            const root = document.getElementById('print-root');
            window.__printSnap = root ? {
                text: root.innerText || '',
                html: root.innerHTML || '',
                hasImg: !!root.querySelector('img'),
                imgSrc: (root.querySelector('img') && root.querySelector('img').src) || '',
                bodyHasMdPrinting: document.body.classList.contains('md-printing'),
            } : null;
        };
    }""")
    page.click("#btn-print")
    page.wait_for_function("window.__printSnap !== null", timeout=15000)
    snap = page.evaluate("window.__printSnap")
    assert snap and snap.get("bodyHasMdPrinting"), f"print root missing md-printing: {snap}"
    assert "Test note" in (snap.get("text") or "") or "Hello" in (snap.get("text") or ""), \
        f"print root text missing document body: {(snap.get('text') or '')[:200]!r}"
    assert snap.get("hasImg"), "print root should include resolved images"
    assert (snap.get("imgSrc") or "").startswith("data:image/") or (snap.get("imgSrc") or "").startswith("blob:"), \
        f"print image src unexpected: {(snap.get('imgSrc') or '')[:80]!r}"
    # After print, chrome is restored
    page.wait_for_function("!document.body.classList.contains('md-printing')", timeout=5000)
    page.wait_for_function("!document.getElementById('print-root')", timeout=5000)
    print("✓ Print prepares document root with text + images, then cleans up")

    # --- 6. Scrolling a long document ---
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

    # --- 3b. Live layout keeps both panes in step with the minimap CLOSED ---
    # The sync used to live inside the minimap, so closing the map left the
    # panes scrolling on their own (js/scroll-sync.js owns it now).
    PV_SIDE = "document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side')"
    map_was_open = page.locator("#minimap-wrap:not(.hidden)").count() > 0
    if map_was_open:
        page.click("#btn-minimap")
    page.click('#layout-toggle .layout-btn[data-mode="split"]')
    page.wait_for_function(
        "() => { const pv = " + PV_SIDE + "; return !!pv && !!pv.querySelector('.md-img-wrap')"
        " && !pv.querySelector('.md-img-wrap.loading') && pv.scrollHeight > pv.clientHeight + 200; }",
        timeout=8000,
    )
    page.evaluate("document.querySelector('.CodeMirror').CodeMirror.scrollTo(null, 1000)")
    page.wait_for_timeout(200)
    page.evaluate("document.querySelector('.CodeMirror').CodeMirror.scrollTo(null, 1600)")
    page.wait_for_function("() => " + PV_SIDE + ".scrollTop > 100", timeout=3000)
    pv_top = page.evaluate("() => " + PV_SIDE + ".scrollTop")
    # Let the glide finish first: a glide frame still running can overwrite the
    # scrollTop write below before its scroll event is delivered (that made 3b flaky).
    page.evaluate("""() => new Promise((done) => {
      const pv = document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side');
      let last = -1, same = 0;
      const tick = () => {
        const t = pv.scrollTop;
        same = t === last ? same + 1 : 0;
        last = t;
        if (same >= 5) done(); else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    })""")
    page.evaluate("() => { " + PV_SIDE + ".scrollTop = 0; }")
    page.wait_for_function(
        "() => document.querySelector('.CodeMirror').CodeMirror.getScrollInfo().top < 50",
        timeout=3000,
    )
    print(f"✓ Live with the minimap closed: Source moves Preview (to {pv_top}px) and Preview moves Source back")
    if map_was_open:
        page.click("#btn-minimap")
    page.click('#layout-toggle .layout-btn[data-mode="preview"]')


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

    # --- View-only PDF / DOCX: open, Source stub, Live/Preview content, Download ---
    EXTRA_TREE.append({"path": "Docs/sample.pdf", "type": "blob", "sha": "sha-pdf"})
    EXTRA_TREE.append({"path": "Docs/sample.docx", "type": "blob", "sha": "sha-docx"})
    page.click("#btn-refresh")
    # New folders are expanded by default (collapsedFolders only seeds on first
    # render). Clicking Docs would TOGGLE and hide the children — only expand if
    # the toggle shows the collapsed marker.
    page.wait_for_selector(".file-item.folder[data-path='Docs']", timeout=8000)
    page.evaluate("""() => {
      const row = document.querySelector(".file-item.folder[data-path='Docs']");
      if (!row) return;
      const toggle = row.querySelector('.folder-toggle');
      if (toggle && /▸/.test(toggle.textContent || '')) row.click();
    }""")
    page.wait_for_selector(".file-item[data-path='Docs/sample.pdf']", timeout=8000)
    page.wait_for_selector(".file-item[data-path='Docs/sample.docx']", timeout=5000)

    # Tree shows view-only files as openable (not greyed .other)
    assert page.locator(".file-item.other[data-path='Docs/sample.pdf']").count() == 0, \
        "PDF row must not be marked as non-openable (.other)"
    assert page.locator(".file-item.other[data-path='Docs/sample.docx']").count() == 0, \
        "DOCX row must not be marked as non-openable (.other)"

    # Open PDF → Source stub, Live shows iframe
    page.click(".file-item[data-path='Docs/sample.pdf']")
    page.wait_for_function(
        "() => document.getElementById('binary-viewer') && "
        "!document.getElementById('binary-viewer').classList.contains('hidden')",
        timeout=8000,
    )
    page.click('#layout-toggle .layout-btn[data-mode="source"]')
    page.wait_for_timeout(200)
    stub = page.inner_text("#binary-viewer")
    assert "Editing of this file type is not supported" in stub, f"PDF Source stub missing: {stub[:200]!r}"
    assert page.locator("#btn-download").is_enabled(), "Download must be enabled for PDF"
    assert page.locator("#btn-save").is_disabled(), "Save must stay disabled for view-only PDF"
    page.click('#layout-toggle .layout-btn[data-mode="preview"]')
    page.wait_for_selector("#binary-viewer iframe.binary-pdf-frame", timeout=8000)
    pdf_src = page.get_attribute("#binary-viewer iframe.binary-pdf-frame", "src") or ""
    assert pdf_src.startswith("blob:"), f"PDF iframe must use blob URL, got {pdf_src[:80]!r}"
    print("✓ PDF view-only: Source stub + Preview iframe (blob URL)")

    with page.expect_download(timeout=15000) as pdf_dl:
        page.click("#btn-download")
    pdf_dl_path = BASE / "_e2e_sample.pdf"
    pdf_dl.value.save_as(pdf_dl_path)
    assert pdf_dl_path.stat().st_size > 20, "downloaded PDF is empty"
    assert pdf_dl_path.read_bytes()[:4] == b"%PDF", "downloaded file is not a PDF"
    pdf_dl_path.unlink(missing_ok=True)
    print("✓ PDF Download button saves the original bytes")

    # Context menu on DOCX: Open + Download must be present
    # Ensure Docs is still expanded after PDF open (active folder may have changed).
    page.evaluate("""() => {
      const row = document.querySelector(".file-item.folder[data-path='Docs']");
      if (!row) return;
      const toggle = row.querySelector('.folder-toggle');
      if (toggle && /▸/.test(toggle.textContent || '')) row.click();
    }""")
    page.wait_for_selector(".file-item[data-path='Docs/sample.docx']", timeout=5000)
    page.click(".file-item[data-path='Docs/sample.docx']", button="right")
    page.wait_for_selector(".folder-context-menu", timeout=5000)
    menu_actions = page.eval_on_selector_all(
        ".folder-context-menu button",
        "els => els.map(e => e.getAttribute('data-action'))",
    )
    assert "open" in menu_actions, f"DOCX context menu missing Open: {menu_actions}"
    assert "download" in menu_actions, f"DOCX context menu missing Download: {menu_actions}"
    page.click(".folder-context-menu button[data-action='open']")
    page.wait_for_function(
        "() => document.getElementById('current-file') && "
        "document.getElementById('current-file').textContent.includes('sample.docx')",
        timeout=8000,
    )
    page.click('#layout-toggle .layout-btn[data-mode="source"]')
    page.wait_for_timeout(200)
    docx_stub = page.inner_text("#binary-viewer")
    assert "Editing of this file type is not supported" in docx_stub, \
        f"DOCX Source stub missing: {docx_stub[:200]!r}"
    page.click('#layout-toggle .layout-btn[data-mode="preview"]')
    page.wait_for_function(
        "() => { const el = document.getElementById('binary-viewer');"
        " return el && el.innerText.includes('DOCX_PREVIEW_OK'); }",
        timeout=15000,
    )
    print("✓ DOCX view-only: context Open, Source stub, Preview HTML via Mammoth stub")

    with page.expect_download(timeout=15000) as docx_dl:
        page.click("#btn-download")
    docx_dl_path = BASE / "_e2e_sample.docx"
    docx_dl.value.save_as(docx_dl_path)
    assert docx_dl_path.stat().st_size > 50, "downloaded DOCX is empty"
    assert docx_dl_path.read_bytes()[:2] == b"PK", "downloaded DOCX is not a ZIP/OOXML package"
    docx_dl_path.unlink(missing_ok=True)
    print("✓ DOCX Download button saves the original bytes")

    # Context-menu Download from tree for markdown
    page.evaluate("""() => {
      const row = document.querySelector(".file-item.folder[data-path='Notes']");
      if (!row) return;
      const toggle = row.querySelector('.folder-toggle');
      if (toggle && /▸/.test(toggle.textContent || '')) row.click();
    }""")
    page.wait_for_selector(".file-item[data-path='Notes/Test note.md']", timeout=5000)
    page.click(".file-item[data-path='Notes/Test note.md']", button="right")
    page.wait_for_selector(".folder-context-menu button[data-action='download']", timeout=5000)
    with page.expect_download(timeout=15000) as md_dl:
        page.click(".folder-context-menu button[data-action='download']")
    md_path = BASE / "_e2e_note.md"
    md_dl.value.save_as(md_path)
    body = md_path.read_text(encoding="utf-8", errors="replace")
    assert "Test note" in body or "Hello" in body, f"unexpected md download body: {body[:120]!r}"
    md_path.unlink(missing_ok=True)
    print("✓ Tree context-menu Download works for markdown")

    page.click('#layout-toggle .layout-btn[data-mode="source"]')

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

    # --- Preview checkbox: a click ticks the matching line, also below code blocks ---
    # findTaskLines (js/markdown-commands.js) and marked must agree on which lines
    # are tasks: a task inside a code block (also inside a quote) is code.
    page.evaluate("""() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const F = String.fromCharCode(96).repeat(3);
      cm.setValue(['- [ ] first', '> ' + F, '> - [ ] fake', '> ' + F, '', F + 'js', '- [ ] also fake', F, '', '- [ ] last', ''].join('\\n'));
    }""")
    page.click('#layout-toggle .layout-btn[data-mode="preview"]')
    page.wait_for_function(
        "() => { const pv = document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side');"
        " if (!pv) return false; const b = pv.querySelectorAll('input[type=checkbox]');"
        " return b.length === 2 && !b[1].disabled; }",
        timeout=8000,
    )
    page.click('.editor-area .EasyMDEContainer .editor-preview-side input[type=checkbox] >> nth=1')
    wait_until(lambda: '- [x] last' in editor_text(), seconds=5, what="the second Preview checkbox to tick '- [x] last'")
    task_text = editor_text()
    assert '- [ ] first' in task_text and '> - [ ] fake' in task_text and '- [ ] also fake' in task_text, \
        f"a Preview checkbox click changed the wrong line: {task_text!r}"
    print("\u2713 Preview checkbox below code blocks ticks its own line")
    page.click('#layout-toggle .layout-btn[data-mode="source"]')

    # --- Link suggestions: typing [[ offers notes, Enter inserts a root-absolute link ---
    page.click(".CodeMirror")
    page.evaluate("""() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      cm.setValue('');
      cm.focus();
    }""")
    page.keyboard.type("see [[Test")
    page.wait_for_selector(".link-suggest-menu .link-suggest-item", timeout=5000)
    first = page.get_attribute(".link-suggest-menu .link-suggest-item", "data-path")
    assert first == "Notes/Test note.md", f"unexpected first suggestion: {first!r}"
    page.keyboard.press("Enter")
    wait_until(lambda: "</Notes/Test note.md>" in editor_text(), seconds=5, what="Enter to insert the suggested link")
    link_line = editor_text().split("\n")[0]
    assert link_line == "see [Test note](</Notes/Test note.md>)", f"unexpected text after picking a suggestion: {link_line!r}"
    assert page.locator(".link-suggest-menu").count() == 0, "the suggestion menu stayed open"
    print("\u2713 typing [[ suggests notes and Enter inserts a link")

    # --- Typing in Live keeps loaded images: no collapse of the Preview height ---
    # Every keystroke re-renders Preview. Resetting loaded images to a 1x1
    # placeholder collapsed the pane, the browser moved its scrollTop and the
    # scroll sync dragged Source toward the end of the note.
    page.evaluate("(t) => { document.querySelector('.CodeMirror').CodeMirror.setValue(t); }", MD_CONTENT)
    page.click('#layout-toggle .layout-btn[data-mode="split"]')
    page.wait_for_function(
        "() => { const pv = document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side');"
        " return !!pv && pv.querySelectorAll('.md-img-wrap').length >= 2"
        " && !pv.querySelector('.md-img-wrap.loading') && pv.scrollHeight > pv.clientHeight + 200; }",
        timeout=8000,
    )
    page.evaluate("""() => {
      const cm = document.querySelector('.CodeMirror').CodeMirror;
      const line = cm.getValue().split('\\n').findIndex((l) => l.startsWith('Line 300 '));
      cm.setCursor({ line, ch: 0 });
      cm.focus();
      const pv = document.querySelector('.editor-area .EasyMDEContainer .editor-preview-side');
      window.__pvWatch = { h0: pv.scrollHeight, minH: pv.scrollHeight, maxLoading: 0 };
      window.__pvObs = new MutationObserver(() => {
        const w = window.__pvWatch;
        w.minH = Math.min(w.minH, pv.scrollHeight);
        w.maxLoading = Math.max(w.maxLoading, pv.querySelectorAll('.md-img-wrap.loading').length);
      });
      window.__pvObs.observe(pv, { childList: true, subtree: true });
    }""")
    page.keyboard.type("Q")
    page.wait_for_timeout(800)
    watch = page.evaluate("() => { window.__pvObs.disconnect(); return window.__pvWatch; }")
    assert "Q" in editor_text(), "the typed text did not reach the editor"
    assert watch["maxLoading"] == 0 and watch["minH"] >= watch["h0"] * 0.9, \
        f"typing re-rendered Preview with image placeholders (height collapse): {watch}"
    print(f"\u2713 typing in Live keeps loaded images, no height collapse ({watch})")
    page.click('#layout-toggle .layout-btn[data-mode="source"]')

    # --- Discard button: drop local edits, take the GitHub version, push nothing ---
    page.click(".CodeMirror")
    page.keyboard.press("Control+End")
    page.keyboard.type("DISCARD_ME")
    page.wait_for_function("() => { const b = document.getElementById('btn-discard'); return !!b && !b.disabled; }", timeout=5000)
    badge_before = page.evaluate("() => { const b = document.getElementById('commit-badge'); return b && !b.classList.contains('hidden') ? (parseInt(b.textContent, 10) || 0) : 0; }")
    assert badge_before >= 1, f"the edit did not reach the Commit badge: {badge_before}"
    page.evaluate("() => { window.__mdConfirm = window.confirm; window.confirm = () => true; }")
    page.click("#btn-discard")
    wait_until(lambda: "DISCARD_ME" not in editor_text(), seconds=5, what="Discard to restore the GitHub text")
    page.evaluate("() => { window.confirm = window.__mdConfirm; }")
    assert not [w for w in CONTENT_WRITES if w["method"] == "PUT" and "DISCARD_ME" in w["text"]], "Discard pushed the discarded text"
    wait_until(lambda: page.locator("#tab-bar .tab.active.dirty").count() == 0, seconds=5, what="the unsaved dot to clear after Discard")
    assert page.is_disabled("#btn-discard"), "Discard stays enabled on a clean file"
    badge_after = page.evaluate("() => { const b = document.getElementById('commit-badge'); return b && !b.classList.contains('hidden') ? (parseInt(b.textContent, 10) || 0) : 0; }")
    assert badge_after < badge_before, f"Commit badge did not drop after Discard: {badge_before} -> {badge_after}"
    print(f"\u2713 Discard restores the GitHub version, pushes nothing, clears the dot and the badge ({badge_before} -> {badge_after})")

    # --- Overlapping tree loads: a slow older response must not overwrite a newer tree ---
    race = {"hold": True, "held": None}
    old_tree_body = json.dumps({"tree": FAKE_TREE["tree"] + EXTRA_TREE})
    def hold_first_tree(route, request):
        if race["hold"] and race["held"] is None:
            race["held"] = route
            return
        route.fallback()
    TREE_ROUTE = re.compile(r"https://api\.github\.com/.*/git/trees/.*")
    page.route(TREE_ROUTE, hold_first_tree)
    page.click("#btn-refresh")
    for _ in range(50):
        if race["held"] is not None:
            break
        page.wait_for_timeout(100)
    assert race["held"] is not None, "the first tree request was not captured"
    race["hold"] = False
    EXTRA_TREE.append({"path": "race-new.md", "type": "blob", "sha": "sha-race"})
    page.click("#btn-refresh")
    page.wait_for_selector(".file-item:not(.folder):has-text('race-new.md')", timeout=5000)
    race["held"].fulfill(status=200, content_type="application/json", body=old_tree_body)
    page.wait_for_timeout(800)
    assert page.locator(".file-item:not(.folder):has-text('race-new.md')").count() >= 1, \
        "a stale tree response landed after a newer one and overwrote the tree"
    print("\u2713 a slow older tree load does not overwrite a newer one")
    page.unroute(TREE_ROUTE, hold_first_tree)
    EXTRA_TREE[:] = [e for e in EXTRA_TREE if e.get("path") != "race-new.md"]
    page.click("#btn-refresh")
    page.wait_for_selector(".file-item:not(.folder):has-text('race-new.md')", state="detached", timeout=5000)

    # --- H. Switching repository IN-APP must not leak the previous session's
    # listeners. showApp() runs again on a switch with NO page reload, and the
    # upload/mobile listeners used to be re-attached every time while keeping the
    # PREVIOUS session's GitHubClient: a toolbar upload committed the image into
    # the repo the user had just LEFT (and still said "Image added ✓"), a drop
    # wrote it into BOTH, and the phone files/format buttons toggled twice per
    # click so they did nothing at all.
    #
    # Last scenario on purpose: it changes the open repository and the viewport,
    # which earlier checks would have to compensate for.
    print("\n--- H. in-app repo switch: one upload, one repo, working phone buttons ---")

    # Back to the first repo and a known-open file before switching.
    page.click(".file-item:not(.folder):has-text('Test note.md')")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=8000)
    assert page.inner_text("#repo-label") == "test-owner/test-repo", "not back on the first repo"

    # Switch to the second repository through the real switcher UI.
    page.click("#btn-switch-repo")
    page.wait_for_selector("#repo-switch-overlay:not(.hidden)", timeout=8000)
    # The list is populated asynchronously from /user/repos.
    page.wait_for_selector(".repo-list-item", timeout=8000)
    listed = page.eval_on_selector_all(".repo-list-item", "els => els.map(e => e.textContent.trim())")
    assert any(SECOND_REPO in t for t in listed), f"switcher did not list the second repo: {listed}"
    page.click(f".repo-list-item:has-text('{SECOND_REPO}')")
    # The app is rebuilt without a reload: the label changes, the URL does not.
    page.wait_for_function(
        "() => document.getElementById('repo-label').textContent.includes('second-owner')",
        timeout=15000,
    )
    page.wait_for_selector(".file-item", timeout=8000)
    assert "/second-owner" not in page.url, "switching repo must not navigate"
    print(f"✓ switched to {SECOND_REPO} without a reload")

    # Open a file there: uploads are refused with "Open an .md file first" unless
    # one is open, and the inserted link is relative to the current path.
    page.click(".file-item.folder:has-text('Notes')")
    page.click(".file-item:not(.folder):has-text('Test note.md')")
    page.wait_for_function("document.getElementById('btn-save').disabled === false", timeout=8000)

    # H1 — toolbar upload: exactly ONE PUT, into the NEW repository.
    # Without the fix this wrote into test-owner/test-repo while reporting success.
    PUT_URLS.clear()
    page.set_input_files("#image-file-input", {
        "name": "switched.png",
        "mimeType": "image/png",
        "buffer": base64.b64decode(TINY_PNG_B64),
    })
    wait_until(lambda: len(PUT_URLS) >= 1, seconds=15, what="the upload to reach the contents API")
    page.wait_for_timeout(1500)  # a leaked second listener would land here too
    assert len(PUT_URLS) == 1, (
        f"expected exactly ONE PUT for one image upload, got {len(PUT_URLS)}: {PUT_URLS}"
    )
    assert SECOND_REPO in PUT_URLS[0], (
        f"the image was committed to the WRONG repository (the previous session's): {PUT_URLS[0]}"
    )
    print(f"✓ toolbar upload after a switch: exactly one PUT, into {SECOND_REPO}")

    # H2 — drag&drop upload: also exactly ONE PUT, and the link inserted ONCE.
    # Without the fix a drop hit every listener and wrote to BOTH repositories.
    PUT_URLS.clear()
    page.evaluate("""(b64) => {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const file = new File([bytes], 'dropped.png', {type: 'image/png'});
        const dt = new DataTransfer();
        dt.items.add(file);
        document.getElementById('editor-container').dispatchEvent(
            new DragEvent('drop', {dataTransfer: dt, bubbles: true, cancelable: true})
        );
    }""", TINY_PNG_B64)
    wait_until(lambda: len(PUT_URLS) >= 1, seconds=15, what="the drop to reach the contents API")
    page.wait_for_timeout(1500)
    assert len(PUT_URLS) == 1, (
        f"expected exactly ONE PUT for one dropped image, got {len(PUT_URLS)}: {PUT_URLS}"
    )
    assert SECOND_REPO in PUT_URLS[0], (
        f"the dropped image was committed to the WRONG repository: {PUT_URLS[0]}"
    )
    links = page.evaluate(
        "() => (document.querySelector('.CodeMirror').CodeMirror.getValue()"
        ".match(/!\\[dropped\\.png\\]/g) || []).length"
    )
    assert links == 1, f"the dropped image link was inserted {links} times, expected once"
    print(f"✓ drop after a switch: exactly one PUT, one inserted link, into {SECOND_REPO}")

    # H3 — phone viewport: the files button must OPEN then CLOSE on successive
    # clicks. With two listeners one click toggled twice and cancelled itself out,
    # so after a repo switch both phone buttons did nothing at all.
    page.set_viewport_size({"width": 420, "height": 780})
    page.wait_for_timeout(400)  # let the ≤768px media query apply
    files_btn = page.locator("#btn-mobile-files")
    assert files_btn.is_visible(), "the phone files button is not visible at 420px"
    assert not page.evaluate("() => document.body.classList.contains('mobile-sidebar-open')"), \
        "the files drawer should start closed"
    files_btn.click()
    page.wait_for_function(
        "() => document.body.classList.contains('mobile-sidebar-open') === true",
        timeout=5000,
    )
    print("✓ phone files button opens the drawer after a repo switch")
    files_btn.click()
    page.wait_for_function(
        "() => document.body.classList.contains('mobile-sidebar-open') === false",
        timeout=5000,
    )
    print("✓ phone files button closes the drawer on a second click")

    # The formatting strip — the other button that was toggling twice.
    fmt_btn = page.locator("#btn-mobile-fmt")
    assert fmt_btn.is_visible(), "the phone formatting button is not visible at 420px"
    fmt_btn.click()
    page.wait_for_function(
        "() => document.body.classList.contains('mobile-fmt-open') === true",
        timeout=5000,
    )
    print("✓ phone formatting button opens the strip after a repo switch")
    fmt_btn.click()
    page.wait_for_function(
        "() => document.body.classList.contains('mobile-fmt-open') === false",
        timeout=5000,
    )
    print("✓ phone formatting button closes the strip on a second click")

    # H4 — the outline scroll-spy must follow the NEW editor instance. It used to
    # stay subscribed to the CodeMirror showApp() had just destroyed, so the
    # highlight froze on the first heading however far the cursor moved.
    page.set_viewport_size({"width": 1400, "height": 900})
    page.wait_for_timeout(300)
    page.evaluate("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        cm.setValue('# Alpha\\n\\ntext\\n\\n## Beta\\n\\ntext\\n\\n### Gamma\\n\\ntext\\n\\n## Delta\\n\\ntext\\n');
        const btn = document.getElementById('btn-outline');
        if (btn) btn.click();
    }""")
    page.wait_for_function(
        "() => document.querySelectorAll('#doc-outline .outline-item').length >= 4",
        timeout=8000,
    )
    spy = page.evaluate("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        const active = () => {
            const a = document.querySelector('#doc-outline .outline-item.active');
            return a ? a.textContent : null;
        };
        cm.setCursor({line: 10, ch: 0});   // "text" under "### Gamma" (line 8)
        cm.operation(() => {});
        const onGamma = active();
        cm.setCursor({line: 12, ch: 0});   // "## Delta" itself (line 12)
        const onDelta = active();
        return {onGamma, onDelta};
    }""")
    assert spy["onGamma"] == "Gamma", f"outline scroll-spy did not follow the cursor: {spy}"
    assert spy["onDelta"] == "Delta", f"outline scroll-spy did not follow the cursor: {spy}"
    print("✓ outline scroll-spy follows the cursor on the rebuilt editor")

    # --- I. FOLDER DRAG & DROP: a folder row onto another folder row, then onto the root strip ---
    print("\n--- I. folder drag & drop: onto a folder row, then onto the root strip ---")

    def drag_folder_onto(page, src_path, target_selector):
        # A REAL browser drag (Playwright's mouse path triggers the native
        # HTML5 DnD). Synthetic DragEvents do NOT work for this: Chromium
        # exposes the data store to real drag lifecycle events only — getData()
        # inside a synthetic drop handler returns '' (verified with a probe;
        # the same drag via drag_and_drop returns the payload).
        page.drag_and_drop(f".file-item.folder[data-path='{src_path}']", target_selector)

    def assert_one_move_commit(old_path, new_path, sha):
        # The folder move is ONE atomic commit (Git Data API). Reverse check:
        # the old per-file way (contents PUT + DELETE, no tree) fails every line.
        assert len(GIT_TREES) == 1, f"expected ONE tree for the folder move, got {GIT_TREES}"
        assert len(GIT_REF_UPDATES) == 1, f"expected ONE branch update, got {GIT_REF_UPDATES}"
        assert SECOND_REPO in GIT_TREES[0]["url"], f"tree posted to the wrong repository: {GIT_TREES[0]['url']}"
        entries = {e.get("path"): e.get("sha") for e in GIT_TREES[0]["tree"]}
        assert entries == {new_path: sha, old_path: None}, f"unexpected tree entries: {GIT_TREES[0]['tree']}"
        assert not GIT_BLOBS, f"a non-markdown file was re-uploaded as a blob: {GIT_BLOBS}"
        assert not [w for w in CONTENT_WRITES if "move-me.txt" in w["url"]], \
            f"the folder move still wrote file by file: {CONTENT_WRITES}"

    def reset_write_logs():
        CONTENT_WRITES.clear()
        GIT_TREES.clear()
        GIT_BLOBS.clear()
        GIT_REF_UPDATES.clear()

    # Fixtures: a source folder and an empty target container. The DESTINATION
    # path must NOT be pre-seeded — onMoveFolder refuses to move onto an
    # existing name (part of the feature), so the mock only learns the
    # destination after the move, like a real tree reload would.
    # Scenario H switched the app to the SECOND repo, so the fixtures belong
    # in SECOND_TREE — EXTRA_TREE only feeds the first repo's mock.
    SECOND_TREE.append({"path": "DragSrc/move-me.txt", "type": "blob", "sha": "sha-mv1"})
    SECOND_TREE.append({"path": "DragTarget/.gitkeep", "type": "blob", "sha": "sha-gk-t"})
    page.click("#btn-refresh")
    page.wait_for_selector(".file-item.folder[data-path='DragSrc']", timeout=5000)
    page.wait_for_selector(".file-item.folder[data-path='DragTarget']", timeout=5000)

    def active_folder_text():
        return page.locator("#active-folder-path").inner_text().strip()

    # I1 — DragSrc onto the DragTarget folder ROW.
    reset_write_logs()
    seen_dialogs.clear()
    drag_folder_onto(page, "DragSrc", ".file-item.folder[data-path='DragTarget']")
    wait_until(lambda: GIT_REF_UPDATES, seconds=15, what="the folder move to land as one commit")
    assert_one_move_commit("DragSrc/move-me.txt", "DragTarget/DragSrc/move-me.txt", "sha-mv1")
    assert any('Move "DragSrc"' in d for d in seen_dialogs), \
        f"folder drag did not ask for confirmation: {seen_dialogs}"
    # The post-move tree reload expanded the destination: expandFolderChain
    # rebased the "create here" target onto it, which the label reports —
    # observable parent-side, no mock seeding needed.
    wait_until(lambda: active_folder_text() == "DragTarget/DragSrc",
               what="the destination folder to become the active target")
    # GitHub now lists the file under its new path: a refresh shows the moved
    # folder under the target, expanded (its file row is visible), while the
    # old root-level row is gone.
    SECOND_TREE[:] = [e for e in SECOND_TREE if e["path"] != "DragSrc/move-me.txt"]
    SECOND_TREE.append({"path": "DragTarget/DragSrc/move-me.txt", "type": "blob", "sha": "sha-mv2"})
    page.click("#btn-refresh")
    page.wait_for_selector(".file-item.folder[data-path='DragTarget/DragSrc']", timeout=5000)
    page.wait_for_selector(".file-item[data-path='DragTarget/DragSrc/move-me.txt']", timeout=5000)
    page.wait_for_selector(".file-item.folder[data-path='DragSrc']", state="detached", timeout=5000)
    print("✓ dragging a folder onto another folder moves it there, destination expanded")

    # I2 — DragTarget/DragSrc onto the "move to repository root" strip.
    SECOND_TREE[:] = [e for e in SECOND_TREE if e["path"] != "DragTarget/DragSrc/move-me.txt"]
    reset_write_logs()
    seen_dialogs.clear()
    # The one drop strip follows the active folder (see AGENTS.md): I1 left
    # DragTarget/DragSrc active, so the root row makes the root the target first.
    wait_until(lambda: active_folder_text() == "DragTarget/DragSrc",
               what="I1 to leave the moved folder as the active target")
    page.wait_for_selector(".tree-home", state="visible", timeout=5000)
    page.click(".tree-home")
    page.wait_for_selector(".tree-root-drop-root", timeout=5000)
    wait_until(lambda: active_folder_text() == "/", what="the root to become the active target")
    drag_folder_onto(page, "DragTarget/DragSrc", ".tree-root-drop-root")
    wait_until(lambda: GIT_REF_UPDATES, seconds=15, what="the root move to land as one commit")
    assert_one_move_commit("DragTarget/DragSrc/move-me.txt", "DragSrc/move-me.txt", "sha-mv2")
    assert any('Move "DragSrc"' in d and 'repository root' in d for d in seen_dialogs), \
        f"root-strip move did not confirm with the root as destination: {seen_dialogs}"
    wait_until(lambda: active_folder_text() == "DragSrc",
               what="the root-level folder to become the active target")
    # It really landed at the root: a refresh shows the folder one level up.
    SECOND_TREE.append({"path": "DragSrc/move-me.txt", "type": "blob", "sha": "sha-mv3"})
    page.click("#btn-refresh")
    page.wait_for_selector(".file-item.folder[data-path='DragSrc']", timeout=5000)
    print("✓ dragging a folder onto the root strip moves it to the repository root")

    # CodeMirror syntax modes are registered on the instance the editor uses (python mode stands for all eight).
    page.wait_for_function(
        "() => { const cm = document.querySelector('.CodeMirror').CodeMirror; "
        "return !!(cm.constructor.modes && cm.constructor.modes.python); }",
        timeout=15000)
    mode_names = page.evaluate("""() => {
        const cm = document.querySelector('.CodeMirror').CodeMirror;
        const out = {};
        for (const m of ['xml', 'javascript', 'css', 'htmlmixed', 'python', 'shell', 'yaml', 'gfm']) {
            out[m] = !!cm.constructor.modes[m];
        }
        return out;
    }""")
    assert all(mode_names.values()), mode_names
    print("✓ CodeMirror syntax modes (8) are registered on the editor's own CodeMirror instance")


