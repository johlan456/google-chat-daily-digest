# Google Chat Daily Digest — Implementation Plan

## Project Overview

Build a Google Apps Script project that runs daily at 22:00 SAST, exports the authenticated user's Google Chat activity for the past 24 hours, summarises it using the Gemini API, and writes structured output to a Google Sheet.

**Target user:** Single Workspace user (non-technical), not a team-wide tool.
**Purpose:** Morning review ritual — scan yesterday's conversations, catch dropped balls, identify follow-ups.
**Deployment model:** Container-bound script (embedded in a Google Sheet). The admin (Johlan) builds and configures everything. The end user just opens the Sheet, clicks a menu button, and approves OAuth once.

---

## Architecture

```
[Time-driven trigger @ 22:00 SAST]
        │
        ▼
[Apps Script: fetchChatActivity()]
        │
        ├── Google Chat API (Advanced Service)
        │     ├── List spaces (spaces.list)
        │     ├── For each space with recent activity:
        │     │     └── List messages (spaces.messages.list)
        │     └── Filter to last 24h window
        │
        ▼
[Apps Script: summariseWithGemini()]
        │
        ├── Batch messages per space/DM
        ├── Call Gemini API (UrlFetchApp → generativelanguage.googleapis.com)
        │     └── Prompt: extract topics, action items, owners
        │
        ▼
[Apps Script: writeToSheet()]
        │
        ├── "Daily Summary" tab — one row per day (dashboard view)
        └── "Detail Log" tab — one row per conversation (searchable history)
```

---

## Prerequisites (admin setup — user never sees this)

1. **GCP Project** — Already linked to Apps Script environment.
2. **Enable APIs** in the GCP project console (APIs & Services → Library):
   - `Google Chat API`
   - `Generative Language API` (for Gemini)
3. **OAuth Consent Screen** — Must be set to **Internal** (Workspace domain only) in the GCP console. This prevents the "unverified app" warning for the end user.
4. **Gemini API Key** — Generate in the GCP console under "Generative Language API" credentials. The admin stores this securely via `PropertiesService.getScriptProperties()` by running a one-time `adminSetup()` function, then deletes the key from the source code. The user never sees the key.
5. **Google Sheet** — Admin creates a new Sheet, opens Extensions → Apps Script, and writes the code there. The script is **container-bound** to this Sheet (no separate Script ID, no Script Properties for the user to configure).
6. **Apps Script Advanced Services** — In the bound script editor, go to Services (+) and add:
   - `Chat API` (version v1)
7. **OAuth Scopes** — The script's `appsscript.json` must declare:
   ```json
   {
     "timeZone": "Africa/Johannesburg",
     "dependencies": {
       "enabledAdvancedServices": [
         {
           "userSymbol": "Chat",
           "version": "v1",
           "serviceId": "chat"
         }
       ]
     },
     "oauthScopes": [
       "https://www.googleapis.com/auth/chat.spaces.readonly",
       "https://www.googleapis.com/auth/chat.messages.readonly",
       "https://www.googleapis.com/auth/spreadsheets",
       "https://www.googleapis.com/auth/script.external_request"
     ],
     "exceptionLogging": "STACKDRIVER"
   }
   ```

---

## Sheet Structure

### Tab 1: "Daily Summary" (morning dashboard)

| Column | Description | Example |
|--------|-------------|---------|
| A: Date | Run date | 2026-03-18 |
| B: Total Conversations | Count of spaces/DMs with activity | 12 |
| C: Total Messages | Messages across all conversations | 87 |
| D: Total Action Items | Sum of extracted action items | 5 |
| E: Top Topics | Comma-separated top 3-5 topics | Mendix deploy, VPN issue, Q2 planning |
| F: Needs Follow-up | Count of action items assigned to you | 3 |
| G: Run Status | Success / Partial / Error | Success |

New rows prepend at the top (most recent first) below the header row.

### Tab 2: "Detail Log" (searchable history)

