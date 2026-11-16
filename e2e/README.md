# E2E scenarios

`e2e_smoke_test.py` runs each group with `run_isolated()`:

- **new Chromium browser**
- **reset mocks** (`CONTENT_WRITES`, `EXTRA_TREE`, Git Data logs, …)
- **no UI state** carried across groups

| Module | Coverage |
|--------|----------|
| `scenarios_main` | Landing, search, autosave, tree CRUD, tabs, print, PDF/DOCX, … up to before Commit J |
| `scenarios_commit_search` | Commit snapshots (J), history (K), find/search (L–P), folder upload (Q). Before Q the page is reloaded so search UI state cannot leak. |

To add a group: new `e2e/scenarios_*.py` + `run_isolated("name", fn)` in the entrypoint.
Serve with **Vite**, not `serve.mjs`.
