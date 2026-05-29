# Retry And Image Handling

## Retry rules

- Length limit failures get one retry with a reduced completion budget.
- Image rejection failures get a retry path that removes direct image input or replaces it with a description.

## User-facing behavior

- Show a warning instead of a hard error when the retry can recover the request.
- Keep the message short and explicit so the user understands what happened.

## Files to update together

- `extensions/copilot/src/extension/prompt/common/lengthLimitRetry.ts`
- `extensions/copilot/src/extension/prompt/common/imageApiRetry.ts`
- `extensions/copilot/src/extension/prompt/node/chatMLFetcher.ts`
- `extensions/copilot/src/extension/prompt/node/pseudoStartStopConversationCallback.ts`

## Maintenance note

- If the retry shape changes, update this document and the matching code path together.
