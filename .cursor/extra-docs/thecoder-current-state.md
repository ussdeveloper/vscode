# TheCoder Current State

## Main ideas

- TheCoder is a BYOK-first fork of VS Code with extra chat UX and model tooling.
- We keep the implementation narrow and document the current behavior here instead of re-reading the whole repo every time.

## Implemented behavior

- Length-limit retries: when a model stops with `finish_reason=length`, the request retries once with a smaller budget and a warning.
- Image handling: images are attached when the endpoint supports vision; if the API rejects them, the request retries without direct image input.
- Vision fallback: if the selected model cannot use images, a separate vision-capable model can describe the image and the description is injected back into the main prompt.
- Integrated Browser links: HTTP(S) links from terminal, chat, and extensions open in the Integrated Browser by default (`workbench.browser.openLinksInIntegratedBrowser`).

## Important file groups

- Retry / image logic: `extensions/copilot/src/extension/prompt/common/` and `extensions/copilot/src/extension/prompt/node/`
- Vision fallback settings: `extensions/copilot/src/extension/byok/vscode-node/imageDescriptionService.ts`
- Settings / picker wiring: `src/vs/workbench/contrib/chat/browser/`
- TheCoder-specific settings and contributions: `extensions/copilot/package.json` and `extensions/copilot/src/extension/byok/vscode-node/byokContribution.ts`

## Working rule

- When a change affects one of the behaviors above, update this file and the relevant topic doc in `.cursor/extra-docs/` in the same change.
