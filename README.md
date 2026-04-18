# AI Code Fixer Action 🤖

PR 리뷰 코멘트에 /ai-fix라고 남기면, AI가 자동으로 코드 수정안(Suggestion)을 생성해 줍니다. 리뷰어의 의도를 파악해 즉시 적용 가능한 코드를 제안하므로, 번거로운 수정 작업을 버튼 클릭 한 번으로 끝낼 수 있습니다.

## ✨ 주요 기능

**자동 코드 제안**: 리뷰 코멘트와 PR의 변경 사항(Diff)을 분석하여 최적의 코드를 제안합니다.

**GitHub Suggestion 호환**: GitHub의 Native Suggestion 기능을 사용하여 'Apply suggestion' 버튼을 활성화합니다.

**Gemini AI 활용**: Google의 최신 Gemini 모델을 사용하여 빠르고 정확한 코드 생성이 가능합니다.

---

## 🚀 시작하기

**1. Gemini API Key 발급**
[Google AI Studio](https://aistudio.google.com/app/api-keys)에서 API Key를 발급받으세요.

**2. GitHub Secrets 설정**
액션을 사용할 레포지토리의 **Settings > Secrets and variables > Actions**에 아래 값을 추가합니다.

- `GEMINI_API_KEY`: 발급받은 Gemini API 키

**3. 워크플로우 파일 생성**
`.github/workflows/ai-fix.yml` 파일을 만들고 아래 내용을 복사하세요.

```YML
name: AI Code Fixer
on:
  pull_request_review_comment:
    types: [created]
  issue_comment:
    types: [created]

jobs:
  ai-fix:
    if: contains(github.event.comment.body, '/ai-fix')
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
      issues: write
    steps:
      - name: Run AI Fixer
        uses: YourName/ai-fix-action@main  # 'YourName'을 본인의 GitHub ID로 변경하세요
        with:
          gemini_api_key: ${{ secrets.GEMINI_API_KEY }}
          gemini_model: 'gemini-2.0-flash-lite' # 옵션 (기본값)

```

---

## 💡 사용 방법

1. Pull Request의 **Files changed** 탭으로 이동합니다.
2. 특정 코드 줄에 리뷰 코멘트를 작성합니다.
3. 코멘트 내용에 `/ai-fix` 트리거 문구를 포함합니다.
   - ex: `/ai-fix 이 부분 가독성 좋게 함수로 빼주세요. `
4. 잠시 기다리면 AI가 해당 위치에 `Suggestion` 스레드를 자동으로 생성합니다.

---

## ⚙️ 설정 (Inputs)

| 이름                     | 설명                                                                               | 필수 여부 | 기본값                  |
| :----------------------- | :--------------------------------------------------------------------------------- | :-------: | :---------------------- |
| **`gemini_api_key`**     | [Google AI Studio](https://aistudio.google.com/)에서 발급받은 Gemini API 키입니다. | **필수**  | -                       |
| **`trigger_word`**       | AI를 활성화할 트리거 단어입니다. (예: `@bot fix`, `/gpt-fix`)                      |   선택    | `/ai-fix`               |
| **`gemini_model`**       | 제안 생성에 사용할 Gemini 모델명입니다.                                            |   선택    | `gemini-2.0-flash-lite` |
| **`gemini_api_version`** | 사용할 Gemini API의 버전입니다.                                                    |   선택    | `v1beta`                |
| **`github_token`**       | PR 데이터를 읽고 코멘트를 달기 위한 토큰입니다.                                    | **필수**  | `${{ github.token }}`   |
