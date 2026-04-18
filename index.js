const fs = require('fs');

const GEMINI_API_KEY = process.env.INPUT_GEMINI_API_KEY;
const GEMINI_API_VERSION = process.env.INPUT_GEMINI_API_VERSION || 'v1beta';
const GEMINI_MODEL = process.env.INPUT_GEMINI_MODEL || 'gemini-2.0-flash-lite';
const GITHUB_TOKEN = process.env.INPUT_GITHUB_TOKEN?.trim();

const repo = process.env.GITHUB_REPOSITORY;
const eventName = process.env.GITHUB_EVENT_NAME;
const eventPath = process.env.GITHUB_EVENT_PATH;

// Read and parse GitHub event details from the environment path
const eventData = JSON.parse(fs.readFileSync(eventPath, 'utf8'));

let prNumber, commentId, commentBody;

// Determine PR number and comment details based on the event type
if (eventName === 'pull_request_review_comment') {
  prNumber = eventData.pull_request.number;
  commentId = eventData.comment.id;
  commentBody = eventData.comment.body;
} else if (eventName === 'issue_comment' && eventData.issue.pull_request) {
  prNumber = eventData.issue.number;
  commentId = eventData.comment.id;
  commentBody = eventData.comment.body;
}

const AI_FIX_TRIGGER = process.env.INPUT_TRIGGER_WORD || '/ai-fix';
const MARKER_BOT = '<!-- ai-fix:bot -->';
const replyMarker = (id) => `<!-- ai-fix:reply-to:${id} -->`;
const GITHUB_API_BASE = 'https://api.github.com';

/**
 * Utility for making GitHub API requests
 */
async function githubRequest(path, options = {}) {
  const url = `${GITHUB_API_BASE}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub ${res.status} ${path}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function githubGet(path) {
  return githubRequest(path);
}

async function githubPost(path, body) {
  return githubRequest(path, { method: 'POST', body: JSON.stringify(body) });
}

/**
 * Fetch the list of files changed in the current Pull Request
 */
async function getDiff() {
  const files = await githubGet(`/repos/${repo}/pulls/${prNumber}/files`);
  return files || [];
}

/**
 * Build a text context from file diffs for the AI prompt
 */
function buildDiffContext(files) {
  if (!files.length) return '(No changes to display)';
  const maxChars = 14000;
  const parts = [];
  let used = 0;
  for (const f of files) {
    const path = f.filename || '?';
    const diff = f.patch || '(Binary or no diff)';
    const block = `File: ${path}\n${diff}`;
    if (used + block.length > maxChars) break;
    parts.push(block);
    used += block.length + 2;
  }
  return parts.join('\n\n---\n\n');
}

/**
 * Check if the bot has already replied to this specific comment
 */
async function alreadyReplied() {
  const marker = replyMarker(commentId);
  const endpoint =
    eventName === 'pull_request_review_comment'
      ? `/repos/${repo}/pulls/${prNumber}/comments`
      : `/repos/${repo}/issues/${prNumber}/comments`;
  const comments = await githubGet(`${endpoint}?per_page=100`);
  return (comments || []).some((c) => c.body && c.body.includes(marker));
}

/**
 * Post the AI-generated suggestion to the PR
 */
async function createSuggestion(suggestion) {
  if (!suggestion) return;
  const body = `\`\`\`suggestion\n${suggestion}\n\`\`\`\n${MARKER_BOT}\n${replyMarker(commentId)}`;

  if (eventName === 'pull_request_review_comment') {
    // Reply directly within the review comment thread (allows "Apply suggestion" button)
    await githubPost(`/repos/${repo}/pulls/${prNumber}/comments`, {
      body,
      in_reply_to: Number(commentId),
    });
  } else {
    // Fallback for general issue comments in PR
    await githubPost(`/repos/${repo}/issues/${prNumber}/comments`, { body });
  }
}

// --- Gemini AI Logic ---

/**
 * Request a code fix suggestion from the Gemini AI model
 */
