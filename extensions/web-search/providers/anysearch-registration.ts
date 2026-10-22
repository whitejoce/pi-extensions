import { ApiError, responseText } from "../response.js";

export const ANYSEARCH_LOGIN = "https://www.anysearch.com/login";

export function validEmail(email: string): boolean {
  return email.length <= 254 && /^[^\s@\x00-\x1f]+@[^\s@\x00-\x1f]+\.[^\s@\x00-\x1f]+$/.test(email);
}

/** Account creation is not idempotent: no retries, redirects or custom server URL. */
export async function registerAnySearch(email: string, fetchImpl: typeof fetch, signal: AbortSignal): Promise<string> {
  if (!validEmail(email)) throw new ApiError(400, "邮箱格式无效，请重新输入真实可接收邮件的邮箱");
  const active = AbortSignal.any([signal, AbortSignal.timeout(30_000)]);
  active.throwIfAborted();
  try {
    const response = await fetchImpl("https://api.anysearch.com/v1/auth/email/register", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ email }),
      redirect: "error", signal: active,
    });
    let value: unknown;
    try { value = JSON.parse(await responseText(response, active)); }
    catch { active.throwIfAborted(); throw new ApiError(502, "注册服务返回无效响应，请到 AnySearch 官网确认账号状态，勿重复注册"); }
    active.throwIfAborted();
    const data = value as { code?: unknown; message?: unknown; data?: { api_key?: { key?: unknown } } } | null;
    if (response.ok && data?.code === 0) {
      const key = data.data?.api_key?.key;
      if (typeof key === "string" && key.length > 0 && key.length <= 4096 && !/[\s\x00-\x1f]/.test(key)) return key;
      throw new ApiError(502, `账号可能已创建，但未获得有效密钥。请登录 ${ANYSEARCH_LOGIN} 创建密钥`);
    }
    const message = typeof data?.message === "string" ? data.message : "";
    if (message === "email_already_registered") throw new ApiError(409, `邮箱已注册，请登录 ${ANYSEARCH_LOGIN} 获取密钥，再选择“已有 API Key”`);
    if (message === "Invalid email address.") throw new ApiError(400, "邮箱格式无效，请重新输入真实可接收邮件的邮箱");
    if (message.startsWith("Key creation failed.")) throw new ApiError(502, `账号已创建，但密钥创建失败。请登录 ${ANYSEARCH_LOGIN} 获取密钥`);
    if (response.status === 429 || message.includes("Rate limited")) throw new ApiError(429, "注册请求过于频繁，请稍后再试；不会自动重试或换邮箱注册");
    throw new ApiError(response.status >= 400 ? response.status : 502, "AnySearch 注册未完成，请到官网确认账号状态后再操作");
  } catch (error) {
    signal.throwIfAborted();
    if (error instanceof ApiError) throw error;
    throw new ApiError(504, `注册请求未完成，账号可能已创建。请登录 ${ANYSEARCH_LOGIN} 确认，不会自动重试`);
  }
}
