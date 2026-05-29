# TheCoder Extra Docs

This folder is a short, living memory for the current TheCoder fork work.
Use it to avoid re-reading large parts of the repo when continuing the same line of work.

## What belongs here

- Current behavior we changed
- Why a change exists
- Important file paths and integration points
- Small notes about trade-offs or follow-up tasks

## How to use it

- Prefer updating these docs when a change lands in the codebase.
- Keep entries short and high-signal.
- Link to exact files instead of re-explaining the whole implementation.
- When the behavior changes, update this folder before digging through the code again.

## Index

- `thecoder-current-state.md` - compact snapshot of the implemented behavior
- `vision-fallback.md` - image description fallback flow and settings
- `retry-and-image-handling.md` - response-length retry and image rejection handling
- `model-management-notes.md` - settings/model picker behavior and related UX notes
- `integrated-browser-links.md` - HTTP(S) links open in the Integrated Browser by default
- `terminal-sensitive-input.md` - no chat block on terminal password prompts