| Column | Description | Example |
|--------|-------------|---------|
| A: Date | Run date | 2026-03-18 |
| B: Space/DM | Space display name or DM contact | #infrastructure / John Smith |
| C: Space Type | SPACE / DIRECT_MESSAGE / GROUP_CHAT | SPACE |
| D: Message Count | Messages in this conversation today | 14 |
| E: Summary | 2-3 sentence Gemini summary of the conversation | Discussed Mendix deployment failure on staging... |
| F: Topics | Comma-separated topics | Mendix, staging, rollback |
| G: Action Items | Newline-separated action items | - Johlan: Check m2ee logs\n- Pieter: Update Ansible playbook |
| H: Owners | Comma-separated unique assignees | Johlan, Pieter |
| I: Priority | High / Medium / Low (Gemini-assessed) | High |
| J: Pushed to Trello | Checkbox (manual for now, automated later) | ☐ |

New rows prepend at the top below the header row.

---

## Code Structure

Single Apps Script project with these files:

### 1. `Config.gs` — Constants and configuration

```
- GEMINI_API_KEY: retrieved at runtime via PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY')
- GEMINI_MODEL: retrieved at runtime via PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL')
  (defaults to "gemini-2.5-flash" if not set)
  Both are set by admin using adminSetup(), never visible in source code.
- GEMINI_ENDPOINT: "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
- LOOKBACK_HOURS: 24
- TIMEZONE: "Africa/Johannesburg"
- TAB_DAILY_SUMMARY: "Daily Summary"
- TAB_DETAIL_LOG: "Detail Log"

function getGeminiApiKey()
  - Reads key from Script Properties
  - Throws a clear error if not set ("Gemini API key not configured. Admin must run adminSetup().")

function getGeminiModel()
  - Reads model from Script Properties
  - Returns "gemini-2.0-flash" as default if not set

function adminSetup()
  - One-time function run by the admin from the script editor
  - Step 1: Prompts for the Gemini API key via SpreadsheetApp.getUi().prompt()
  - Step 2: Prompts for the Gemini model name, pre-filled with current value or default "gemini-2.0-flash"
  - Stores both in Script Properties via PropertiesService.getScriptProperties().setProperties()
  - Shows confirmation alert with the stored values (key masked, model shown in full)
  - Can be re-run anytime to update either value (e.g. to switch models)
  - IMPORTANT: The key and model are only stored server-side in Script Properties,
    not in the source. Even if the user opens the script editor, nothing sensitive is visible.

Note: No SHEET_ID needed — the script is container-bound, so it uses
SpreadsheetApp.getActiveSpreadsheet() to reference its own Sheet.
```

### 2. `ChatFetcher.gs` — Google Chat API interactions

```
function getActiveSpaces()
  - Call Chat.Spaces.list() with filter for spaces the user is a member of
  - Return array of {spaceName, displayName, spaceType}
  - Handle pagination (pageToken)

function getMessagesForSpace(spaceName, afterTimestamp)
  - Call Chat.Spaces.Messages.list(spaceName, {filter, pageSize, ...})
  - Filter: createTime > afterTimestamp
  - Handle pagination
  - Return array of {sender, text, createTime, annotations}
  - Skip messages from bots/apps (filter by sender.type === 'HUMAN')

function fetchLast24hActivity()
  - Calculate cutoff timestamp (now - 24h)
  - Get all spaces
  - For each space, fetch messages after cutoff
  - Skip spaces with 0 messages in the window
  - Return Map<spaceName, {spaceInfo, messages[]}>
```

**Important Chat API notes:**
- The Chat API Advanced Service in Apps Script uses `Chat.Spaces.list()` and `Chat.Spaces.Messages.list()` syntax.
- Message filter format: `createTime > "2026-03-17T20:00:00Z"`
- The user must have already interacted with the Chat app or the API must use user authentication (which Apps Script handles via OAuth).
- Rate limits: 60 requests/minute per user. Add `Utilities.sleep(100)` between paginated calls if needed.
- DM spaces may have `displayName` as empty — fall back to listing member names.

### 3. `Summariser.gs` — Gemini API integration

