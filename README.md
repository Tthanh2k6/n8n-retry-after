# n8n-retry-after

Drop-in `Retry-After` parser, exponential backoff calculator, and importable n8n workflow for handling HTTP `429` / `503` responses.

## Problem

n8n's built-in per-node **Retry On Fail** setting uses a fixed wait between tries (capped at 5000 ms in the node editor) and does not inspect the HTTP `Retry-After` response header. When APIs return `Retry-After` as delta-seconds (e.g. `120`), as an HTTP-date (`Wed, 11 Nov 2026 08:00:00 GMT` per RFC 9110 §10.2.3), or omit the header entirely, workflows need explicit logic to parse the delay or fall back to exponential backoff.

Reference discussion: [How do you handle Retry-After when it's a date instead of seconds, or missing entirely?](https://community.n8n.io/t/327880)

## What the Workflow Does

The workflow in `workflows/http-request-with-retry-after.json` implements a retry loop around an **HTTP Request** node:

1. **Config** (`Set` node): Initializes `url`, `method` (`GET`), `maxAttempts` (`5`), `budgetSeconds` (`60`), and `attempt` (`1`).
2. **HTTP Request** (v4.2): Sends the request with **Include Response Headers and Status** and **Never Error** enabled so `429` and `503` responses are passed downstream instead of halting the execution.
3. **Decide** (`Code` node, JavaScript): Runs `parseRetryAfter`, `backoffMs`, and `nextDelay` on the response `statusCode` and `headers`:
   - `done`: Status code is not in the retryable set (`429`, `503` by default).
   - `give_up`: `attempt > maxAttempts`.
   - `defer`: Computed wait exceeds `budgetMs` (`budgetSeconds * 1000`). Routes to **Re-queue (connect your queue here)** so the item can be re-queued externally.
   - `retry`: Computed wait is within budget. Routes to **Wait** (`Math.ceil(delayMs / 1000)` seconds) -> **Next attempt** (`attempt + 1`) -> back to **HTTP Request**.

## How to Import

1. Open n8n and create or open a workflow.
2. Select **Import from File...** in the workflow menu and choose `workflows/http-request-with-retry-after.json`.
3. Alternatively, copy `snippets/code-node.js` into a JavaScript **Code** node (mode: **Run Once for Each Item**) in an existing workflow.

## Notes on n8n Wait Node & Execution Budget

Per the n8n **Wait** node documentation, waits under 65 seconds keep the execution in memory, whereas longer waits offload execution data to the database and resume later. The default `budgetSeconds` is set to `60` (`budgetMs: 60000`) and the `defer` action exists so long `Retry-After` windows can be pushed to an external queue or scheduled table instead of holding executions open.

## Testing the Logic

Requires Node.js >= 18 (uses the built-in `node:test` and `node:assert` modules, with zero dependencies):

```bash
npm test
```

## Limitations

- The sample workflow handles one item at a time: the **Decide** node reads the current attempt from the last **Next attempt** run. For many URLs, call it as a sub-workflow per item (for example from a **Loop Over Items** node).
- `defer` only routes the item; connecting a real queue (database table, Redis, a scheduled re-run) is up to you.
- The logic is unit-tested with `node --test`; the workflow JSON was checked with an n8n workflow validator, not run against every n8n version.

## License

MIT License. Copyright (c) 2026 Tran Trung Thanh. See [LICENSE](./LICENSE).
