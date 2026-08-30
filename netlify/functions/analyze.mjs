/**
 * Netlify Functions v2 엔트리.
 * 로직은 src/analyze.js 에 있고 이 파일은 어댑터일 뿐이다.
 *
 * v2 는 Web 표준 Request/Response 를 쓰므로 busboy 가 필요 없다.
 * (v1 의 event.body + base64 + busboy 조합을 걷어냈다.)
 */

import { handleAnalyze } from "../../src/analyze.js";
import { MemoryRateLimiter } from "../../src/guard.js";

// 인스턴스 로컬 카운터. Netlify 에는 공짜로 쓸 수 있는 공유 상태가 없어서,
// 여기서는 폭주를 늦추는 정도의 역할만 한다.
// 제대로 된 상한은 Cloudflare(worker/) 의 KV 쪽에서 건다.
const limiter = new MemoryRateLimiter();

export default async (request, context) =>
  handleAnalyze(request, {
    env: process.env,
    context,
    limiter
  });
