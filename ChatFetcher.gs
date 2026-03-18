/**
 * ChatFetcher.gs — Google Chat API via Advanced Service.
 * Uses Chat.Spaces.list() and Chat.Spaces.Messages.list() for user-auth access.
 * Resolves user IDs to display names via the People API.
 */

// In-memory cache for user ID → display name (persists for the duration of a single run)
var userNameCache_ = {};

/**
 * Resolves a Chat user ID (e.g. "users/110576037464867965962") to a display name
 * using the People API. Results are cached for the duration of the run.
 * @param {string} userId - Chat user resource name (e.g. "users/12345")
 * @returns {string} Display name or the original userId if lookup fails
 */
function resolveUserName(userId) {
  if (!userId || !userId.match(/^users\/\d+$/)) {
    return userId || 'Unknown';
  }

  // Check cache first
  if (userNameCache_[userId]) {
    return userNameCache_[userId];
  }

  try {
    // Convert "users/12345" to "people/12345" for the People API
    var peopleId = userId.replace(/^users\//, 'people/');
    var person = People.People.get(peopleId, { personFields: 'names,emailAddresses' });

    var displayName = null;
    if (person.names && person.names.length > 0) {
      displayName = person.names[0].displayName;
    }
    if (!displayName && person.emailAddresses && person.emailAddresses.length > 0) {
      displayName = person.emailAddresses[0].value.split('@')[0];
    }

    if (displayName) {
      userNameCache_[userId] = displayName;
      return displayName;
    }
  } catch (e) {
    logError('resolveUserName(' + userId + ')', e);
  }

  // Cache the failure too so we don't retry
  userNameCache_[userId] = userId;
  return userId;
}

/**
 * Resolves a display name that may contain user IDs.
 * Handles comma-separated lists like "users/123, users/456".
 * @param {string} displayName
 * @returns {string} Resolved display name
 */
function resolveDisplayName(displayName) {
  if (!displayName || displayName.indexOf('users/') === -1) {
    return displayName;
  }

  // Split on comma, resolve each part
  var parts = displayName.split(',');
  var resolved = [];
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i].trim();
    if (part.match(/^users\/\d+$/)) {
      resolved.push(resolveUserName(part));
    } else {
      resolved.push(part);
    }
  }
  return resolved.join(', ');
}

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
 * Fetches messages for a specific space after a given timestamp.
 * Handles pagination and filters to human messages only.
 * Resolves sender user IDs to display names via the People API.
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

      // Resolve sender name: use displayName if available, otherwise look up via People API
      var senderName = sender.displayName;
      if (!senderName && sender.name) {
        senderName = resolveUserName(sender.name);
      }

      messages.push({
        sender: senderName || 'Unknown',
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

    // Resolve display name — handles user IDs in DM space names
    var displayName = resolveDisplayName(space.displayName);

    // If still unresolved or empty, extract from message senders
    if (!displayName || displayName.indexOf('users/') !== -1 || displayName.indexOf('spaces/') !== -1) {
      displayName = getDmNameFromMessages_(messages);
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

/**
 * Extracts unique sender display names from messages to use as a DM label.
 * @param {Array<Object>} messages
 * @returns {string}
 * @private
 */
function getDmNameFromMessages_(messages) {
  var seen = {};
  var names = [];
  for (var i = 0; i < messages.length; i++) {
    var name = messages[i].sender;
    if (name && !seen[name] && name !== 'Unknown' && !name.match(/^users\/\d+$/)) {
      seen[name] = true;
      names.push(name);
    }
  }
  return names.length > 0 ? names.join(', ') : 'Direct Message';
}
