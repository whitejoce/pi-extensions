# Search provider adapters

The web-search extension exposes one stable tool/command surface. Providers are
internal adapters, not separate Pi extensions or dynamically loaded plugins.
Only DeepSeek and AnySearch are implemented. Tavily and Exa are potential future
adapters, not supported configuration values.

## Boundaries

| Module | Responsibility |
| --- | --- |
| `extensions/web-search.ts` | Pi tools, command lifecycle, UI and expense events |
| `web-search/types.ts` | Normalized search results, page contents and search details |
| `web-search/provider.ts` | Typed adapter contract and request descriptor |
| `web-search/providers/*.ts` | Provider URLs, auth placement, wire payloads, parsing, errors and prices |
| `web-search/registry.ts` | Implemented adapters and derived provider ID types |
| `web-search/settings.ts` | Masked setup, consented onboarding, atomic persistence, hot switching and status |
| `web-search/configuration.ts` | Personal/legacy config, isolated credentials and deterministic selection |
| `web-search/transport.ts` | HTTP, bounded UTF-8/JSON, retry deadline, aborts and redirect refusal |
| `web-search/client.ts` | Cache, local quota reservations, normalized results and operation accounting |
| `web-search/render.ts` | Common rendering; missing scores/prices are not invented |

The common client and transport contain no branches on provider IDs. Provider
request descriptors own method, relative path, headers and optional JSON body,
so a new provider can use Bearer auth, a different header or a JSON-body key
without modifying the HTTP coordinator. Descriptors must never be logged: they
can contain credentials. Transport enforces relative paths and refuses redirects.

## Selection and capabilities

- Default `auto` selects the configured adapter with the lowest `autoPriority`.
  DeepSeek is 10, AnySearch is 20. Keep DeepSeek first when adding lower-priority
  providers; selection does not depend on object insertion order.
- Credentials are resolved using each adapter's declared key/address fields and
  optional Pi credential-provider ID. Never copy another adapter's key or URL.
- Explicit provider selection never falls back. Auto is credential discovery at
  construction/reload, not service failover on authentication, quota or network
  errors. Do not send the same query to another service without an explicit policy.
- Page extraction is optional. A search-only adapter returns a clear unsupported
  error from `web_fetch` before issuing HTTP requests or reserving quota. There is
  no implicit cross-provider extraction fallback.
- Scores may be null. Normalize results into the shared model without fabricating
  authority scores or including an unbounded full page as a search summary.
- Prices are per operation. The current UI and service ledger use CNY; mark unknown
  or non-CNY prices null rather than inventing exchange rates. A broader currency
  model can be a separate change. Successful nonempty calls consume the existing
  local quota, which is not a provider-authoritative billing meter.

## Add a provider

1. Add `extensions/web-search/providers/<id>.ts` implementing `SearchAdapter`.
   Declare isolated config fields, base URL, HTTPS policy, selection priority,
   search request/parser, optional fetch request/parser, and safe error handling.
2. Register the working adapter in `registry.ts`. Provider ID types are derived
   from the registry, so there is no second union or client switch to update.
3. Add mocked wire-protocol tests: authentication and endpoint mapping, parsing,
   malformed/business errors, sensitive-body redaction and missing capabilities.
   Keep general client invariants in shared contract tests, not duplicated adapters.
4. Update configuration examples, the extension inventory and user documentation.
   Run strict TypeScript checking, all offline tests, relocated Pi loading and an
   explicitly authorized live smoke test. Keep test credentials outside the repo.

`web-search/adapters.test.ts` injects an offline fixture through `ClientOptions`.
It proves GET/custom-header auth, a third wire format, per-operation prices,
cache reuse, credential isolation, priority and search-only capability handling.
The fixture is not registered and cannot be enabled through user configuration.

Provider adapters can optionally expose an explicit email-registration capability.
It is invoked only by the consented TUI setup flow, never startup or search.
AnySearch registration uses its fixed official endpoint, one request without retries,
and never exposes raw response messages or the one-time key.

No new dependency container, dynamic plugin discovery, unsolicited account signup,
or unimplemented provider settings are needed for this extension point.
