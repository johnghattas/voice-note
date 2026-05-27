# VoiceNotes - Project Specification

## Overview

VoiceNotes is a web application that converts speech to text using Google Gemini AI. Users record audio from their browser, and the app transcribes it (or translates Arabic audio to English). All transcriptions are saved to Firestore and viewable in a searchable history.

**Project ID:** `voicenotes-b6810`
**Runtime:** Node.js 20 (Cloud Functions), Vanilla JS (Frontend)
**Hosting:** Firebase Hosting
**Database:** Cloud Firestore
**AI Model:** Gemini 2.5 Flash

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                   Firebase Hosting                   │
│                                                      │
│   index.html (Auth)  ──►  app.html (Main App)       │
│   css/style.css                                      │
│   js/firebase-config.js                              │
│   js/auth.js                                         │
│   js/recorder.js                                     │
│   js/history.js                                      │
└──────────────┬──────────────────────────────────────┘
               │
               │ POST /api/transcribe
               ▼
┌──────────────────────────────────────────────────────┐
│              Cloud Function: transcribe              │
│                                                      │
│   1. Verify Firebase Auth token                      │
│   2. Extract base64 audio + mimeType + mode          │
│   3. Send to Gemini 2.5 Flash with prompt            │
│   4. Parse JSON response {text, language}            │
│   5. Return to client                                │
└──────────────┬──────────────────────────────────────┘
               │
               ▼
┌──────────────────────────────────────────────────────┐
│              Google Gemini API                        │
│              (Speech-to-Text / Translation)           │
└──────────────────────────────────────────────────────┘
```

---

## File Structure

```
VoiceNotes/
├── .firebaserc              # Firebase project alias ("voice" → voicenotes-b6810)
├── .gitignore               # Ignores node_modules, .env, .firebase, *.log
├── firebase.json            # Hosting, Firestore, Functions config
├── firestore.rules          # Security rules (user-scoped read/write/delete)
├── firestore.indexes.json   # Composite index: userId ASC + createdAt DESC
├── functions/
│   ├── .env                 # GEMINI_API_KEY (gitignored)
│   ├── index.js             # Cloud Function: transcribe
│   ├── package.json         # Dependencies: firebase-admin, firebase-functions, @google/generative-ai
│   └── package-lock.json
└── public/
    ├── index.html           # Login / Register page
    ├── app.html             # Main app page (recorder + history)
    ├── css/
    │   └── style.css        # All styles (auth, app, recorder, history, responsive)
    └── js/
        ├── firebase-config.js  # Firebase initialization with project config
        ├── auth.js             # Login, register, auth state redirect
        ├── recorder.js         # Audio recording, processing, save/copy/discard
        └── history.js          # Paginated history, real-time updates, search, delete