```
function summariseConversation(spaceDisplayName, messages[])
  - Format messages as a transcript: "Sender (HH:MM): message text"
  - Call Gemini API via UrlFetchApp.fetch()
  - Return structured JSON: {summary, topics[], actionItems[{task, owner, priority}]}

function buildGeminiPrompt(spaceDisplayName, transcript)
  - See Prompt Design section below

function callGeminiAPI(prompt)
  - POST to GEMINI_ENDPOINT with API key
  - Parse response, extract text content
  - Parse the JSON from Gemini's response (with fallback/retry on malformed JSON)
  - Handle errors gracefully (quota, timeout, malformed response)
```

### 4. `SheetWriter.gs` — Google Sheets output

```
function ensureSheetStructure(spreadsheet)
  - Create tabs if they don't exist
  - Set up header rows with formatting (bold, frozen row)
  - Set column widths for readability

function writeDailySummary(date, conversationResults[])
  - Aggregate: total conversations, messages, action items, top topics
  - Count action items assigned to the authenticated user
  - Insert row at position 2 (below header)

function writeDetailLog(date, conversationResults[])
  - One row per conversation
  - Insert rows at position 2 (below header)
  - Add data validation for "Pushed to Trello" column (checkbox)

function getSpreadsheet()
  - Return SpreadsheetApp.getActiveSpreadsheet() (container-bound, always available)
```

### 5. `Main.gs` — Orchestration, trigger, and user-facing menu

```
function onOpen()
  - Creates custom menu in the Sheet toolbar: "📋 Chat Digest"
    - "▶ Start Daily Digest" → firstTimeSetup()
    - "🔄 Run Now" → manualRun()
    - "⏹ Stop Daily Digest" → removeTrigger()
    - "ℹ️ Status" → showStatus()

function firstTimeSetup()
  - Called once by the user via the menu
  - This is the moment OAuth consent fires (first time the user triggers a Chat API call)
  - Creates the "Daily Summary" and "Detail Log" tabs with headers
  - Sets up the daily 22:00 SAST time-driven trigger
  - Runs the first digest immediately so the user sees results right away
  - Shows a friendly toast/alert: "All set! Your chat digest will run every night at 10pm."

function dailyDigest()
  - Main entry point (triggered function)
  - Call fetchLast24hActivity()
  - For each space with messages, call summariseConversation()
  - Call writeDailySummary() and writeDetailLog()
  - Log run status and timing
  - On error: send email notification to the user via MailApp.sendEmail()

function manualRun()
  - Same as dailyDigest() but shows a toast on completion
  - "Done! Found X conversations with Y action items."

function removeTrigger()
  - Delete existing dailyDigest triggers
  - Show toast: "Daily digest stopped."

function showStatus()
  - Show alert with: trigger status (active/inactive), last run date,
    total rows in Detail Log
  - Helps the user confirm it's working without opening the script editor

function testSingleSpace()
  - Fetch and summarise a single space (for admin development only)
```

**User experience flow:**
1. User opens the Sheet (shared by Johlan)
2. Sees "📋 Chat Digest" in the menu bar
3. Clicks "▶ Start Daily Digest"
4. Google shows the OAuth consent popup → user clicks "Allow"
5. Script creates tabs, runs first digest, sets up nightly trigger
6. User sees toast: "All set!"
7. From now on, data appears every morning automatically
8. User can click "🔄 Run Now" anytime for an ad-hoc refresh

### 6. `Utilities.gs` — Helpers

```
function formatTimestamp(date)
function getAuthenticatedUserEmail()
function logError(context, error)
function retryWithBackoff(fn, maxRetries)
```

---

## Gemini Prompt Design

This is critical for quality output. The prompt must produce consistently parseable JSON.

```
SYSTEM: You are a workplace communication analyst. You will receive a transcript
of a Google Chat conversation. Analyse it and return ONLY valid JSON (no markdown
fences, no preamble).

USER:
Conversation: "{spaceDisplayName}"
Participants: {participantList}
Date: {date}

--- TRANSCRIPT ---
{formattedTranscript}
--- END TRANSCRIPT ---

Analyse this conversation and return JSON in this exact format:
{
  "summary": "2-3 sentence summary of what was discussed and any decisions made",
  "topics": ["topic1", "topic2", "topic3"],
  "action_items": [
    {
      "task": "Clear description of what needs to be done",
      "owner": "Person's name or 'Unassigned' if unclear",
      "priority": "High|Medium|Low"
    }
  ]
}

Rules:
- If no action items exist, return an empty array.
- "owner" must be a participant name from the transcript, or "Unassigned".
- "priority" is based on urgency language, deadlines mentioned, or impact.
- "topics" should be 1-5 concise labels, not sentences.
- Keep the summary factual and concise.
- If the conversation is trivial (greetings only, emoji reactions), return:
  {"summary": "Brief/trivial exchange", "topics": ["casual"], "action_items": []}
```

