# 배움일기 맞춤법·문맥 코치

초등학생이 쓴 배움일기 사진을 올리면, 글씨를 읽어 주고 맞춤법 → 띄어쓰기 → 조사·문맥
3단계 미션으로 스스로 고쳐 보게 하는 웹앱.

## 구조

```
public/           정적 파일 (index.html, app.js, style.css)
src/              플랫폼 무관 핵심 로직
  analyze.js        요청 라우팅 + 검증 (Web 표준 Request/Response)
  gemini.js         Gemini 호출
  prompts.js        OCR / 첨삭 프롬프트
  guard.js          Origin 검사 · 일일 상한 · 입력 크기 상한
api/analyze.js    Vercel Functions 어댑터   ← 운영 배포처
worker/index.js   Cloudflare Workers 어댑터 (Gemini 지역 제한으로 사용 불가, 아래 참고)
netlify/functions/analyze.mjs   Netlify Functions v2 어댑터
test/             네트워크 없이 도는 검증 (npm test)
```

Vercel / Cloudflare Workers / Netlify Functions v2 는 **셋 다 Web 표준 `fetch` 시그니처**를 쓴다.
그래서 `src/` 하나를 셋이 공유하고, 어댑터는 각각 10줄 남짓이다.
클라이언트는 항상 `/api/analyze` 만 호출하므로 **호스팅을 옮겨도 프론트엔드는 손댈 필요가 없다.**

> ⚠️ **GitHub Pages 에는 배포할 수 없다.** 이 앱은 서버 함수 없이는 동작하지 않는다.
> Pages 는 정적 파일만 서빙하므로 `/api/analyze` 가 404 가 되고, 사진 인식 단계에서 멈춘다.
> Gemini 키를 프론트엔드에 넣어 우회하면 키가 즉시 공개된다. 절대 하지 말 것.

> ⚠️ **Cloudflare Workers 에도 배포할 수 없다.** 배포 자체는 문제없이 되지만,
> Workers 는 엣지에서 아웃바운드가 나가고 Google 이 그 IP 를 지원 지역으로 인식하지 못한다:
> ```
> Gemini API error: User location is not supported for the API use.
> ```
> Enterprise 플랜이 아니면 Workers 실행 리전을 고정할 수 없다.
> `worker/` 와 `wrangler.toml` 은 참고용으로 남겨 두었다.
> (Google 계정에 결제를 활성화하면 지역 제한이 풀린다는 보고가 있으나 검증하지 않았다.)

## 로컬 실행

```bash
npm test                       # 검증 (API 키 불필요)
npx vercel dev                 # 로컬 서버 (http://localhost:3000)
npx wrangler dev               # 대안 (http://localhost:8787)
```

로컬에서 Gemini 를 실제로 부르려면 키를 넣는다. 둘 다 `.gitignore` 에 걸려 있다.

```
.env.local   →  GEMINI_API_KEY=여기에_키      (vercel dev)
.dev.vars    →  GEMINI_API_KEY=여기에_키      (wrangler dev)
```

참고: **로컬 실행은 Cloudflare 라도 Gemini 지역 제한에 걸리지 않는다.**
아웃바운드가 엣지가 아니라 내 PC 에서 나가기 때문이다.
지역 제한은 배포했을 때만 나타난다.

## 배포 — Vercel (운영)

정적 파일(`public/`)과 API(`api/analyze.js`)를 한 프로젝트가 함께 서빙한다.
Hobby 플랜은 무료이고 **배포 횟수 제한이 없다.**

```bash
npx vercel login
npx vercel link            # 프로젝트 생성/연결
npx vercel env add GEMINI_API_KEY production
npx vercel --prod          # 배포
```

`vercel.json` 이 `regions: ["iad1"]` 로 **미국 동부에 리전을 고정**한다.
이것이 Gemini 지역 제한을 피하는 핵심이므로 지우지 말 것.

`ALLOWED_ORIGINS` 는 설정하지 않아도 된다. 비어 있으면 "요청이 도착한 자기 origin" 만
허용하므로, 배포 URL 이 바뀌어도 알아서 맞는다. 커스텀 도메인을 여러 개 붙였다면 명시한다.

