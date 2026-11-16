#!/usr/bin/env python3
"""E2E entrypoint — independent scenario groups (new browser each).

Requires:
  npx vite --port 8080 --strictPort
  pip install playwright && playwright install chromium

Run from repo root:
  python e2e_smoke_test.py
"""
from e2e.harness import run_isolated
from e2e.scenarios_main import run_main_smoke
from e2e.scenarios_commit_search import run_commit_search_upload

def main():
    run_isolated("main_smoke", run_main_smoke)
    run_isolated("commit_search_upload", run_commit_search_upload)
    print("\nALL CHECKS PASSED")

if __name__ == "__main__":
    main()
