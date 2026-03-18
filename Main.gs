/**
 * Main.gs — Orchestration, triggers, and user-facing menu.
 */

/**
 * Creates the custom menu when the spreadsheet is opened.
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('📋 Chat Digest')
    .addItem('▶ Start Daily Digest', 'firstTimeSetup')
    .addItem('🔄 Run Now', 'manualRun')
    .addItem('⏹ Stop Daily Digest', 'removeTrigger')
    .addItem('ℹ️ Status', 'showStatus')
    .addToUi();
}

/**
 * First-time setup: validates config, creates tabs, sets trigger, runs first digest.
 * Safe to click multiple times — prevents duplicate triggers.
 */
function firstTimeSetup() {
  var ui = SpreadsheetApp.getUi();

  // Check that the Gemini API key is configured
  try {
    getGeminiApiKey();
  } catch (e) {
    ui.alert(
      'Setup Required',
      'The Gemini API key has not been configured yet.\n\n' +
      'Please ask your admin to run the setup first (adminSetup in the script editor).',
      ui.ButtonSet.OK
    );
    return;
  }

  var ss = getSpreadsheet();

  // Create tabs with formatted headers
  ensureSheetStructure(ss);

  // Set up the daily 22:00 trigger (prevent duplicates)
  setupDailyTrigger_();

  // Show progress toast
  ss.toast('Running your first chat digest now...', '📋 Chat Digest', 10);

  // Run the first digest immediately
  dailyDigest();

  ss.toast('All set! Your chat digest will run every night at 10pm.', '📋 Chat Digest', 10);
}

/**
 * Sets up the daily time-driven trigger at 22:00.
 * Removes any existing dailyDigest triggers first to prevent duplicates.
 * @private
 */
function setupDailyTrigger_() {
  // Remove existing triggers for dailyDigest
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyDigest') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }

  // Create new daily trigger at 22:00
  ScriptApp.newTrigger('dailyDigest')
    .timeBased()
    .atHour(TRIGGER_HOUR)
    .everyDays(1)
    .inTimezone(TIMEZONE)
    .create();
}

/**
 * Main digest function. Called by trigger or manually.
 * Catches all errors, writes partial results if possible, emails on failure.
 */
function dailyDigest() {
  var date = formatDateOnly(new Date());
  var conversationResults = [];
  var status = 'Success';
  var errorMessage = '';

  try {
    // Fetch chat activity
    var activity = fetchLast24hActivity();

    if (activity.length === 0) {
      // No activity — write a zero-count summary row
      writeDailySummary(date, [], 'Success');
      console.log('No chat activity in the last 24 hours.');
      return;
    }

    // Summarise each conversation
    for (var i = 0; i < activity.length; i++) {
      try {
        var conv = activity[i];
        var geminiResult = summariseConversation(conv.spaceInfo.displayName, conv.messages);
        conversationResults.push({
          spaceInfo: conv.spaceInfo,
          messages: conv.messages,
          geminiResult: geminiResult
        });
      } catch (e) {
        logError('dailyDigest.summarise(' + activity[i].spaceInfo.displayName + ')', e);
        status = 'Partial';
        // Add the conversation with an error result so we still log it
        conversationResults.push({
          spaceInfo: activity[i].spaceInfo,
          messages: activity[i].messages,
          geminiResult: {
            summary: 'Error summarising this conversation: ' + e.message,
            topics: ['error'],
            action_items: []
          }
        });
      }
    }

    // Write results to sheet
    writeDailySummary(date, conversationResults, status);
    writeDetailLog(date, conversationResults);

    console.log('Daily digest completed: ' + conversationResults.length + ' conversations, status: ' + status);

  } catch (e) {
    logError('dailyDigest', e);
    status = 'Error';
    errorMessage = e.message;

    // Try to write partial results if we have any
    try {
      if (conversationResults.length > 0) {
        writeDailySummary(date, conversationResults, 'Partial');
        writeDetailLog(date, conversationResults);
      } else {
        writeDailySummary(date, [], 'Error');
      }
    } catch (writeError) {
      logError('dailyDigest.partialWrite', writeError);
    }

    // Send failure email
    sendFailureEmail_(errorMessage);
  }
}

