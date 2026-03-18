/**
 * Summariser.gs — Gemini API integration via UrlFetchApp.
 * Builds prompts, calls the API, and parses structured JSON responses.
 */

var MAX_TRANSCRIPT_CHARS = 28000;

/**
 * Formats messages into a readable transcript string.
 * @param {Array<Object>} messages - Array of {sender, text, createTime}
 * @returns {string} Formatted transcript
 */
function formatTranscript(messages) {
  var lines = [];
  for (var i = 0; i < messages.length; i++) {
    var msg = messages[i];
    var time = msg.createTime ? formatTimeOnly(new Date(msg.createTime)) : '??:??';
    var text = msg.text || '';
    lines.push(msg.sender + ' (' + time + '): ' + text);
  }
  return lines.join('\n');
}

/**
 * Extracts unique participant names from messages.
 * @param {Array<Object>} messages
 * @returns {string} Comma-separated participant list
 */
function getParticipantList(messages) {
  var seen = {};
  var names = [];
  for (var i = 0; i < messages.length; i++) {
    var name = messages[i].sender;
    if (name && !seen[name]) {
      seen[name] = true;
      names.push(name);
    }
  }
  return names.join(', ');
}

/**
 * Truncates a transcript to fit within the character limit.
 * Keeps the most recent messages when truncation is needed.
 * @param {string} transcript
 * @returns {string}
 */
function truncateTranscript(transcript) {
  if (transcript.length <= MAX_TRANSCRIPT_CHARS) {
    return transcript;
  }
  var truncated = transcript.substring(transcript.length - MAX_TRANSCRIPT_CHARS);
  // Find the first complete line
  var firstNewline = truncated.indexOf('\n');
  if (firstNewline !== -1 && firstNewline < 200) {
    truncated = truncated.substring(firstNewline + 1);
  }
  return '[...transcript truncated to most recent messages...]\n' + truncated;
}

/**
 * Builds the Gemini prompt per the plan's Prompt Design section.
 * @param {string} spaceDisplayName
 * @param {string} transcript - Formatted message transcript
 * @param {string} participantList
 * @param {string} date
 * @returns {string}
 */
function buildGeminiPrompt(spaceDisplayName, transcript, participantList, date) {
  return 'Conversation: "' + spaceDisplayName + '"\n' +
    'Participants: ' + participantList + '\n' +
    'Date: ' + date + '\n' +
    '\n' +
    '--- TRANSCRIPT ---\n' +
    transcript + '\n' +
    '--- END TRANSCRIPT ---\n' +
    '\n' +
    'Analyse this conversation and return JSON in this exact format:\n' +
    '{\n' +
    '  "summary": "2-3 sentence summary of what was discussed and any decisions made",\n' +
    '  "topics": ["topic1", "topic2", "topic3"],\n' +
    '  "action_items": [\n' +
    '    {\n' +
    '      "task": "Clear description of what needs to be done",\n' +
    '      "owner": "Person\'s name or \'Unassigned\' if unclear",\n' +
    '      "priority": "High|Medium|Low"\n' +
    '    }\n' +
    '  ]\n' +
    '}\n' +
    '\n' +
    'Rules:\n' +
    '- If no action items exist, return an empty array.\n' +
    '- "owner" must be a participant name from the transcript, or "Unassigned".\n' +
    '- "priority" is based on urgency language, deadlines mentioned, or impact.\n' +
    '- "topics" should be 1-5 concise labels, not sentences.\n' +
    '- Keep the summary factual and concise.\n' +
    '- If the conversation is trivial (greetings only, emoji reactions), return:\n' +
    '  {"summary": "Brief/trivial exchange", "topics": ["casual"], "action_items": []}';
}

var GEMINI_SYSTEM_INSTRUCTION = 'You are a workplace communication analyst. You will receive a transcript ' +
  'of a Google Chat conversation. Analyse it and return ONLY valid JSON (no markdown fences, no preamble).';

/**
 * Calls the Gemini API with the given prompt.
 * @param {string} prompt
 * @returns {Object} Parsed JSON response from Gemini
 */
function callGeminiAPI(prompt) {
  var apiKey = getGeminiApiKey();
  var endpoint = getGeminiEndpoint() + '?key=' + apiKey;

  var payload = {
    system_instruction: {
      parts: [{ text: GEMINI_SYSTEM_INSTRUCTION }]
    },
    contents: [
      {
        parts: [{ text: prompt }]
      }
    ],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 4096,
      responseMimeType: 'application/json'
    }
  };

  var options = {
    method: 'post',
    contentType: 'application/json',
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  var response = retryWithBackoff(function () {
    var resp = UrlFetchApp.fetch(endpoint, options);
    var code = resp.getResponseCode();
    if (code !== 200) {
      throw new Error('Gemini API returned HTTP ' + code + ': ' + resp.getContentText());
    }
    return resp;
  });

  var responseData = JSON.parse(response.getContentText());

  // Extract text from Gemini response
  var text = '';
  try {
    text = responseData.candidates[0].content.parts[0].text;
  } catch (e) {
    throw new Error('Unexpected Gemini response structure: ' + JSON.stringify(responseData).substring(0, 500));
  }

  return parseGeminiJson(text);
}

/**
 * Parses JSON from Gemini's response text with 3-tier fallback strategy.
 * 1. Direct JSON.parse
 * 2. Strip markdown code fences
 * 3. Extract content between first { and last }
 * @param {string} text - Raw text from Gemini
 * @returns {Object} Parsed JSON object
 */
function parseGeminiJson(text) {
  // Tier 1: Direct parse
  try {
    return JSON.parse(text);
  } catch (e) {
    // Continue to tier 2
  }

  // Tier 2: Strip markdown code fences
  try {
    var stripped = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    return JSON.parse(stripped);
  } catch (e) {
    // Continue to tier 3
  }

  // Tier 3: Extract between first { and last }
  try {
    var firstBrace = text.indexOf('{');
    var lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      var extracted = text.substring(firstBrace, lastBrace + 1);
      return JSON.parse(extracted);
    }
  } catch (e) {
    // All tiers failed
  }

  // All parsing failed
  logError('parseGeminiJson', 'Failed to parse Gemini response: ' + text.substring(0, 500));
  return {
    summary: 'Parse error — raw response: ' + text.substring(0, 300),
    topics: ['parse_error'],
    action_items: []
  };
}

/**
 * Summarises a single conversation using Gemini.
 * @param {string} spaceDisplayName
 * @param {Array<Object>} messages
 * @returns {Object} {summary, topics[], action_items[{task, owner, priority}]}
 */
function summariseConversation(spaceDisplayName, messages) {
  var transcript = formatTranscript(messages);
  transcript = truncateTranscript(transcript);
  var participantList = getParticipantList(messages);
  var date = formatDateOnly(new Date());

  var prompt = buildGeminiPrompt(spaceDisplayName, transcript, participantList, date);
  return callGeminiAPI(prompt);
}