**Parsing strategy:**
1. Try `JSON.parse()` on the Gemini response text directly.
2. If that fails, try stripping markdown code fences (```json ... ```).
3. If that fails, try extracting content between first `{` and last `}`.
4. If all fail, log the raw response and write "Parse error" to the sheet for that conversation.

---

## Error Handling & Edge Cases

| Scenario | Handling |
|----------|----------|
| No messages in 24h window | Write summary row with 0 counts, skip detail log |
| Gemini rate limit / quota | Retry with exponential backoff (max 3 retries), then log error |
| Gemini returns unparseable JSON | Fallback: write raw summary text, mark as "Parse Error" |
| Chat API pagination | Loop with pageToken until exhausted |
| DM with no displayName | Query space members, use their names as displayName |
| Very long conversation (>30k chars) | Truncate to most recent messages that fit ~28k chars (Gemini Flash context) |
| Apps Script 6-min execution limit | Process spaces in batches; if nearing limit, write partial results and log |
| Space the user can see but has 0 own messages | Still include — user may need to know what was discussed even if they only read |

---

## Execution Time Budget

Apps Script has a 6-minute execution limit. Estimated breakdown:

| Step | Estimated Time |
|------|---------------|
| List spaces | 1-2s |
| Fetch messages (15 active spaces × 2 pages avg) | 15-30s |
| Gemini summarisation (15 spaces × 2-3s each) | 30-45s |
| Sheet writes | 2-5s |
| **Total** | **~1-1.5 min** |

This gives plenty of headroom. If the user is in 50+ active spaces, we may need to batch or parallelise (UrlFetchApp.fetchAll for Gemini calls).

---

## Future: Trello Integration Hooks

The intended workflow is **audit-first**: the user reviews the Detail Log each morning and only selectively pushes items to Trello when they involve delegation or multi-person follow-up. Most action items will just be noted and handled directly — Trello is reserved for things that need tracking with others.

1. **"Pushed to Trello" column** (J) in Detail Log — manual checkbox. The user ticks this *after* deciding an item warrants a Trello card, not as a default.
2. **Action items are structured** with task, owner, priority — maps directly to Trello card fields when needed.
3. **Future `TrelloSync.gs`** would:
   - Be triggered manually (e.g. a custom menu button "Sync checked items to Trello"), **not** automatically.
   - Read Detail Log rows where "Pushed to Trello" is checked but no Trello URL exists yet in column K.
   - Create Trello cards via REST API (UrlFetchApp) for only those rows.
   - Write the Trello card URL to column K as confirmation.
   - This keeps the user in control — the sheet is the source of truth, Trello is the delegation tool.

---

## Deployment Model

**Approach:** Container-bound script (script lives inside the Google Sheet). The admin (Johlan) does all technical setup. The end user (non-technical colleague) only interacts with the Sheet via a custom menu.

### Phase 1: Build & Test (Johlan)

1. Create a new Google Sheet. Name it something friendly, e.g. "My Chat Digest".
2. Open Extensions → Apps Script. This creates a container-bound script.
3. In the script editor Project Settings:
   - Set the GCP project number.
   - Check "Show `appsscript.json` manifest file in editor".
