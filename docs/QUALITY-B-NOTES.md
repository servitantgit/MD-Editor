# Quality track B (this pack)

## 4. E2E independent scenarios
- `e2e/harness.py` — mocks, `reset_mock_state`, `run_isolated`
- `e2e/scenarios_main.py` — landing … before Commit J
- `e2e/scenarios_commit_search.py` — J…Q; **reload before Q** so search state cannot leak
- `e2e_smoke_test.py` — runs each group in a **new browser**

## 5. Mammoth / SheetJS (no CDN)
- `js/binary-viewer.js` loads via Vite `import('mammoth')` / `import('xlsx')` (async chunks)
- Pin = `package-lock.json` only for these
- `html2pdf`: still unused by the app (`print-export.js` is the Print path). Not bundled.

## 6. Preview OAuth env
- Section added to `README-CLOUDFLARE.md`: set `GITHUB_CLIENT_ID` / `SECRET` on **Preview**, allow preview callback URLs on the GitHub OAuth App
