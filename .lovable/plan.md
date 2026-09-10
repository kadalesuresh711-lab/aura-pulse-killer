# Fix the published second-run stall

## Confirmed cause
Production logs show Agnes returning Cloudflare rate-limit error `1015`. The app then trusts an excessive provider retry delay, so one prompt request remained open for about 15 minutes while heartbeat messages made the page appear to be working. Concurrent per-panel text checks add many Agnes calls during rendering and worsen the limit.

## Changes
- Limit the shared Agnes client to one active text request and cap every retry delay to a few seconds; queued work will stop immediately after Insta Kill.
- Remove redundant Agnes calls from the image-render path. Prompt writing already receives each exact timestamp and script line; rendering will no longer re-check and re-review every panel with the same rate-limited text key.
- Make prompt-stream cleanup unconditional so failed, rejected, and aborted streams cannot remain tracked.
- Bind browser updates to the run that created them, preventing an old run from changing progress or completion after a new run starts.
- Treat Insta Kill as cancellation across the whole render batch instead of converting it into ordinary failed panels.
- Keep timestamp parsing and prompt-to-line mapping unchanged.

## Verification
- Run focused type checks and a local browser test for kill/cancel and consecutive runs.
- Publish the fix, run a small script twice on the published website, and inspect fresh browser and server logs for no long retry wait, no stale completion, and no overlapping Agnes calls.

## Technical details
- Clamp `Retry-After`; error 1015 must use bounded backoff rather than provider-supplied multi-minute waits.
- Use one active Agnes call per server process and cancellation-aware waiting.
- Re-throw `KilledError` from batched panel work.
