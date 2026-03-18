/**
 * ChatFetcher.gs — Google Chat API via Advanced Service.
 * Uses Chat.Spaces.list() and Chat.Spaces.Messages.list() for user-auth access.
 */

/**
 * Lists all spaces the authenticated user is a member of.
 * Handles pagination automatically.
 * @returns {Array<Object>} Array of {spaceName, displayName, spaceType}
 */
function getActiveSpaces() {
  var spaces = [];
  var pageToken = null;

  do {
    var params = { pageSize: 100 };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    var response = Chat.Spaces.list(params);
    var spaceList = response.spaces || [];

    for (var i = 0; i < spaceList.length; i++) {
      var space = spaceList[i];
      spaces.push({
        spaceName: space.name,
        displayName: space.displayName || '',
        spaceType: space.spaceType || space.type || 'UNKNOWN'
      });
    }

    pageToken = response.nextPageToken;
    if (pageToken) {
      Utilities.sleep(100);
    }
  } while (pageToken);

  return spaces;
}

/**
 * Resolves a display name for DM spaces that have no displayName.
 * Queries the space members and returns the other participant's name.
 * @param {string} spaceName - e.g. "spaces/AAAA..."
 * @returns {string} Display name or email of the DM partner
 */
function resolveDmDisplayName(spaceName) {
  try {
    var response = Chat.Spaces.Members.list(spaceName, { pageSize: 10 });
    var members = response.memberships || [];
    var currentUserEmail = getAuthenticatedUserEmail();
    var names = [];

    for (var i = 0; i < members.length; i++) {
      var member = members[i].member;
      if (member && member.type === 'HUMAN') {
        var memberName = member.displayName || member.name || '';
        // Skip the current user in DMs to show the other person's name
        if (currentUserEmail && member.email && member.email === currentUserEmail) {
          continue;
        }
        if (memberName) {
          names.push(memberName);
        }
      }
    }

    return names.length > 0 ? names.join(', ') : 'Direct Message';
  } catch (e) {
    logError('resolveDmDisplayName', e);
    return 'Direct Message';
  }
}

/**
 * Fetches messages for a specific space after a given timestamp.
 * Handles pagination and filters to human messages only.
 * @param {string} spaceName - The space resource name
 * @param {string} afterTimestamp - ISO 8601 timestamp for the filter
 * @returns {Array<Object>} Array of {sender, senderEmail, text, createTime}
 */
function getMessagesForSpace(spaceName, afterTimestamp) {
  var messages = [];
  var pageToken = null;
  var filter = 'createTime > "' + afterTimestamp + '"';

  do {
    var params = {
      pageSize: 100,
      filter: filter,
      orderBy: 'createTime asc'
    };
    if (pageToken) {
      params.pageToken = pageToken;
    }

    var response;
    try {
      response = Chat.Spaces.Messages.list(spaceName, params);
    } catch (e) {
      logError('getMessagesForSpace(' + spaceName + ')', e);
      break;
    }

    var messageList = response.messages || [];

    for (var i = 0; i < messageList.length; i++) {
      var msg = messageList[i];
      var sender = msg.sender || {};

      // Skip bot/app messages — only include human senders
      if (sender.type && sender.type !== 'HUMAN') {
        continue;
      }

      messages.push({
        sender: sender.displayName || sender.name || 'Unknown',
        senderEmail: sender.email || '',
        text: msg.text || msg.formattedText || '',
        createTime: msg.createTime
      });
    }

    pageToken = response.nextPageToken;
    if (pageToken) {
      Utilities.sleep(100);
    }
  } while (pageToken);

  return messages;
}

/**
 * Fetches all chat activity from the last 24 hours across all spaces.
 * @returns {Array<Object>} Array of {spaceInfo, messages} for spaces with activity
 */
function fetchLast24hActivity() {
  var now = new Date();
  var cutoff = new Date(now.getTime() - LOOKBACK_HOURS * 60 * 60 * 1000);
  var cutoffIso = cutoff.toISOString();

  console.log('Fetching chat activity since: ' + cutoffIso);

  var spaces = getActiveSpaces();
  console.log('Found ' + spaces.length + ' spaces');

  var results = [];

  for (var i = 0; i < spaces.length; i++) {
    var space = spaces[i];
    var messages = getMessagesForSpace(space.spaceName, cutoffIso);

    if (messages.length === 0) {
      continue;
    }

    // Resolve display name for DMs with empty displayName
    var displayName = space.displayName;
    if (!displayName && (space.spaceType === 'DIRECT_MESSAGE' || space.spaceType === 'DM')) {
      displayName = resolveDmDisplayName(space.spaceName);
    }
    if (!displayName) {
      displayName = space.spaceName;
    }

    results.push({
      spaceInfo: {
        spaceName: space.spaceName,
        displayName: displayName,
        spaceType: space.spaceType
      },
      messages: messages
    });

    console.log('  ' + displayName + ': ' + messages.length + ' messages');
  }

  console.log('Total active spaces: ' + results.length);
  return results;
}
