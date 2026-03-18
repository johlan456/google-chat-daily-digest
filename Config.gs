/**
 * Config.gs — Constants and configuration
 * Gemini API key and model are stored in Script Properties (set by admin via adminSetup()).
 */

var GEMINI_ENDPOINT_TEMPLATE = 'https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent';
var LOOKBACK_HOURS = 24;
var TIMEZONE = 'Africa/Johannesburg';
var TAB_DAILY_SUMMARY = 'Daily Summary';
var TAB_DETAIL_LOG = 'Detail Log';
var TRIGGER_HOUR = 22;

/**
 * Returns the Gemini API key from Script Properties.
 * Throws a clear error if not configured.
 */
function getGeminiApiKey() {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) {
    throw new Error('Gemini API key not configured. Admin must run adminSetup() from the script editor.');
  }
  return key;
}

/**
 * Returns the Gemini model name from Script Properties.
 * Defaults to "gemini-2.5-flash" if not set.
 */
function getGeminiModel() {
  var model = PropertiesService.getScriptProperties().getProperty('GEMINI_MODEL');
  return model || 'gemini-2.5-flash';
}

/**
 * Returns the full Gemini endpoint URL with the model name substituted.
 */
function getGeminiEndpoint() {
  return GEMINI_ENDPOINT_TEMPLATE.replace('{model}', getGeminiModel());
}

/**
 * Admin-only setup function. Run from the script editor to configure
 * the Gemini API key and model name in Script Properties.
 * Can be re-run to update either value.
 */
function adminSetup() {
  var ui = SpreadsheetApp.getUi();
  var props = PropertiesService.getScriptProperties();

  // Step 1: Prompt for API key
  var currentKey = props.getProperty('GEMINI_API_KEY');
  var keyPrompt = currentKey
    ? 'A Gemini API key is already set. Enter a new key to replace it, or click Cancel to keep the current one.'
    : 'Enter your Gemini API key (from GCP console):';

  var keyResponse = ui.prompt('Gemini API Key', keyPrompt, ui.ButtonSet.OK_CANCEL);
  if (keyResponse.getSelectedButton() === ui.Button.OK && keyResponse.getResponseText().trim()) {
    props.setProperty('GEMINI_API_KEY', keyResponse.getResponseText().trim());
  }

  // Step 2: Prompt for model name
  var currentModel = getGeminiModel();
  var modelResponse = ui.prompt(
    'Gemini Model',
    'Enter the Gemini model name.\nCurrent/default: ' + currentModel,
    ui.ButtonSet.OK_CANCEL
  );
  if (modelResponse.getSelectedButton() === ui.Button.OK && modelResponse.getResponseText().trim()) {
    props.setProperty('GEMINI_MODEL', modelResponse.getResponseText().trim());
  }

  // Confirmation
  var storedKey = props.getProperty('GEMINI_API_KEY');
  var maskedKey = storedKey ? storedKey.substring(0, 4) + '...' + storedKey.substring(storedKey.length - 4) : '(not set)';
  ui.alert(
    'Setup Complete',
    'Gemini API Key: ' + maskedKey + '\nGemini Model: ' + getGeminiModel(),
    ui.ButtonSet.OK
  );
}
