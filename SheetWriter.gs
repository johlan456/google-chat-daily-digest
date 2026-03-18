/**
 * SheetWriter.gs — Creates/manages the Daily Summary and Detail Log tabs.
 */

var DAILY_SUMMARY_HEADERS = ['Date', 'Total Conversations', 'Total Messages', 'Total Action Items', 'Top Topics', 'Needs Follow-up', 'Run Status'];
var DETAIL_LOG_HEADERS = ['Date', 'Space/DM', 'Space Type', 'Message Count', 'Summary', 'Topics', 'Action Items', 'Owners', 'Priority', 'Pushed to Trello'];

/**
 * Returns the active spreadsheet (container-bound).
 * @returns {Spreadsheet}
 */
function getSpreadsheet() {
  return SpreadsheetApp.getActiveSpreadsheet();
}

/**
 * Ensures both tabs exist with formatted header rows.
 * Creates them if missing; leaves existing tabs untouched.
 * @param {Spreadsheet} ss
 */
function ensureSheetStructure(ss) {
  setupTab_(ss, TAB_DAILY_SUMMARY, DAILY_SUMMARY_HEADERS, [120, 150, 130, 140, 300, 130, 100]);
  setupTab_(ss, TAB_DETAIL_LOG, DETAIL_LOG_HEADERS, [100, 200, 120, 110, 350, 200, 300, 150, 80, 120]);
}

/**
 * Creates a tab with formatted headers if it doesn't exist.
 * @private
 */
function setupTab_(ss, tabName, headers, columnWidths) {
  var sheet = ss.getSheetByName(tabName);
  if (sheet) {
    return; // Already exists
  }

  sheet = ss.insertSheet(tabName);

  // Write header row
  var headerRange = sheet.getRange(1, 1, 1, headers.length);
  headerRange.setValues([headers]);
  headerRange.setFontWeight('bold');
  headerRange.setBackground('#4285f4');
  headerRange.setFontColor('#ffffff');

  // Freeze header row
  sheet.setFrozenRows(1);

  // Set column widths
  for (var i = 0; i < columnWidths.length; i++) {
    sheet.setColumnWidth(i + 1, columnWidths[i]);
  }
}

/**
 * Writes the daily summary row (one row per day).
 * Prepends below the frozen header.
 * @param {string} date - Formatted date string
 * @param {Array<Object>} conversationResults - Array of {spaceInfo, messages, geminiResult}
 * @param {string} status - "Success", "Partial", or "Error"
 */
function writeDailySummary(date, conversationResults, status) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(TAB_DAILY_SUMMARY);
  if (!sheet) {
    ensureSheetStructure(ss);
    sheet = ss.getSheetByName(TAB_DAILY_SUMMARY);
  }

  var totalConversations = conversationResults.length;
  var totalMessages = 0;
  var totalActionItems = 0;
  var allTopics = [];
  var followUpCount = 0;
  var currentUserEmail = getAuthenticatedUserEmail();
  var currentUserName = extractFirstName(currentUserEmail);

  for (var i = 0; i < conversationResults.length; i++) {
    var result = conversationResults[i];
    totalMessages += result.messages.length;

    var gemini = result.geminiResult;
    if (gemini && gemini.action_items) {
      totalActionItems += gemini.action_items.length;

      // Count action items assigned to the current user
      for (var j = 0; j < gemini.action_items.length; j++) {
        var owner = (gemini.action_items[j].owner || '').toLowerCase();
        if (owner === currentUserName.toLowerCase() ||
            owner === currentUserEmail.toLowerCase() ||
            (currentUserEmail && owner.indexOf(currentUserEmail.split('@')[0].toLowerCase()) !== -1)) {
          followUpCount++;
        }
      }
    }

    if (gemini && gemini.topics) {
      for (var k = 0; k < gemini.topics.length; k++) {
        var topic = gemini.topics[k];
        if (allTopics.indexOf(topic) === -1) {
          allTopics.push(topic);
        }
      }
    }
  }

  // Limit top topics to 5
  var topTopics = allTopics.slice(0, 5).join(', ');

  var row = [date, totalConversations, totalMessages, totalActionItems, topTopics, followUpCount, status];

  // Insert row at position 2 (below header)
  sheet.insertRowBefore(2);
  sheet.getRange(2, 1, 1, row.length).setValues([row]);
}

/**
 * Writes detail log rows (one row per conversation).
 * Prepends below the frozen header.
 * @param {string} date - Formatted date string
 * @param {Array<Object>} conversationResults - Array of {spaceInfo, messages, geminiResult}
 */
function writeDetailLog(date, conversationResults) {
  var ss = getSpreadsheet();
  var sheet = ss.getSheetByName(TAB_DETAIL_LOG);
  if (!sheet) {
    ensureSheetStructure(ss);
    sheet = ss.getSheetByName(TAB_DETAIL_LOG);
  }

  if (conversationResults.length === 0) {
    return;
  }

  // Insert rows for all conversations at once
  sheet.insertRowsBefore(2, conversationResults.length);

  for (var i = 0; i < conversationResults.length; i++) {
    var result = conversationResults[i];
    var gemini = result.geminiResult || {};
    var spaceInfo = result.spaceInfo;

    // Format action items as newline-separated list
    var actionItemsText = '';
    var owners = [];
    var highestPriority = 'Low';
    var priorityRank = { 'High': 3, 'Medium': 2, 'Low': 1 };

    if (gemini.action_items && gemini.action_items.length > 0) {
      var items = [];
      for (var j = 0; j < gemini.action_items.length; j++) {
        var item = gemini.action_items[j];
        items.push('- ' + (item.owner || 'Unassigned') + ': ' + (item.task || ''));
        if (item.owner && item.owner !== 'Unassigned' && owners.indexOf(item.owner) === -1) {
          owners.push(item.owner);
        }
        if (item.priority && (priorityRank[item.priority] || 0) > (priorityRank[highestPriority] || 0)) {
          highestPriority = item.priority;
        }
      }
      actionItemsText = items.join('\n');
    }

    if (gemini.action_items && gemini.action_items.length === 0) {
      highestPriority = 'Low';
    }

    var topicsText = (gemini.topics || []).join(', ');

    var row = [
      date,
      spaceInfo.displayName,
      spaceInfo.spaceType,
      result.messages.length,
      gemini.summary || '',
      topicsText,
      actionItemsText,
      owners.join(', '),
      highestPriority,
      false // Checkbox default unchecked
    ];

    var rowNumber = 2 + i;
    sheet.getRange(rowNumber, 1, 1, row.length).setValues([row]);
  }

  // Add checkbox data validation to column J for the new rows
  var checkboxRange = sheet.getRange(2, 10, conversationResults.length, 1);
  var rule = SpreadsheetApp.newDataValidation()
    .requireCheckbox()
    .setAllowInvalid(false)
    .build();
  checkboxRange.setDataValidation(rule);
}
