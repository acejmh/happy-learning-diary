/**
 * Vercel Functions 엔트리 (Node.js 런타임, Web 표준 fetch export).
 *
 * Cloudflare Workers 와 시그니처가 같아서 worker/index.js 와 사실상 동일하다.
 * 로직은 전부 src/analyze.js 에 있다.
 *
 * ── 왜 Cloudflare 가 아니라 여기인가 ──────────────────────────────
 * Cloudflare Workers 는 엣지에서 아웃바운드가 나가는데, Google 이 그 IP 를
 * 지원 지역으로 인식하지 못해 Gemini 가 다음을 반환한다:
 *     "User location is not supported for the API use."
 * Enterprise 가 아니면 Workers 실행 리전을 고정할 수 없다.
 * Vercel 함수는 리전이 고정(iad1, 미국 동부)되므로 이 문제가 없다.
 */

import { handleAnalyze } from '../src/analyze.js';
import { MemoryRateLimiter } from '../src/guard.js';

/**
 * 인스턴스 로컬 카운터.
 * 서버리스라 인스턴스가 여러 개 뜨면 각자 세므로 완전하지 않다.
 * 폭주를 늦추는 용도이고, 정확한 상한이 필요해지면 Upstash Redis 등
 * 외부 저장소를 붙여 src/guard.js 의 KvRateLimiter 자리에 끼우면 된다.
 */
const limiter = new MemoryRateLimiter();

export default {
  fetch(request) {
    return handleAnalyze(request, { env: process.env, limiter });
  }
};
