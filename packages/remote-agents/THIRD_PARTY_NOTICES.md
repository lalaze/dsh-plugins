# Third-party notices

This package embeds the Claude SSH engine and browser integration from this repository's `dsh-claude-ssh`, based on [Oh My Claude](https://github.com/lcestou/dsh-oh-my-claude) by lcestou. Its MIT license, upstream revision and third-party notices are included at `lib/claude/LICENSE`, `lib/claude/UPSTREAM.md` and `lib/claude/THIRD_PARTY_NOTICES.md`. Those notices apply to both the embedded server and bundled browser code.

The browser artifact bundles this workspace's private `@dsh-plugins/i18n` helper. React, React DOM and DSH host modules remain external peer dependencies. CLI programs execute separately on the remote machine under their own terms.

No Paseo source, SDK or runtime dependency is included.
