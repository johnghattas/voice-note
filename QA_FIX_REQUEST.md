# QA Fix Request

**Status**: REJECTED
**Date**: 2026-05-28
**QA Session**: 1

## Critical Issues to Fix

### 1. speech.html and cloud-speech.html crash — missing #loadMoreSentinel

**Problem**: Both `speech.html` and `cloud-speech.html` share `history.js` (which now requires `#loadMoreSentinel` in the DOM) but still have the old `<button id="loadMoreBtn">`. When `history.js` loads, `sentinel = document.getElementById("loadMoreSentinel")` returns `null`. Then `initHistory()` → `clearSentinelSpinner()` → `sentinel.innerHTML = ''` → **TypeError crash**. History never loads on these pages.

**Location**: 
- `public/speech.html:37`
- `public/cloud-speech.html:37`

**Required Fix**: In both files, replace:
```html
<button id="loadMoreBtn" class="btn btn-small load-more hidden">Load More</button>
```
with:
```html
<div id="loadMoreSentinel" class="load-more-sentinel"></div>
```

**Verification**:
1. Run: `findstr "loadMoreBtn" public\speech.html public\cloud-speech.html` → should find nothing
2. Run: `findstr "loadMoreSentinel" public\speech.html public\cloud-speech.html` → should find the sentinel div in both files
3. Serve the app and load `speech.html` — history must load without JS errors
4. Serve the app and load `cloud-speech.html` — history must load without JS errors

## After Fixes

Once fixes are complete:
1. Commit with message: "fix: Add loadMoreSentinel to speech.html and cloud-speech.html (qa-requested)"
2. QA will automatically re-run
3. Loop continues until approved
