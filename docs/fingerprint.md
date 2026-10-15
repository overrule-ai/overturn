# Fingerprint contract

A fingerprint identifies a tool call by what it *means*, so a replay can answer the same call from a recording. It is a compatibility contract: every SDK version and the server must compute the same value for the same call, or recorded cases stop matching. Changing anything below bumps `FINGERPRINT_VERSION`.

Version: **1**. Reference implementation: `packages/shared/src/fingerprint.ts`; Python mirror: `packages/sdk-python/overturn/fingerprint.py`; shared test vectors: `packages/shared/src/fingerprint.vectors.json`.

## Definition

```
fingerprint = sha256( kind + "\n" + name + "\n" + canonicalJSON(select(args)) )   // lowercase hex
```

- `kind` is `"tool_call"` for tools.
- `name` is the tool name exactly as declared.
- `select(args)`:
  - if the tool declares `matchOn: [k1, k2, …]`, keep only those top-level keys (missing keys are omitted, not nulled);
  - else if it declares `ignoreArgs: [...]`, drop those top-level keys;
  - else keep `args` as is. `matchOn` wins when both are set.
  - non-object args (a string, a number, an array) pass through untouched.

## Canonical JSON

- Object keys sorted by code point, recursively.
- `null` and `undefined` values are dropped, in objects and in arrays. Functions and symbols are treated as `undefined`.
- Strings are trimmed (leading and trailing whitespace) and serialized with JSON escaping; non-ASCII is kept as is (not `\u` escaped).
- Numbers: `NaN` and `±Infinity` become `null`; `-0` becomes `0`; integers with `|n| < 1e21` print without a fraction; everything else prints the shortest round-trip form the JavaScript `Number#toString` algorithm produces (`1e+21`, `1e-7`, `0.00001`, `1.5e+300`). The Python SDK implements the same algorithm on top of `repr()`.
- Booleans print `true`/`false`.
- Arrays keep their order; order is usually semantic for tool arguments.
- `Date` objects (JavaScript) and `datetime` (Python) serialize as ISO 8601 strings with a `Z` suffix for UTC.
- No whitespace anywhere.

## Examples

| args | options | canonical |
| --- | --- | --- |
| `{ email: "  a@b.c ", plan: "pro" }` | – | `{"email":"a@b.c","plan":"pro"}` |
| `{ ticketId: "T-1", priority: "P0", requestId: "x" }` | `matchOn: ["ticketId"]` | `{"ticketId":"T-1"}` |
| `{ a: 1.0, b: -0, c: null }` | – | `{"a":1,"b":0}` |

The full vector set, with digests, lives in `fingerprint.vectors.json` and is asserted by both SDKs' test suites.

## Guidance for tool authors

- Use `matchOn` for tools whose arguments carry noise (timestamps, request ids, pagination cursors).
- Keep side-effect tools keyed on the identifiers that matter (`matchOn: ["ticketId", "priority"]`), so a replay that chooses a different priority is visible as an unseen fingerprint rather than silently answered.
