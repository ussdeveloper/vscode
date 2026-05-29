# Integrated Browser for HTTP(S) links

## Current behavior

- HTTP and HTTPS links from the terminal, chat markdown, extensions (`vscode.env.openExternal`), and other workbench openers route to the **Integrated Browser** by default in TheCoder.
- Non-HTTP(S) links (for example `file://`, `mailto:`) still use the normal system / workbench handlers.

## Settings

- `workbench.browser.openLinksInIntegratedBrowser` — default **on** in TheCoder; opens all HTTP(S) links in the Integrated Browser.
- `workbench.browser.openLocalhostLinks` — legacy fallback when the setting above is off; localhost / all-interfaces hosts only.

## Important files

- Link opener + default external opener: `src/vs/workbench/contrib/browserView/electron-browser/features/browserTabManagementFeatures.ts`
- Telemetry source: `src/vs/platform/browserView/common/browserViewTelemetry.ts` (`integratedBrowserLinkOpener`)
- Extension API external URI opener (when integrated browser command exists): `extensions/simple-browser/src/extension.ts`

## Why

- TheCoder treats the Integrated Browser as the primary in-app browser tool (agent browsing, dashboards, docs) instead of handing off to the OS browser.
