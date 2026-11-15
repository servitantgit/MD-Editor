# Next steps (after Vite phase 1)

Phase 1 is done: core libraries via `js/vendor.js` + npm, `vite build` → `dist/`, Cloudflare
build command/output configured, unit and browser tests green against Vite.

## Priority A — finish the migration hygiene

1. **User-facing error copy** in `js/app.js`  
   Replace “allow cdn.jsdelivr.net / ERR_BLOCKED_BY_CLIENT” for *core* libraries with text about
   Vite / production `dist` / module load failure. Keep CDN wording only where Mammoth/SheetJS/
   html2pdf still load from the network.

2. **CI workflows**  
   - `test.yml` e2e job must start **Vite** (not `node serve.mjs`).  
   - Drop or align duplicate `e2e.yml` (Windows + missing Playwright install).  
   - One path: ubuntu, `npm ci`, Playwright chromium, `npx vite --port 8080 --strictPort`, wait, `python e2e_smoke_test.py`.

3. **e2e dead CDN mocks**  
   Remove EasyMDE/marked/DOMPurify/MiniSearch entries from `CDN_MOCKS` (they are no longer
   requested). Keep Mammoth (and SheetJS/html2pdf if tests hit them) stubs/routes.

4. **AGENTS-DETAIL.md**  
   Trim or mark obsolete sections that still describe “no bundler / three-way CDN pin for
   EasyMDE”. Short `AGENTS.md` already wins on checklist conflicts.

## Priority B — product / quality

5. **Split e2e into independent scenarios**  
   Each scenario: own browser context (or full reload + fresh mocks), no inherited sidebar
   query / tree state. Easier failures, parallelisable later.

6. **Optional on-demand libs into the bundle or vendor**  
   Mammoth, SheetJS, html2pdf — either lazy Vite chunks or stay CDN with clear pin + e2e mock.
   Goal: offline-friendly DOCX/XLSX/PDF path and fewer “blocked CDN” reports.

7. **Preview environment variables**  
   Document (done in README-CLOUDFLARE) and verify `GITHUB_CLIENT_ID` /
   `GITHUB_CLIENT_SECRET` exist for **Preview** as well as Production so branch previews can
   OAuth.

## Priority C — Vite phase 2 (optional, larger)

8. Replace `window.EasyMDE` / `window.marked` / … usage with real ES imports module-by-module.  
9. Tree-shaking / drop unused highlight.js languages if bundle size matters.  
10. Consider `experiment/cm6` only after phase 1 hygiene is stable on `main`.

## Do not mix in one PR

| Track | Why separate |
|-------|----------------|
| Hygiene (A) | Small, safe, unblocks agents and CI docs |
| e2e split (B5) | Large; failures hard to attribute if mixed with build changes |
| Vite phase 2 (C) | Touches every editor call site |
| CM6 experiment | Feature branch; must not destabilise main |

## Done when (phase 1 “closed”)

- [x] Prod and local editor load without jsDelivr for core libs  
- [x] `npm test` and e2e green with Vite  
- [ ] Docs/landing/CI text match the above (this pack)  
- [ ] Core-lib error messages no longer blame ad-blockers only  
