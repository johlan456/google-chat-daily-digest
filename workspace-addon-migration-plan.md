# Workspace Add-on Migration Plan

## Goal

Convert the container-bound Google Chat Daily Digest script into a Google Workspace Add-on published internally to the AW domain via the Google Workspace Marketplace. This enables self-service installation for any user in the org, centralised updates, and per-user data isolation.

---

## Current State

- Container-bound script attached to a single Google Sheet
- Manual setup per user (create Sheet, paste code, transfer ownership)
- Code updates require access to each user's Sheet
- Working: Chat API, People API, Gemini summarisation, Sheet output

---

## Architecture Changes

### Before (Container-Bound)
```
User's Sheet → embedded script → reads Chat → writes to same Sheet
```

### After (Standalone Add-on)
```
Standalone script (published) → user installs from Marketplace
  → creates a Sheet in user's Drive (first run)
  → reads Chat → writes to user's Sheet
```

---

## Code Changes Required

### 1. New standalone Apps Script project
- Create a new project at script.google.com (not attached to any Sheet)
- Link to the existing GCP project (818145269224)

### 2. Refactor Sheet access
- Replace `SpreadsheetApp.getActiveSpreadsheet()` with explicit Sheet management
- `getSpreadsheet()` becomes:
  ```javascript
  function getSpreadsheet() {
    var userProps = PropertiesService.getUserProperties();
    var sheetId = userProps.getProperty('digestSheetId');

    if (!sheetId) {
      var ss = SpreadsheetApp.create('My Chat Digest');
      sheetId = ss.getId();
      userProps.setProperty('digestSheetId', sheetId);
    }

    return SpreadsheetApp.openById(sheetId);
  }
  ```
- All `SpreadsheetApp.getUi()` calls need to account for the Sheet not being open (triggers run in background)

### 3. Update manifest (appsscript.json)
- Add `addOns` section for Sheets Editor Add-on:
  ```json
  {
    "addOns": {
      "common": {
        "name": "Chat Digest",
        "logoUrl": "https://...",
        "homepageTrigger": {
          "runFunction": "onHomepage"
        }
      },
      "sheets": {
        "homepageTrigger": {
          "runFunction": "onSheetsHomepage"
        }
      }
    }
  }
  ```
- Keep all existing OAuth scopes

### 4. Replace simple triggers with manifest-based triggers
- `onOpen()` → manifest-based menu or card UI
- `onInstall()` won't fire from Marketplace — handle initialisation in `onOpen()` or first function call

### 5. Move admin config to Script Properties (project-level)
- Gemini API key stays in Script Properties (shared across all users — set once by admin)
- Gemini model stays in Script Properties
- Per-user Sheet ID goes in User Properties

### 6. Update toast/alert handling
- Toast and alert only work when the user has the Sheet open
- For triggered runs (background), skip UI calls — use try/catch or check context
- Failure emails via MailApp remain the same

---

## Files to Modify

| File | Changes |
|------|---------|
| `appsscript.json` | Add `addOns` section, keep scopes |
| `Config.gs` | No changes (Script Properties work the same) |
| `Utilities.gs` | No changes |
| `ChatFetcher.gs` | No changes |
| `Summariser.gs` | No changes |
| `SheetWriter.gs` | Replace `getSpreadsheet()` with per-user Sheet lookup |
| `Main.gs` | Refactor menu setup, handle UI-less trigger context, add `onHomepage()` |

---

## GCP & Marketplace Configuration

### 1. Enable Marketplace SDK
- GCP Console → APIs & Services → Library → Google Workspace Marketplace SDK → Enable

### 2. Configure Marketplace SDK
- App name: Chat Digest
- Description: Daily summary of your Google Chat conversations
- Logo: 128x128 PNG
- Support URL: GitHub repo URL
- Privacy policy: can point to GitHub repo
- OAuth scopes: declare all scopes used
- Visibility: **Private** (internal to AW domain only)

### 3. Create versioned deployment
- In Apps Script editor: Deploy → New deployment → Add-on
- Use versioned deployments (not Head) for production
- Note the deployment ID for Marketplace config

### 4. OAuth consent screen
- Must be set to **Internal** (already done)
- No Google verification needed for internal apps

### 5. Publish
- Submit in Marketplace SDK — no review for internal apps, immediate availability

---

## Update Process (After Publishing)

1. Make code changes in Apps Script editor
2. Deploy → Manage deployments → select existing deployment → Edit
3. Choose latest version → Save
4. All users automatically get the update — no re-authorization needed

**Important:** Always update the existing deployment. Do NOT create a new deployment — that breaks installations.

---

## Gotchas & Limitations

- **Trigger frequency:** Add-ons can run time-driven triggers max once per hour (current script runs once daily at 22:00, so this is fine)
- **`onInstall()` doesn't fire** from Marketplace installs — handle setup in first function call
- **UI calls in background:** `SpreadsheetApp.getUi()` throws if the Sheet isn't open — wrap in try/catch for triggered runs
- **Scope changes:** If you add new scopes after publishing, users will need to re-authorize
- **Visibility is permanent:** Once set to Private, it cannot be changed to Public later (and vice versa)

---

## Testing Checklist

- [ ] Standalone script creates per-user Sheet on first run
- [ ] Sheet ID persists in User Properties across runs
- [ ] Menu appears when user opens their digest Sheet
- [ ] Triggered run works without UI context
- [ ] Gemini API key is accessible from Script Properties
- [ ] Multiple test users get separate Sheets
- [ ] Update deployment → existing users get new code
- [ ] Internal Marketplace listing visible to domain users
- [ ] Install flow: user finds in Marketplace → installs → authorizes → runs
