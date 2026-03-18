# Google Chat Daily Digest

A container-bound Google Apps Script that exports a user's daily Google Chat activity into a Google Sheet with AI-generated summaries using the Gemini API.

## What It Does

- Runs daily at 22:00 SAST (configurable) via a time-driven trigger
- Fetches all Google Chat conversations from the last 24 hours
- Summarises each conversation using Gemini, extracting topics, action items, and owners
- Writes results to two Sheet tabs:
  - **Daily Summary** — one row per day with aggregate stats
  - **Detail Log** — one row per conversation with summaries, topics, action items, and priority

## Setup

### Prerequisites

1. A Google Workspace account
2. A GCP project with these APIs enabled:
   - Google Chat API
   - Generative Language API (Gemini)
3. OAuth consent screen set to **Internal** (Workspace domain)
4. A Gemini API key from the GCP console

### Installation

1. Create a new Google Sheet
2. Open **Extensions → Apps Script**
3. In Project Settings:
   - Set your GCP project number
   - Check "Show `appsscript.json` manifest file in editor"
4. Replace `appsscript.json` with the manifest from this repo
5. Add the Advanced Service: **Services (+) → Google Chat API → v1 → Add**
6. Create each `.gs` file and paste the code from this repo
7. Delete the default `Code.gs` if empty
8. Set Script Properties (Project Settings → Script Properties):
   - `GEMINI_API_KEY` → your Gemini API key
   - `GEMINI_MODEL` → `gemini-2.5-flash` (optional, this is the default)

Alternatively, run `adminSetup()` from the script editor to set the API key and model interactively.

### End User Setup

1. Share the Sheet with the user (Editor access)
2. They open the Sheet, click **📋 Chat Digest → ▶ Start Daily Digest**
3. Approve OAuth permissions when prompted
4. Done — digests run automatically every night

## File Structure

| File | Purpose |
|------|---------|
| `appsscript.json` | Manifest with scopes, timezone, and advanced services |
| `Config.gs` | Constants, Gemini key/model helpers, admin setup |
| `Utilities.gs` | Timestamp formatting, error logging, retry with backoff |
| `ChatFetcher.gs` | Google Chat API via Advanced Service with pagination |
| `Summariser.gs` | Gemini API integration with 3-tier JSON parsing fallback |
| `SheetWriter.gs` | Sheet tab creation, header formatting, data writing |
| `Main.gs` | Custom menu, triggers, orchestration, error handling |

## Menu Options

- **▶ Start Daily Digest** — First-time setup: creates tabs, sets trigger, runs first digest
- **🔄 Run Now** — Ad-hoc refresh
- **⏹ Stop Daily Digest** — Removes the nightly trigger
- **ℹ️ Status** — Shows trigger state, last run, and entry count

## Security

- The Gemini API key is stored server-side in Script Properties, never in source code
- The time-driven trigger runs under the end user's account — their chat data is only accessible to them
- OAuth scopes are limited to read-only Chat access and Sheets write access

## License

MIT
