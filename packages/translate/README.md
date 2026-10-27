# DSH Translate

**English** | [简体中文](README.zh-CN.md)

Supports English and Simplified Chinese, following DSH’s language setting with live updates. English is the fallback when the host has no locale service.

`dsh-translate` adds translation controls to DeepSeek Harness. It provides a translation API settings page, a composer button (also available with `Alt/Option+T`), a selection action for text in chat messages, and a translate button beside each message paragraph. Hover over a paragraph, list item, heading or quote and click the icon in its left margin; the translation appears in a card that follows the paragraph as you scroll. Click the icon again, the card’s ×, anywhere outside the card, or press Esc to close it. Double-click a word in a message to open the same card with its translation; the surrounding sentence is sent along so the word is translated in the sense it is used. Turn both off in **Settings → Translation**. The server calls any OpenAI-compatible Chat Completions endpoint, supports an optional fallback endpoint, and records token usage locally without storing source or translated text.

Build and install:

```sh
pnpm --filter dsh-translate check
pnpm --filter dsh-translate pack:plugin
dsh plugin --profile web add "$PWD/dist/dsh-translate-0.1.8.tgz"
```

Configure the API from **Settings → Translation**. The key is kept in the browser profile and sent only to the configured endpoint. Translation requests are limited to 5,000 characters and three concurrent calls.

Models matching the English-lock keywords (`claude, anthropic` by default) always translate drafts into English. When such a model is selected, sending a Chinese, Japanese or Korean draft with Enter or the send button first translates it into English, then sends the translation. A notice above the composer shows the progress, and confirms when the message has gone out translated. Press Esc to cancel. If the draft changes or translation fails, nothing is sent. Shift+Enter, IME composition and `/` commands are left alone. Turn this off in **Settings → Translation**.
