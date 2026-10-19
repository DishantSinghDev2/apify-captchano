# CaptchaNo Captcha Solver — reCAPTCHA, Turnstile, DataDome

Solve **reCAPTCHA v2**, **reCAPTCHA v3**, **reCAPTCHA Enterprise**, **Cloudflare Turnstile**, **DataDome** and **image captchas** from any Apify Actor, scraper or workflow. Give it one task or a batch of thousands; it solves them in parallel on CaptchaNo's own solving infrastructure and writes each token, cookie or answer to the dataset.

- **Batch solving** with configurable concurrency (1–50 tasks in parallel)
- **Budget cap**: stop submitting new tasks once your spend reaches a set amount
- **Automatic retries** on rate limits and temporary capacity limits (exponential backoff, max 3)
- **Long solves handled**: blocks up to 120 s per request, then polls every 5 s for up to 180 s more
- **Failed solves are never billed** by CaptchaNo
- **Secrets stay secret**: the API key is an encrypted input and is never logged or stored; proxy credentials are masked in logs and output
- Ships a small typed **TypeScript client** (`src/client.ts`) you can copy into your own Actors

## What you need

A CaptchaNo API key (starts with `cn-`). Create one at [captchano.com](https://captchano.com). API reference: [captchano.com/captcha-solver-api](https://captchano.com/captcha-solver-api).

## Supported captcha types

| `type` | Required fields | Optional fields | Solution field |
| --- | --- | --- | --- |
| `recaptcha_v2` | `url`, `sitekey` | `invisible`, `userAgent`, `proxy` | `token` |
| `recaptcha_v3` | `url`, `sitekey` | `action`, `minScore` (0.1–0.9), `userAgent`, `proxy` | `token` |
| `recaptcha_enterprise` | `url`, `sitekey` | `action`, `minScore`, `invisible`, `userAgent`, `proxy` | `token` |
| `turnstile` | `url`, `sitekey` | `action`, `cData`, `pageData`, `userAgent`, `proxy` | `token` |
| `datadome` | `url`, `challengeUrl`, `proxy` | `userAgent` | `cookie` |
| `image` | `body` (base64 image) | — | `text` |

`proxy` is a string such as `http://user:pass@host:port` (http, socks4 or socks5) or an object.

## Input

Batch mode — put tasks in **Tasks**:

```json
{
  "apiKey": "cn-your-key",
  "tasks": [
    {
      "type": "recaptcha_v2",
      "url": "https://www.google.com/recaptcha/api2/demo",
      "sitekey": "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"
    },
    {
      "type": "turnstile",
      "url": "https://example.com/login",
      "sitekey": "0x4AAAAAAA..."
    }
  ],
  "waitSeconds": 60,
  "concurrency": 5,
  "maxSpendUsd": 1
}
```

Single-task mode — leave **Tasks** empty and fill in `type`, `url`, `sitekey` (and `action`, `minScore`, `invisible`, `challengeUrl`, `proxy`, `userAgent` as needed).

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | string (secret) | — | **Required.** Your CaptchaNo API key. |
| `tasks` | array | — | Batch of task objects (fields as in the table above). |
| `type`, `url`, `sitekey`, `action`, `minScore`, `invisible`, `challengeUrl`, `proxy`, `userAgent` | — | — | Single task, used when `tasks` is empty. |
| `waitSeconds` | integer 0–120 | 60 | How long each solve request blocks. Tasks still solving afterwards are polled every 5 s for up to 180 s. |
| `concurrency` | integer 1–50 | 5 | Tasks solved in parallel. |
| `maxSpendUsd` | number | none | Stop submitting new tasks once this run's CaptchaNo spend reaches this amount. Tasks already in progress still finish. |

## Output

One dataset item per input task, in the **Overview** view (index, ID, type, status, truncated solution, solve time, cost, error) and the **Full solutions** view. Example item (values illustrative):

```json
{
  "taskIndex": 0,
  "id": "task_01J...",
  "type": "recaptcha_v2",
  "status": "ready",
  "token": "03AFcWeA...",
  "cookie": null,
  "text": null,
  "solutionUserAgent": null,
  "solutionPreview": "03AFcWeA...",
  "errorCode": null,
  "errorMessage": null,
  "costUsd": 0.00285,
  "cost": "0.00285",
  "billedFrom": null,
  "solveTime": null,
  "createdAt": "2026-10-19T12:00:00.000Z",
  "attempts": 1,
  "polls": 0,
  "finishedAt": "2026-10-19T12:00:05.000Z",
  "input": {
    "type": "recaptcha_v2",
    "url": "https://www.google.com/recaptcha/api2/demo",
    "sitekey": "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"
  }
}
```

`cost`, `billedFrom` and `solveTime` are copied from the API response as returned.

`status` is one of:

- `ready`: solved. Use `token` (reCAPTCHA / Turnstile), `cookie` (DataDome) or `text` (image).
- `failed`: not solved (and not billed). See `errorCode`: `unsolvable`, `invalid_sitekey`, `unsupported_type`, `proxy_required`, `proxy_unreachable`, `score_not_met`, `capacity_unavailable`, `rate_limited`, `upstream_error`, `insufficient_balance`, `poll_timeout`, `network_error`.
- `skipped`: never submitted because the budget was reached (`budget_reached`), the balance ran out (`insufficient_balance`) or the key was rejected.
- `invalid`: the task failed input validation (`invalid_input`); the message says which field.

The key-value store record **OUTPUT** holds the run summary:

```json
{ "total": 2, "solved": 2, "failed": 0, "skipped": 0, "invalid": 0, "totalCostUsd": 0.0057, "stoppedReason": null }
```

The run fails (non-zero exit) only when the API key is rejected (`invalid_api_key`) or the input itself is unusable. Per-task failures never fail the run; they are written to the dataset.

## Call it from another Actor

```js
import { Actor } from 'apify';

await Actor.init();

const run = await Actor.call('<username>/captchano-captcha-solver', {
  apiKey: process.env.CAPTCHANO_API_KEY,
  tasks: [
    { type: 'turnstile', url: 'https://example.com/login', sitekey: '0x4AAAAAAA...' },
  ],
  waitSeconds: 60,
});

const { items } = await Actor.apifyClient.dataset(run.defaultDatasetId).listItems();
const token = items[0]?.token;

await Actor.exit();
```

## Call it from the Apify API

Run synchronously and get the dataset items in one request:

```bash
curl -X POST \
  "https://api.apify.com/v2/acts/<username>~captchano-captcha-solver/run-sync-get-dataset-items?token=$APIFY_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "apiKey": "cn-your-key",
    "tasks": [{
      "type": "recaptcha_v2",
      "url": "https://www.google.com/recaptcha/api2/demo",
      "sitekey": "6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-"
    }]
  }'
```

Python (`apify-client`):

```python
from apify_client import ApifyClient

client = ApifyClient("<APIFY_TOKEN>")
run = client.actor("<username>/captchano-captcha-solver").call(run_input={
    "apiKey": "cn-your-key",
    "type": "turnstile",
    "url": "https://example.com/login",
    "sitekey": "0x4AAAAAAA...",
})
items = client.dataset(run["defaultDatasetId"]).list_items().items
print(items[0]["token"])
```

## Use the client directly

`src/client.ts` is a dependency-free typed client for the CaptchaNo API (Node 18+, uses global `fetch`):

```ts
import { CaptchaNoClient } from './client.js';

const client = new CaptchaNoClient({ apiKey: process.env.CAPTCHANO_API_KEY! });
const { task } = await client.solveAndWait(
  { type: 'recaptcha_v2', url: 'https://www.google.com/recaptcha/api2/demo', sitekey: '6Le-wvkSAAAAAPBMRTvw0Q4Muexq9bi0DJwx_mJ-' },
  { waitSeconds: 60 },
);
console.log(task.status, task.solution?.token, task.cost);
console.log(await client.getBalance()); // { balance, currency: "USD" }
```

## Pricing

- **You bring your own CaptchaNo API key and pay CaptchaNo per successful solve**, at the rates on [captchano.com](https://captchano.com). Failed solves are never billed. This Actor adds no extra charge on top.
- **Apify platform usage** (compute units for running this Actor) is billed by Apify under your Apify plan. The Actor runs in 128–1024 MB and spends most of its time waiting on the network.
- Use `maxSpendUsd` to cap how much CaptchaNo spend a single run can create.

## Privacy and security

- `apiKey` and `proxy` are secret inputs, encrypted by Apify.
- The API key is never printed, logged or stored in the dataset or key-value store. Logs show it masked (`cn-***abcd`).
- Proxy usernames and passwords are masked (`http://***:***@host:port`) in logs and in the `input` echo.
- Base64 image bodies are not echoed back; the dataset shows only their length.

## Support

- Docs: [captchano.com/captcha-solver-api](https://captchano.com/captcha-solver-api)
- Email: [support@captchano.com](mailto:support@captchano.com)
- Publisher: DishIs Technologies LLC

## Local development

```bash
npm install
npm run build
npm test                    # unit tests (mocked fetch)
npm run validate-schemas    # checks .actor/*.json

# Run locally with the Apify CLI (reads storage/key_value_stores/default/INPUT.json):
apify run
```