4. Replace `appsscript.json` with the manifest from Prerequisites above.
5. Add the Advanced Service: Services (+) → Google Chat API → v1 → Add.
6. Write all `.gs` files (Config, ChatFetcher, Summariser, SheetWriter, Main, Utilities).
7. Run `adminSetup()` from the script editor — this prompts for the Gemini API key and stores it securely in Script Properties. The key is now server-side, not in the code.
8. Run `manualRun()` from the script editor to test against your own chat data.
9. Verify both Sheet tabs populate correctly.
10. Delete your test data rows and the test tabs (the user's `firstTimeSetup()` will recreate them cleanly).

### Phase 2: Hand Off to End User (Colleague)

1. **Transfer ownership** of the Sheet to the colleague (Share → make them Owner), or create it directly in a shared location they can access.
2. **Briefing for the colleague** (keep it this simple):
   - "Open the 'My Chat Digest' spreadsheet."
   - "You'll see a menu at the top called '📋 Chat Digest' — if you don't see it, close and reopen the Sheet."
   - "Click '▶ Start Daily Digest'."
   - "Google will ask for permission to read your chats — click 'Allow'."
   - "That's it. Every morning you'll see a summary of yesterday's chats."
3. **What happens behind the scenes** when they click Start:
   - OAuth consent fires (one-time).
   - `firstTimeSetup()` creates the tabs, sets up the 22:00 trigger, and runs the first digest.
   - User sees a toast confirmation.

### Important Notes

- The GCP project must have the OAuth consent screen set to **Internal** (Workspace domain only). This means the colleague sees a clean consent screen, not the scary "unverified app" warning.
- The Gemini API key is stored in **Script Properties** (server-side), not in the source code. Even if the colleague opens the script editor, the key is not visible in any `.gs` file. Only someone with script editor access who knows to check Project Settings → Script Properties could find it — and the colleague has no reason to go there.
- The time-driven trigger runs as the **colleague's account** (the person who clicked "Start"), so Chat API returns their data. Johlan does not have access to the colleague's chat data.
- If the colleague ever needs to stop it: menu → "⏹ Stop Daily Digest". To restart: "▶ Start Daily Digest" again.
- If you want to roll this out to more users later, make a copy of the Sheet for each user. Each copy is independent.

---

## Testing Checklist

### Admin testing (Johlan — in script editor)
- [ ] `manualRun()` executes without errors
- [ ] OAuth consent prompts for correct scopes
- [ ] Spaces list returns expected spaces (both rooms and DMs)
- [ ] Messages filter correctly to 24h window
- [ ] Gemini returns valid JSON for a real conversation
- [ ] Gemini handles trivial/empty conversations gracefully
- [ ] Daily Summary tab populates with correct aggregated data
- [ ] Detail Log tab populates with per-conversation rows
- [ ] "Pushed to Trello" column renders as checkboxes
- [ ] Handles spaces with no displayName (DMs)
- [ ] Handles very long conversations (truncation)
- [ ] Error rows don't break subsequent runs

### User-facing testing (simulate the colleague's experience)
- [ ] "📋 Chat Digest" menu appears on Sheet open
- [ ] "▶ Start Daily Digest" triggers OAuth consent on first run
- [ ] After OAuth, tabs are created and first digest runs
- [ ] Toast confirmation appears: "All set!"
- [ ] "🔄 Run Now" works for ad-hoc refresh
- [ ] "ℹ️ Status" shows correct trigger state and last run info
- [ ] "⏹ Stop Daily Digest" removes the trigger cleanly
- [ ] Re-clicking "▶ Start Daily Digest" after stopping works (no duplicate triggers)
- [ ] Trigger fires at 22:00 SAST next day
- [ ] Failure email notification sends if digest errors out

---

## Deployment Notes

- The script is **container-bound** — it lives inside the Sheet, not as a standalone project. The user never needs to open the Apps Script editor.
- The time-driven trigger runs as the **user who clicked "Start Daily Digest"**, so Chat API returns their data only. The admin cannot see the user's chats.
- Gemini 2.5 Flash is free-tier — monitor usage at console.cloud.google.com if you're concerned about quotas. At ~15-30 API calls per daily run, this is well within the 250-500 RPD free limit. If Google tightens limits further, you can switch to `gemini-2.5-flash-lite` (1,000 RPD) via `adminSetup()` without touching code.
- The daily trigger uses Apps Script's built-in scheduler. On failure, the script sends an email to the user via `MailApp.sendEmail()`.
- The `onOpen()` menu only appears when the Sheet is opened (or refreshed). If the user doesn't see it, tell them to reload the page.
- For rolling out to additional team members: make a copy of the Sheet (File → Make a copy). Each copy is fully independent — own data, own trigger, own OAuth authorisation.
