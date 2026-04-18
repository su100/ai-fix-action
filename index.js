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
 * Build a focused diff context for the AI prompt.
 *
 * Strategy by event type:
 *
 * pull_request_review_comment:
 *   → eventData.comment already contains `path` (file) and `diff_hunk`
 *     (the exact context around the commented line).
 *     Use ONLY that hunk — passing the whole PR diff causes the AI to
 *     hallucinate changes in unrelated files.
 *
 * issue_comment:
 *   → No line anchor exists. Filter PR files to those whose filename
 *     appears in the comment body; fall back to all files if none match.
 *     Still cap at maxChars to stay within the prompt budget.
 */
/**
 * Extract the single commented line from a diff_hunk.
 *
 * GitHub places the review comment on the LAST line of the hunk, so we
 * extract that line as the suggestion target and keep a few lines above
 * as context. This prevents the AI from treating the entire hunk as
 * "things to rewrite".
 */
function extractCommentedLine(hunk) {
  if (!hunk) return { targetLine: '', context: '' };

  const lines = hunk.split('\n');

  // The commented line is always the last non-empty line in the hunk
  let lastIdx = lines.length - 1;
  while (lastIdx >= 0 && lines[lastIdx].trim() === '') lastIdx--;

  const targetRaw = lines[lastIdx] || '';
  // Strip leading +/- to get actual source code
  const targetLine = targetRaw.replace(/^[+\- ]/, '');

  // Keep up to 5 preceding lines as context (strip diff prefixes)
  const contextLines = lines
    .slice(Math.max(0, lastIdx - 5), lastIdx)
    .map((l) => l.replace(/^[+\- ]/, ''));

  return { targetLine, context: contextLines.join('\n') };
}

function buildDiffContext(files) {
  if (!files.length) return '(No changes to display)';
  const maxChars = 14000;

  // ── pull_request_review_comment: extract only the commented line ──────────
  if (eventName === 'pull_request_review_comment') {
    const hunk = eventData.comment.diff_hunk || '';
    const filePath = eventData.comment.path || '?';
    const { targetLine, context } = extractCommentedLine(hunk);

    return [
      `File: ${filePath}`,
      ``,
      `// Context (do NOT modify these lines):`,
      context,
      ``,
      `// ↓ THIS is the only line to change (the review comment was placed here):`,
      targetLine,
    ].join('\n');
  }

  // ── issue_comment: filter to files mentioned in the comment ──────────────
  const mentionedFiles = files.filter(
    (f) => f.filename && commentBody.includes(f.filename),
  );
  const targetFiles = mentionedFiles.length > 0 ? mentionedFiles : files;

  const parts = [];
  let used = 0;
  for (const f of targetFiles) {
    const filePath = f.filename || '?';
    const diff = f.patch || '(Binary or no diff)';
    const block = `File: ${filePath}\n${diff}`;
    if (used + block.length > maxChars) {
      const room = maxChars - used - 80;
      if (room > 400)
        parts.push(`${block.slice(0, room)}\n... (diff truncated)`);
      break;
    }
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
Task: Generate ONLY the replacement lines for a GitHub suggestion, based on the review comment.

[How GitHub suggestions work — critical]
- The diff context below has two sections:
    [CONTEXT]: lines already in the file. Do NOT output these.
    [LINES TO REPLACE]: the exact lines your suggestion will overwrite.
- Your output must be the corrected version of [LINES TO REPLACE] only.
- Outputting MORE lines than in [LINES TO REPLACE] creates duplicate code in the file.
- Outputting FEWER lines leaves broken/incomplete code.

[PR Diff Context]
${diffContext}

[User Instruction]
${comment}

[OUTPUT RULES]
1. Output ONLY raw source code. No explanations, no markdown fences, no +/- prefixes.
2. Keep indentation EXACTLY as in the original.
3. Do NOT output any line from [CONTEXT] — they are already present in the file.
4. Do not invent code unrelated to the instruction.`;

  const modelPath = modelName.includes('models/')
    ? modelName
    : `models/${modelName}`;
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

async function getAvailableModels() {
  const listUrl = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models?key=${GEMINI_API_KEY}`;
  try {
    const res = await fetch(listUrl);
    if (!res.ok) return [];

    const data = await res.json();

    return data.models
      .filter((m) => m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => m.name);
  } catch (e) {
    console.error('[ai-fix] Failed to fetch model list:', e.message);
    return [];
  }
}

/**
 * Main execution flow
 */
async function main() {
  if (!commentBody?.includes(AI_FIX_TRIGGER)) return;

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

  const availableModels = await getAvailableModels();
  const priorityKeywords = [
    'gemini-2.5-flash-lite',
    'gemini-1.5-flash',
    'gemini-1.5-pro',
    GEMINI_MODEL,
  ];

  const modelsToTry = [];
  for (const keyword of priorityKeywords) {
    const found = availableModels.find((m) => m.includes(keyword));
    if (found) modelsToTry.push(found);
  }
  if (modelsToTry.length === 0) modelsToTry.push(`models/${GEMINI_MODEL}`);

  let aiResult = null;
  let finalStatus = null;

  for (const model of modelsToTry) {
    console.log(`[ai-fix] Attempting fix with model: ${model}`);
    aiResult = await generateFix(diffContext, commentBody, model);

    if (aiResult === 'QUOTA_EXCEEDED') {
      finalStatus = 'QUOTA_EXCEEDED';
      console.log(
        `[ai-fix] ${model} is busy. Waiting 3 seconds before trying next model...`,
      );
      await new Promise((resolve) => setTimeout(resolve, 3000));
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
