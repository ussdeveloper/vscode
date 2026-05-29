# Vision Fallback Flow

## Goal

When the active chat model cannot accept images, TheCoder should still let the user work with screenshots and attachments by converting the image into text first.

## Flow

1. Detect that the current endpoint cannot use vision, or that the provider rejected the image.
2. Resolve a separate vision-capable model from TheCoder settings.
3. Send the image plus the current user task context to that model.
4. Inject the generated description into the original chat prompt.
5. Retry the request with text only.

## Settings

- `thecoder.vision.useDescriptionModel` - master on/off switch.
- `thecoder.vision.descriptionModel` - dropdown of available vision-capable models.

## Prompting rule

- The description request must include the current user task context.
- The output should emphasize what the main model needs to know: UI text, errors, visible controls, and any OCR-like content.

## Notes

- Keep the description short enough to fit the chat flow, but detailed enough to replace the image.
- If there is no description model configured, auto-pick the first available vision-capable model.