## 배포 — Cloudflare Workers (사용 불가, 참고용)

설정과 배포는 정상 동작하지만 Gemini 호출이 지역 제한에 걸린다(위 경고 참고).
지역 제한이 풀린 뒤에 쓰려면:

```bash
npx wrangler kv namespace create RATE_LIMIT   # id 를 wrangler.toml 에 반영
npx wrangler secret put GEMINI_API_KEY
npx wrangler deploy
```

Cloudflare 쪽은 KV 로 **일일 상한이 인스턴스 간 공유**되므로, 상한만 놓고 보면 여기가 더 정확하다.

## 배포 — Netlify (기존, 전환기용)

```
publish  = public
functions = netlify/functions
```

Netlify 대시보드 → Site settings → Environment variables 에 `GEMINI_API_KEY` 를 넣는다.
`netlify.toml` 의 리다이렉트가 `/api/analyze` → `/.netlify/functions/analyze` 를 이어 준다.

⚠️ Netlify 쪽 일일 상한은 **인스턴스 로컬 카운터**라 완전하지 않다.
함수 인스턴스가 여러 개 뜨면 각자 세기 때문이다.
제대로 된 상한이 필요하면 Cloudflare(KV) 쪽을 쓴다.

## 환경변수

| 이름 | 필수 | 기본값 | 설명 |
|---|---|---|---|
| `GEMINI_API_KEY` | ✅ | — | Gemini API 키. **secret 으로 넣을 것** |
| `ALLOWED_ORIGINS` | | 요청의 자기 origin | 쉼표로 구분한 허용 origin 목록 |
| `DAILY_CALL_LIMIT` | | `500` | 하루 전체 호출 상한 (KST 자정 초기화) |
| `DAILY_PER_IP_LIMIT` | | `60` | IP 하나당 하루 상한 |

## 왜 이런 제한이 걸려 있나

`/api/analyze` 는 **인증 없는 공개 엔드포인트**이고, 호출 하나하나가 내 Gemini 키로
과금된다. 아무 보호가 없으면 주소만 알면 누구나 내 요금으로 LLM 을 쓸 수 있다.
그래서 3중으로 막는다.

1. **Origin 검사** — 브라우저는 same-origin POST 에도 `Origin` 헤더를 붙인다.
   `curl` 같은 직접 호출은 헤더가 없어 403 으로 걸린다.
   **다만 이것은 인증이 아니다.** 주소를 아는 사람이 `Origin` 헤더를 직접 붙이면 통과한다.
   브라우저 기반 오·남용과 무심코 긁는 봇을 막는 용도이고, 실질적인 방어선은 아래 2번이다.
   실제로 남용이 관측되면 Cloudflare Turnstile 같은 것을 붙여야 한다.
2. **일일 상한** — IP 당 60회 / 전체 500회, KST 자정 초기화.
   Cloudflare 는 KV 로 인스턴스 간 공유되지만, **Vercel/Netlify 는 인스턴스 로컬 카운터라
   완전하지 않다** (인스턴스가 여러 개 뜨면 각자 센다). 폭주를 늦추는 수준으로 이해할 것.
3. **입력 크기 상한** — 사진 4MB, 글 4000자.

여기에 더해 클라이언트가 업로드 전에 사진을 긴 변 1600px / JPEG 0.8 로 줄인다.
페이로드 상한을 피하는 동시에 함수 실행 시간(= 사용량)도 줄어든다.

## 미션 설계상 중요한 제약

`corrected` 는 반드시 **이번 미션 범위의 오류만** 고친 문장이어야 한다
(`src/prompts.js` 에서 강제한다).

전체를 다 고쳐 버리면 미션 1 을 통과하는 순간 문장이 완성돼서
미션 2(띄어쓰기)·3(조사)에 고칠 거리가 남지 않는다. 3단계 학습이 통째로 무너진다.
프롬프트를 손볼 때 이 부분을 깨뜨리지 않도록 주의할 것.
