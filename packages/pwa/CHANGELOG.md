# Changelog

## 0.1.0 — Dark manifest colors for installed mobile Web Apps

- Serves `/manifest.webmanifest` from DSH's `webServer` with `theme_color` and `background_color` set to `#151517` (configurable) instead of DSH's white, keeping every other field of DSH's own `manifest.webmanifest` and following it across DSH upgrades.
- No built-in manifest: the route stays DSH's until DSH's file has been read, and a file that later goes missing or stops parsing keeps the last good copy.
- Changes nothing on the page: no styles, and `<meta name="theme-color">` stays DSH's.