async function generateFix(diffContext, comment, modelName = GEMINI_MODEL) {
  const prompt = `Role: Expert Software Engineer.
Task: Provide a GitHub "suggestion" block to fix the code based on the review comment.

[PR Diff Context]
${diffContext}

[User Instruction]
${comment}

[Rules]
1. Output ONLY the raw source code that will replace the targeted lines.
2. NO markdown fences, NO explanations, NO conversational text.
3. If the fix is to delete the line, return an empty string.
4. Ensure the code matches the indentation of the original file.`;

  const modelPath = modelName.includes('/') ? modelName : `models/${modelName}`;
  const geminiUrl = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/${modelPath}:generateContent`;

  try {
    const res = await fetch(geminiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': GEMINI_API_KEY,
      },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });

    if (!res.ok) {
      const errorData = await res.json();
      console.error('[ai-fix] Gemini API Error Status:', res.status);
      console.error(
        '[ai-fix] Gemini API Error Details:',
        JSON.stringify(errorData, null, 2),
      );
      if (res.status === 429) {
        return 'QUOTA_EXCEEDED';
      }
      return null;
    }

    const data = await res.json();
    console.log(
      '[ai-fix] Gemini Response Data:',
      JSON.stringify(data, null, 2),
    );

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!text) {
      console.warn('[ai-fix] No text found in Gemini response.');
      return null;
    }

    /**
     * Refined Trimming Logic:
     * 1. Remove Markdown code fences (```) and language identifiers.
     * 2. Remove only leading/trailing newlines (\n).
     * 3. Preserve spaces/tabs at the beginning of lines for correct indentation.
     */
    return text
      .replace(/^```[a-z]*\n/i, '') // Remove opening fence
      .replace(/\n```$/i, '') // Remove closing fence
      .replace(/^\r?\n+|\r?\n+$/g, ''); // Trim leading/trailing newlines only
  } catch (err) {
    console.error('[ai-fix] Gemini Error:', err.message);
    return null;
  }
}

/**
 * Main execution flow
 */
async function main() {
  // Check if the comment contains the trigger word
  if (!commentBody?.includes(AI_FIX_TRIGGER)) return;

  // Prevent duplicate replies
  if (await alreadyReplied()) return;

  if (!GEMINI_API_KEY) {
    console.error('[ai-fix] Error: GEMINI_API_KEY is missing.');
    await githubPost(`/repos/${repo}/issues/${prNumber}/comments`, {
      body: `❌ **AI Fixer Error**: Gemini API Key is not configured. Please add \`GEMINI_API_KEY\` to your repository secrets.`,
    });

    process.exit(1);
  }

  console.log(
    `[ai-fix] Triggered with "${AI_FIX_TRIGGER}". Starting for PR #${prNumber}...`,
  );

  const files = await getDiff();
  const diffContext = buildDiffContext(files);
  const modelsToTry = [
    GEMINI_MODEL,
    'models/gemini-1.5-pro',
    'models/gemini-1.5-flash',
  ];
  const uniqueModels = [...new Set(modelsToTry)];

  let aiResult = null;
  let finalStatus = null;

  for (const model of uniqueModels) {
    console.log(`[ai-fix] Attempting fix with model: ${model}`);
    aiResult = await generateFix(diffContext, commentBody, model);

    if (aiResult === 'QUOTA_EXCEEDED') {
      finalStatus = 'QUOTA_EXCEEDED';
      continue;
    } else if (aiResult !== null) {
      finalStatus = 'SUCCESS';
      break;
    }
  }

  if (finalStatus === 'SUCCESS') {
    await createSuggestion(aiResult);
    console.log('[ai-fix] Suggestion posted successfully!');
  } else if (finalStatus === 'QUOTA_EXCEEDED') {
    console.error(
      '[ai-fix] Critical Error: All attempted Gemini models reached their rate limits (429).',
    );
    await githubPost(`/repos/${repo}/issues/${prNumber}/comments`, {
      body: `⏳ **AI Fixer Notice**: All available Gemini models reached their rate limits. Please try again in a minute.`,
    });
    process.exit(1);
  } else {
    console.error(
      '[ai-fix] Critical Error: Failed to generate a fix after exhausting all models.',
    );
    await githubPost(`/repos/${repo}/issues/${prNumber}/comments`, {
      body: `⚠️ **AI Fixer Warning**: Failed to generate a fix suggestion after trying multiple models.`,
    });
    process.exit(1);
  }
}

// Start the action
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
