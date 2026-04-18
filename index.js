const fs = require('fs');

const GEMINI_API_KEY = process.env.INPUT_GEMINI_API_KEY;
const GEMINI_API_VERSION = process.env.INPUT_GEMINI_API_VERSION || 'v1beta';
const GEMINI_MODEL = process.env.INPUT_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const GITHUB_TOKEN = process.env.INPUT_GITHUB_TOKEN?.trim();

const repo = process.env.GITHUB_REPOSITORY;
const eventName = process.env.GITHUB_EVENT_NAME;
const eventData = JSON.parse(
  fs.readFileSync(process.env.GITHUB_EVENT_PATH, 'utf8'),
);

let prNumber, commentId, commentBody, commentPath, commentDiffHunk;

if (eventName === 'pull_request_review_comment') {
  prNumber = eventData.pull_request.number;
  commentId = eventData.comment.id;
  commentBody = eventData.comment.body;
  commentPath = eventData.comment.path;
  commentDiffHunk = eventData.comment.diff_hunk;
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
 * Utility
 */

function trimOuterNewlines(s) {
  if (s == null || typeof s !== 'string') return '';
  return s.replace(/^\r?\n+/, '').replace(/\r?\n+$/, '');
}

function truncateForLog(s, maxLen = 8000) {
  if (s == null) return '';
  const t = String(s);
  return t.length <= maxLen
    ? t
    : `${t.slice(0, maxLen)}…(truncated, ${t.length} chars)`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── GitHub API ──────────────────────────────────────────────────────────────

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

// ─── diff context 빌드 ───────────────────────────────────────────────────────

/**
 * pull_request_review_comment:
 *   diff_hunk를 사용하되, 마지막 +/- 줄(앵커) 이후에 오는
 *   컨텍스트 줄(공백 접두사)을 제거한다.
 *   diff_hunk가 앵커 이후 컨텍스트를 포함하면 AI가 그 줄들을
 *   suggestion에 출력해 파일에 중복이 생기기 때문이다.
 *
 * issue_comment:
 *   줄 앵커가 없으므로 PR 전체 diff를 사용한다.
 */
function buildDiffContext(files) {
  if (eventName === 'pull_request_review_comment') {
    const hunk = commentDiffHunk || '';
    const filePath = commentPath || '?';

    const lines = hunk.split('\n');

    // 마지막 +/- 줄 = 앵커. 그 이후 공백-접두사 컨텍스트 줄을 잘라낸다.
    let anchorIdx = lines.length - 1;
    while (anchorIdx >= 0 && !/^[+\-]/.test(lines[anchorIdx])) {
      anchorIdx--;
    }
    const trimmedLines = anchorIdx >= 0 ? lines.slice(0, anchorIdx + 1) : lines;

    // AI에게 넘길 컨텍스트를 구성한다:
    // - @@ 헤더 줄: 불필요하므로 제외
    // - - 줄(삭제): 제거될 코드이므로 제외. 남기면 AI가 원본+수정본을 모두 출력해 중복이 생긴다.
    // - 공백 줄(컨텍스트): 접두사만 제거해 포함 (AI가 위치 파악에 사용)
    // - + 줄(추가): 현재 PR에서 추가된 코드. 접두사 제거해 포함.
    const cleanedHunk = trimmedLines
      .filter((line) => !line.startsWith('@@') && !line.startsWith('-'))
      .map((line) => line.replace(/^[+ ]/, ''))
      .join('\n');

    return `File: ${filePath}\n\n${cleanedHunk}`;
  }

  // issue_comment fallback
  if (!files.length) return '(PR에 표시할 코드 변경 없음)';

  const maxChars = 14000;
  const parts = [];
  let used = 0;
  for (const f of files) {
    const path = f.filename || '?';
    const diff = f.patch || '(Binary or no diff)';
    const block = `File: ${path}\n${diff}`;
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
  if (eventName === 'pull_request_review_comment') {
    const comments = await githubGet(
      `/repos/${repo}/pulls/${prNumber}/comments?per_page=100`,
    );
    return (comments || []).some((c) => c.body && c.body.includes(marker));
  }
  const comments = await githubGet(
    `/repos/${repo}/issues/${prNumber}/comments?per_page=100`,
  );
  return (comments || []).some((c) => c.body && c.body.includes(marker));
}

/**
 * Post the AI-generated suggestion to the PR
 */
async function createSuggestion(suggestion) {
  if (suggestion === undefined || suggestion === null) return;

  const body = `\`\`\`suggestion\n${suggestion}\n\`\`\`\n${MARKER_BOT}\n${replyMarker(commentId)}`;

  if (eventName === 'pull_request_review_comment') {
    // Reply directly within the review comment thread (allows "Apply suggestion" button)
    await githubPost(`/repos/${repo}/pulls/${prNumber}/comments`, {
      body,
      in_reply_to: Number(commentId),
    });
    console.log(
      '[ai-fix] Suggestion: review comment 스레드 답글로 게시 (Apply 가능)',
    );
    return;
  }

  console.log(
    '[ai-fix] 경고: 트리거가 일반 issue comment → Apply suggestion 버튼 없을 수 있음',
  );
  await githubPost(`/repos/${repo}/issues/${prNumber}/comments`, { body });
}

// --- Gemini AI Logic ---

/**
 * Request a code fix suggestion from the Gemini AI model
 */
function buildSuggestionPrompt(diffContext, comment) {
  return `You are an expert software engineer. Generate the replacement code for a GitHub suggestion block.

[How GitHub suggestions work]
A suggestion replaces the exact lines where the review comment was placed.
The code context below shows ONLY the lines up to and including the commented line — nothing after.
Your output will overwrite those lines exactly, so:
- Output ONLY the corrected version of the lines shown.
- Do NOT add lines that come after the shown code — they already exist in the file and will be duplicated.
- Do NOT repeat unchanged lines — only output lines that need to change.
- If the fix requires deleting the target line(s), output an empty string.

[Code Context]
${diffContext}

[Review Comment]
${comment}

[Output Rules]
- Raw source code only. No explanations, no markdown fences, no +/- diff prefixes.
- Keep indentation exactly as in the original.
- Minimal change: only modify what the review comment asks for.`;
}

function stripCodeFences(text) {
  if (!text) return '';
  let s = trimOuterNewlines(String(text));
  const fence = /^```[a-zA-Z]*\n([\s\S]*?)```$/m;
  const m = s.match(fence);
  if (m) return trimOuterNewlines(m[1]);
  return s;
}

function normalizeSuggestionBody(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = stripCodeFences(trimOuterNewlines(raw));
  let parsed;
  try {
    parsed = JSON.parse(s);
  } catch {
    return s;
  }
  if (typeof parsed === 'string') return trimOuterNewlines(parsed);
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const keys = ['result', 'code', 'suggestion', 'patch', 'content'];
    for (const k of keys) {
      const v = parsed[k];
      if (typeof v !== 'string') continue;
      const inner = trimOuterNewlines(v);
      try {
        const twice = JSON.parse(inner);
        if (typeof twice === 'string') return trimOuterNewlines(twice);
      } catch {
        /* keep inner */
      }
      return inner;
    }
  }
  return s;
}

function logGeminiHttpError(status, errBody, headers) {
  console.error('[ai-fix] Gemini HTTP', status);
  const retryAfter = headers?.get?.('Retry-After');
  if (retryAfter) console.error('[ai-fix] Retry-After header:', retryAfter);
  try {
    const j = JSON.parse(errBody);
    if (j.error)
      console.error(
        '[ai-fix] Gemini error:',
        JSON.stringify(j.error, null, 2).slice(0, 4000),
      );
  } catch {
    /* non-JSON */
  }
  console.error('[ai-fix] Gemini body:\n', truncateForLog(errBody));
}

async function generateFix(diffContext, comment) {
  const prompt = buildSuggestionPrompt(diffContext, comment);
  const geminiUrl = `https://generativelanguage.googleapis.com/${GEMINI_API_VERSION}/models/${GEMINI_MODEL}:generateContent`;
  const maxAttempts = 2;
  const retryDelayMs = 4000;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
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
        const errText = await res.text();
        logGeminiHttpError(res.status, errText, res.headers);
        if (res.status === 429 && attempt < maxAttempts) {
          console.log(
            `[ai-fix] Gemini 429 → ${retryDelayMs}ms 후 재시도 (${attempt}/${maxAttempts})`,
          );
          await delay(retryDelayMs);
          continue;
        }
        return null;
      }

      const data = await res.json();
      if (!data.candidates?.length) {
        console.error(
          '[ai-fix] Gemini 200 but no candidates:',
          truncateForLog(JSON.stringify(data), 6000),
        );
        return null;
      }

      const parts = data.candidates[0]?.content?.parts;
      const text = parts?.[0]?.text;
      if (text === undefined || text === null) {
        console.error(
          '[ai-fix] Gemini 200 but no text part:',
          truncateForLog(JSON.stringify(data.candidates[0]), 4000),
        );
        return null;
      }

      return normalizeSuggestionBody(text);
    } catch (err) {
      console.error('[ai-fix] Gemini fetch error:', err.message);
      return null;
    }
  }
  return null;
}

