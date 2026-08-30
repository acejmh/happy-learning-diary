/**
 * 남용 방지: Origin 검사 + 일일 호출 상한 + 입력 크기 상한.
 *
 * 이 함수는 사용자의 Gemini API 키로 과금되는 호출을 대행한다.
 * 인증이 없는 공개 엔드포인트이므로, 최소한 아래 3가지는 반드시 건다.
 */

export const LIMITS = {
  // 클라이언트에서 리사이즈한 사진 기준. 여유 있게 잡되 원본 업로드는 막는다.
  MAX_IMAGE_BYTES: 4 * 1024 * 1024,
  MAX_TEXT_CHARS: 4000,
  // 하루 전체 호출 상한 (환경변수 DAILY_CALL_LIMIT 로 덮어쓸 수 있음)
  DEFAULT_DAILY_TOTAL: 500,
  // IP 하나당 하루 상한
  DEFAULT_DAILY_PER_IP: 60
};

export class GuardError extends Error {
  constructor(message, status) {
    super(message);
    this.name = "GuardError";
    this.status = status;
  }
}

/** KST 기준 YYYY-MM-DD. 한국 사용자 기준으로 자정에 초기화되도록. */
export function seoulDateKey(now = new Date()) {
  const kst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return kst.toISOString().slice(0, 10);
}

/**
 * Origin 검사.
 * ALLOWED_ORIGINS 가 설정돼 있으면 그 목록만, 없으면 요청이 도착한 자기 자신의 origin 만 허용한다.
 * 브라우저는 same-origin POST 에도 Origin 헤더를 붙이므로, curl 같은 직접 호출은 여기서 걸린다.
 */
export function checkOrigin(request, allowedOriginsCsv) {
  const origin = request.headers.get("origin");

  const allowed = String(allowedOriginsCsv || "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter(Boolean);

  if (allowed.length === 0) {
    allowed.push(new URL(request.url).origin);
  }

  if (!origin) {
    throw new GuardError("브라우저에서만 사용할 수 있습니다.", 403);
  }

  if (!allowed.includes(origin.replace(/\/$/, ""))) {
    throw new GuardError("허용되지 않은 출처입니다.", 403);
  }

  return origin;
}

/** 요청자 IP 추출. Cloudflare / Netlify 양쪽 헤더를 모두 본다. */
export function clientIp(request, context = {}) {
  return (
    request.headers.get("cf-connecting-ip") ||
    context.ip ||
    request.headers.get("x-nf-client-connection-ip") ||
    (request.headers.get("x-forwarded-for") || "").split(",")[0].trim() ||
    "unknown"
  );
}

/** Cloudflare KV 기반 카운터. 여러 인스턴스에 걸쳐 실제로 동작한다. */
export class KvRateLimiter {
  constructor(kv) {
    this.kv = kv;
  }

  async hit(key, limit) {
    const full = `rl:${seoulDateKey()}:${key}`;
    const current = Number((await this.kv.get(full)) || 0);

    if (current >= limit) {
      return { allowed: false, current };
    }

    // KV 는 강한 원자성이 없다. 상한 근처에서 약간 새는 것은 감수한다
    // (목적이 정확한 과금 통제가 아니라 폭주 차단이므로).
    await this.kv.put(full, String(current + 1), { expirationTtl: 60 * 60 * 36 });

    return { allowed: true, current: current + 1 };
  }
}

/** KV 가 없을 때 쓰는 인스턴스 로컬 카운터. 완전하지 않지만 없는 것보다 낫다. */
export class MemoryRateLimiter {
  constructor() {
    this.day = seoulDateKey();
    this.counts = new Map();
  }

  async hit(key, limit) {
    const today = seoulDateKey();

    if (today !== this.day) {
      this.day = today;
      this.counts.clear();
    }

    const current = this.counts.get(key) || 0;

    if (current >= limit) {
      return { allowed: false, current };
    }

    this.counts.set(key, current + 1);

    return { allowed: true, current: current + 1 };
  }
}

/**
 * 전체 상한과 IP 상한을 함께 확인한다.
 * IP 를 먼저 보고, 통과하면 전체를 본다.
 */
export async function enforceRateLimit(limiter, ip, env = {}) {
  if (!limiter) return;

  const perIp = Number(env.DAILY_PER_IP_LIMIT) || LIMITS.DEFAULT_DAILY_PER_IP;
  const total = Number(env.DAILY_CALL_LIMIT) || LIMITS.DEFAULT_DAILY_TOTAL;

  const ipResult = await limiter.hit(`ip:${ip}`, perIp);

  if (!ipResult.allowed) {
    throw new GuardError(
      "오늘은 충분히 연습했어요. 내일 다시 만나요!",
      429
    );
  }

  const totalResult = await limiter.hit("total", total);

  if (!totalResult.allowed) {
    throw new GuardError(
      "오늘 사용할 수 있는 양을 다 썼어요. 내일 다시 시도해 주세요.",
      429
    );
  }
}
