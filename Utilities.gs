/**
 * Utilities.gs — Helpers: timestamp formatting, authenticated user, error logging, retry.
 */

/**
 * Formats a Date object to a readable string in the configured timezone.
 * @param {Date} date
 * @param {string} [format] - SimpleDateFormat pattern. Default: 'yyyy-MM-dd HH:mm'
 * @returns {string}
 */
function formatTimestamp(date, format) {
  format = format || 'yyyy-MM-dd HH:mm';
  return Utilities.formatDate(date, TIMEZONE, format);
}

/**
 * Formats a Date object to date-only string (yyyy-MM-dd).
 * @param {Date} date
 * @returns {string}
 */
function formatDateOnly(date) {
  return Utilities.formatDate(date, TIMEZONE, 'yyyy-MM-dd');
}

/**
 * Formats a Date object to time-only string (HH:mm).
 * @param {Date} date
 * @returns {string}
 */
function formatTimeOnly(date) {
  return Utilities.formatDate(date, TIMEZONE, 'HH:mm');
}

/**
 * Returns the email address of the currently authenticated user.
 * @returns {string}
 */
function getAuthenticatedUserEmail() {
  return Session.getActiveUser().getEmail();
}

/**
 * Logs an error with context information.
 * @param {string} context - Where the error occurred
 * @param {Error|string} error - The error object or message
 */
function logError(context, error) {
  var message = error instanceof Error ? error.message + '\n' + error.stack : String(error);
  console.error('[' + context + '] ' + message);
}

/**
 * Retries a function with exponential backoff.
 * @param {Function} fn - The function to execute
 * @param {number} [maxRetries=3] - Maximum number of retries
 * @param {number} [initialDelayMs=1000] - Initial delay in milliseconds
 * @returns {*} The return value of fn
 */
function retryWithBackoff(fn, maxRetries, initialDelayMs) {
  maxRetries = maxRetries || 3;
  initialDelayMs = initialDelayMs || 1000;
  var lastError;

  for (var attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return fn();
    } catch (e) {
      lastError = e;
      logError('retryWithBackoff (attempt ' + (attempt + 1) + '/' + (maxRetries + 1) + ')', e);
      if (attempt < maxRetries) {
        var delay = initialDelayMs * Math.pow(2, attempt);
        Utilities.sleep(delay);
      }
    }
  }
  throw lastError;
}

/**
 * Extracts the first name from an email or display name for friendlier output.
 * @param {string} nameOrEmail
 * @returns {string}
 */
function extractFirstName(nameOrEmail) {
  if (!nameOrEmail) return 'Unknown';
  if (nameOrEmail.indexOf('@') !== -1) {
    return nameOrEmail.split('@')[0];
  }
  return nameOrEmail.split(' ')[0];
}