// ─── main ─────────────────────────────────────────────────────────────────────

async function main() {
  if (!GITHUB_TOKEN) {
    console.error('[ai-fix] INPUT_GITHUB_TOKEN이 필요합니다.');
    process.exit(1);
  }
  if (!GEMINI_API_KEY) {
    console.error('[ai-fix] INPUT_GEMINI_API_KEY가 없습니다.');
    process.exit(1);
  }
  if (!commentBody?.includes(AI_FIX_TRIGGER)) {
    console.log('[ai-fix] /ai-fix 트리거 없음, 종료');
    return;
  }

  console.log(`[ai-fix] repo: ${repo}, PR: #${prNumber}, event: ${eventName}`);
  console.log(`[ai-fix] Gemini: ${GEMINI_API_VERSION}/${GEMINI_MODEL}`);

  if (await alreadyReplied()) {
    console.log('[ai-fix] 이미 답글 게시됨, 중복 방지로 종료');
    return;
  }

  console.log(`[ai-fix] AI fix triggered for comment ${commentId}`);

  const files =
    eventName === 'pull_request_review_comment' ? [] : await getDiff();
  const diffContext = buildDiffContext(files);

  const aiResult = await generateFix(diffContext, commentBody);
  if (aiResult === null || aiResult === undefined) {
    console.log(
      '[ai-fix] AI 결과 없음 (쿼터, 오류, 또는 API에서 텍스트 미수신)',
    );
    return;
  }

  await createSuggestion(aiResult);
  console.log('[ai-fix] Suggestion created');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
