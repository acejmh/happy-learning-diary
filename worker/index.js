/**
 * Cloudflare Workers 엔트리 (정적 에셋 + API 를 한 워커에서 처리).
 *
 *   /api/analyze  ->  공유 핸들러(src/analyze.js)
 *   그 외          ->  public/ 의 정적 파일
 *
 * 배포: npx wrangler deploy   (worker/wrangler.toml 참고)
 */

import { handleAnalyze } from "../src/analyze.js";
import { KvRateLimiter, MemoryRateLimiter } from "../src/guard.js";

let fallbackLimiter;

function getLimiter(env) {
  if (env.RATE_LIMIT) {
    return new KvRateLimiter(env.RATE_LIMIT);
  }

  // KV 바인딩을 아직 안 만든 경우를 위한 임시 폴백.
  // 운영에서는 반드시 KV 를 붙일 것 (README 참고).
  if (!fallbackLimiter) {
    fallbackLimiter = new MemoryRateLimiter();
  }

  return fallbackLimiter;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/analyze") {
      return handleAnalyze(request, { env, limiter: getLimiter(env) });
    }

    return env.ASSETS.fetch(request);
  }
};
