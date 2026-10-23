# DSH Translate

`dsh-translate` adds translation controls to DeepSeek Harness. It provides a translation API settings page, a composer button (also available with `Alt/Option+T`), and a selection action for text in chat messages. The server calls any OpenAI-compatible Chat Completions endpoint, supports an optional fallback endpoint, and records token usage locally without storing source or translated text.

Build and install:

```sh
pnpm --filter dsh-translate check
pnpm --filter dsh-translate pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-translate-0.1.0.tgz"
```

Configure the API from **Settings → 翻译**. The key is kept in the browser profile and sent only to the configured endpoint. Translation requests are limited to 5,000 characters and three concurrent calls.