```

---

## Features

### 1. Authentication
- **Email/password** login and registration via Firebase Auth
- Tab-based UI switching between Login and Register forms
- Auto-redirect to `app.html` when authenticated
- Auto-redirect to `index.html` when not authenticated
- Logout button in app header

### 2. Voice Recording
- Uses `MediaRecorder` API to capture browser audio
- Supported MIME types (in priority order): `audio/webm;codecs=opus`, `audio/webm`, `audio/ogg;codecs=opus`, `audio/mp4`
- Live recording timer (MM:SS format)
- Wake Lock API to prevent screen sleep during recording
- Minimum audio size check (1000 bytes) to reject empty recordings
- Visual recording state: pulsing red animation on mic button

### 3. Transcription (Default Mode)
- Records audio in any language
- Sends base64-encoded audio to `/api/transcribe` with `mode: "transcribe"`
- Gemini prompt handles **code-switching** (Arabic speaker using English technical terms keeps English words in Latin script)
- Returns JSON: `{text: "...", language: "en" | "ar" | "mixed" | "unknown"}`

### 4. Translation Mode
- Dedicated green translate button (Arabic → English)
- Sends audio with `mode: "translate"`
- Gemini translates Arabic speech directly to English text
- Returns JSON: `{text: "...", language: "ar-to-en"}`

### 5. Result Handling
- After transcription/translation, result is shown in a card with:
  - **Copy** button — copies text to clipboard
  - **Save** button — saves to Firestore
  - **Discard** button — hides result without saving

### 6. History
- **Paginated loading** — 20 items per page with "Load More" button
- **Real-time updates** — Firestore `onSnapshot` listener for new/deleted docs
- **Search** — client-side text filter with 300ms debounce
- **Copy** — button or long-press (500ms, with haptic feedback on mobile)
- **Delete** — removes from Firestore, updates UI immediately
- **Language badges** — AR, EN, MIX, TR (translated)
- **Relative timestamps** — "Just now", "5m ago", "3h ago", then full date
- **Duration display** — shows recording length (e.g., "45s", "2m 30s")

---

## API

### `POST /api/transcribe`

**Cloud Function** — `transcribe` (Firebase Functions v2, HTTPS)

| Config | Value |
|--------|-------|
| CORS | Enabled |
| Max Instances | 10 |
| Invoker | Public |

**Headers:**
```
Authorization: Bearer <Firebase ID Token>
Content-Type: application/json
```

**Request Body:**
```json
{
  "audio": "<base64 encoded audio>",
  "mimeType": "audio/webm;codecs=opus",
  "mode": "transcribe" | "translate"
}
```

**Response (200):**
```json
{
  "text": "the transcribed or translated text",
  "language": "en" | "ar" | "mixed" | "ar-to-en" | "unknown"
}
```

**Error Responses:**
| Status | Body |
|--------|------|
| 405 | `{"error": "Method not allowed"}` |
| 401 | `{"error": "Unauthorized"}` or `{"error": "Invalid token"}` |
| 400 | `{"error": "Missing audio or mimeType"}` |
| 500 | `{"error": "Transcription failed"}` |

---

## Database

### Collection: `transcriptions`

| Field | Type | Description |
|-------|------|-------------|
| `userId` | string | Firebase Auth UID |
| `text` | string | Transcribed/translated text |
| `language` | string | `"en"`, `"ar"`, `"mixed"`, `"ar-to-en"`, `"unknown"` |
| `source` | string | `"mobile"` or `"desktop"` (detected via user agent) |
| `duration` | number | Recording duration in seconds |
| `createdAt` | timestamp | Server timestamp |

### Composite Index
- `userId` (ASC) + `createdAt` (DESC)
- Scope: Collection

### Security Rules
```
- CREATE: auth required, userId must match auth UID
- READ: auth required, userId must match auth UID
- DELETE: auth required, userId must match auth UID
- UPDATE: not allowed
```

---

## Frontend

### Pages

| Page | Path | Purpose |
|------|------|---------|
| Login/Register | `/index.html` | Authentication (redirects to app if logged in) |
| Main App | `/app.html` | Recording, transcription, history |

### Routing
- Firebase Hosting rewrite: `/api/transcribe` → Cloud Function `transcribe`
- No client-side router — simple page-based navigation

### Styling
- Vanilla CSS with CSS custom properties (design tokens)
- Mobile-first responsive design (breakpoint at 480px)
- System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`
- Color scheme: Indigo primary (`#4f46e5`), Red danger (`#dc2626`), Green translate (`#059669`)

### JS Architecture
- No build step, no framework, no bundler
- Firebase compat SDK loaded from CDN (v10.12.0)
- Four standalone JS files with shared globals (`auth`, `db`, `currentUser`)

---

## Environment Variables

| Variable | Location | Description |
|----------|----------|-------------|
| `GEMINI_API_KEY` | `functions/.env` | Google AI API key for Gemini model |

---

## Deployment

```bash
# Deploy everything
firebase deploy

# Deploy only functions
firebase deploy --only functions

# Deploy only hosting
firebase deploy --only hosting

# Deploy only Firestore rules/indexes
firebase deploy --only firestore
```

---

## Dependencies

### Cloud Functions (`functions/package.json`)

| Package | Version | Purpose |
|---------|---------|---------|
| `firebase-admin` | ^12.0.0 | Firestore, Auth admin SDK |
| `firebase-functions` | ^5.0.0 | Cloud Functions runtime |
| `@google/generative-ai` | ^0.21.0 | Gemini API client |

### Frontend (CDN)

| Library | Version | Purpose |
|---------|---------|---------|
| `firebase-app-compat` | 10.12.0 | Firebase core |
| `firebase-auth-compat` | 10.12.0 | Email/password auth |
| `firebase-firestore-compat` | 10.12.0 | Firestore client |

---

## Key Design Decisions

1. **Gemini for STT instead of dedicated Speech API** — Gemini handles code-switching (Arabic + English terms) better than traditional speech APIs, and adds translation capability with a prompt change.

2. **Base64 audio over the wire** — Audio is sent as base64 in the request body rather than uploaded to Cloud Storage. Simpler architecture, but limits recording size to what fits in a Cloud Function request (~10MB).

3. **No framework / no build step** — Vanilla HTML/CSS/JS with Firebase compat SDK from CDN. Zero build tooling, instant deploys, works with any static host.

4. **Client-side search** — History search filters the already-loaded `allTranscriptions` array. Works well for typical usage (hundreds of notes), but won't scale to thousands without server-side search.

5. **Real-time listener + pagination hybrid** — New docs arrive via `onSnapshot`, while older docs are loaded via paginated `get()` calls. Avoids re-fetching the entire collection on every change.

6. **User agent-based source detection** — `source` field (`mobile`/`desktop`) is detected client-side via regex on `navigator.userAgent`. No server validation.