/**
 * Manual run — same as dailyDigest but shows a toast on completion.
 */
function manualRun() {
  var ss = getSpreadsheet();
  ss.toast('Running chat digest...', '📋 Chat Digest', 30);

  dailyDigest();

  // Count results from the most recent run
  var detailSheet = ss.getSheetByName(TAB_DETAIL_LOG);
  var summarySheet = ss.getSheetByName(TAB_DAILY_SUMMARY);
  var today = formatDateOnly(new Date());
  var message = 'Done!';

  if (summarySheet && summarySheet.getLastRow() >= 2) {
    var lastRow = summarySheet.getRange(2, 1, 1, 7).getValues()[0];
    if (lastRow[0] === today || formatDateOnly(new Date(lastRow[0])) === today) {
      message = 'Done! Found ' + lastRow[1] + ' conversations with ' + lastRow[3] + ' action items.';
    }
  }

  ss.toast(message, '📋 Chat Digest', 10);
}

/**
 * Removes all dailyDigest triggers.
 */
function removeTrigger() {
  var triggers = ScriptApp.getProjectTriggers();
  var removed = 0;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyDigest') {
      ScriptApp.deleteTrigger(triggers[i]);
      removed++;
    }
  }

  var ss = getSpreadsheet();
  if (removed > 0) {
    ss.toast('Daily digest stopped. You can restart it anytime from the menu.', '📋 Chat Digest', 5);
  } else {
    ss.toast('No active digest trigger found.', '📋 Chat Digest', 5);
  }
}

/**
 * Shows the current status: trigger state, last run info, total detail rows.
 */
function showStatus() {
  var ui = SpreadsheetApp.getUi();

  // Check trigger status
  var triggers = ScriptApp.getProjectTriggers();
  var triggerActive = false;
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'dailyDigest') {
      triggerActive = true;
      break;
    }
  }

  // Check last run
  var ss = getSpreadsheet();
  var summarySheet = ss.getSheetByName(TAB_DAILY_SUMMARY);
  var lastRunDate = 'No runs yet';
  var lastRunStatus = '-';
  if (summarySheet && summarySheet.getLastRow() >= 2) {
    var lastRow = summarySheet.getRange(2, 1, 1, 7).getValues()[0];
    lastRunDate = lastRow[0] || 'Unknown';
    lastRunStatus = lastRow[6] || '-';
  }

  // Count detail rows
  var detailSheet = ss.getSheetByName(TAB_DETAIL_LOG);
  var detailRows = detailSheet ? Math.max(0, detailSheet.getLastRow() - 1) : 0;

  // Gemini model
  var model = getGeminiModel();

  var statusMessage =
    'Daily Trigger: ' + (triggerActive ? 'Active (22:00 SAST)' : 'Inactive') + '\n' +
    'Last Run Date: ' + lastRunDate + '\n' +
    'Last Run Status: ' + lastRunStatus + '\n' +
    'Total Detail Log Entries: ' + detailRows + '\n' +
    'Gemini Model: ' + model;

  ui.alert('📋 Chat Digest Status', statusMessage, ui.ButtonSet.OK);
}

/**
 * Sends a failure notification email to the authenticated user.
 * @param {string} errorMessage
 * @private
 */
function sendFailureEmail_(errorMessage) {
  try {
    var email = getAuthenticatedUserEmail();
    if (!email) return;

    MailApp.sendEmail({
      to: email,
      subject: '⚠️ Chat Digest failed — ' + formatDateOnly(new Date()),
      body: 'Your daily chat digest encountered an error:\n\n' +
        errorMessage + '\n\n' +
        'You can try running it manually from the spreadsheet menu:\n' +
        '📋 Chat Digest → 🔄 Run Now\n\n' +
        'If the problem persists, please contact your admin.'
    });
  } catch (e) {
    logError('sendFailureEmail', e);
  }
}
