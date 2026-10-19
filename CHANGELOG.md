# Changelog

## 1.0.0 — 2026-10-19

- First release.
- Solves `recaptcha_v2`, `recaptcha_v3`, `recaptcha_enterprise`, `turnstile`, `datadome` and `image` tasks through the CaptchaNo API.
- Batch input (`tasks`) plus single-task convenience fields.
- Bounded concurrency (1–50), blocking solve (`waitSeconds` up to 120) with 5 s polling for up to 180 s after a 202.
- Retries `rate_limited` / `capacity_unavailable` with exponential backoff (max 3 retries).
- `maxSpendUsd` budget cap; stops new submissions on `insufficient_balance`.
- One dataset item per task (Overview and Full solutions views) and an `OUTPUT` summary record.
- The run fails only on `invalid_api_key`; per-task failures go to the dataset.
- API key and proxy credentials masked in logs and output.
- Reusable typed client in `src/client.ts`.
