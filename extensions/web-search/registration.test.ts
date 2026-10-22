import assert from "node:assert/strict";
import { registerAnySearch } from "./providers/anysearch-registration.js";

const signal = new AbortController().signal;
let calls = 0;
const key = await registerAnySearch("new@example.com", async (url, init) => {
  calls++;
  assert.equal(String(url), "https://api.anysearch.com/v1/auth/email/register");
  assert.equal(init?.method, "POST");
  assert.equal(init?.redirect, "error");
  assert.equal(new Headers(init?.headers).has("Authorization"), false);
  assert.deepEqual(JSON.parse(String(init?.body)), { email: "new@example.com" });
  return Response.json({ code: 0, data: { api_key: { key: "test-once-key" } } });
}, signal);
assert.equal(key, "test-once-key");
assert.equal(calls, 1);
await assert.rejects(registerAnySearch("invalid", async () => { throw new Error("must not send invalid email"); }, signal), /邮箱格式/);

for (const [message, status, expected] of [
  ["email_already_registered", 409, /邮箱已注册/],
  ["Invalid email address.", 400, /邮箱格式/],
  ["Key creation failed. SENSITIVE", 500, /账号已创建/],
  ["Rate limited SENSITIVE", 429, /过于频繁/],
  ["SENSITIVE api_key=password", 500, /未完成/],
] as const) {
  let attempts = 0;
  await assert.rejects(registerAnySearch("existing@example.com", async () => {
    attempts++;
    return Response.json({ code: -1, message }, { status });
  }, signal), error => error instanceof Error && expected.test(error.message) && !/SENSITIVE|api_key=password/.test(error.message));
  assert.equal(attempts, 1, "account registration must never retry automatically");
}
await assert.rejects(registerAnySearch("new@example.com", async () => Response.json({ code: 0, data: {} }), signal), /未获得有效密钥/);
await assert.rejects(registerAnySearch("new@example.com", async () => { throw new Error("SENSITIVE"); }, signal), error => error instanceof Error && !error.message.includes("SENSITIVE") && error.message.includes("不会自动重试"));
const aborted = new AbortController();
aborted.abort();
await assert.rejects(registerAnySearch("new@example.com", async () => { throw new Error("must not dispatch"); }, aborted.signal));
console.log("Email registration: fixed official endpoint, explicit one-shot request, safe errors, cancellation and one-time key parsing passed");
