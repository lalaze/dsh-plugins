# Third-party notices

The browser artifact bundles this workspace’s private `@dsh-plugins/i18n` and `@dsh-plugins/file-view` helpers, and the Git panel ported from `@xbzbing/dsh-git-panel` (see below). React, React DOM and DSH host modules, including `@deepseek-ai/dsh-client-ui-primitives`, remain external; the server entry uses Node.js and DSH host services. Git is invoked as an external executable and is not bundled.

[lib/editor.js](lib/editor.js), the on-demand code and diff editor, is built from [Monaco Editor](https://github.com/microsoft/monaco-editor) (`monaco-editor` 0.57.0, MIT License, Copyright (c) 2016 - present Microsoft Corporation). Its license and the notices of its included components, including marked (MIT) and DOMPurify (used under Apache License 2.0), are shipped in [lib/editor-notices.txt](lib/editor-notices.txt) by the editor build.

[lib/client.mermaid.js](lib/client.mermaid.js), loaded only to draw mermaid diagrams in previewed Markdown, is built from [mermaid](https://github.com/mermaid-js/mermaid) 12.2.0 (MIT) and the packages it includes, some under the Apache License 2.0, EPL-2.0, BSD-3-Clause, MPL-2.0 or Unlicense. Each package's license text is shipped in [lib/client.mermaid-notices.txt](lib/client.mermaid-notices.txt) by the build.

Source comments also reference GitLens/gitk and VS Code for interaction or visual conventions. These acknowledgments do not assert verified feature parity, affiliation or endorsement. When regenerating this file, pass the introductory, ported-source and upstream attribution sections to the generator again so they are retained.

## dsh-git-panel by xbzbing (MIT)

The Git panel under `src/gp/` (its client in the browser bundle, its host in `lib/server/gp/`) is ported from [`@xbzbing/dsh-git-panel`](https://github.com/xbzbing/dsh-git-panel) 1.10.0, commit `3e7c566`. Changes: its requests go to this plugin's route instead of a typert service, its commands and file reads run through this plugin's local and Remote Agents runners (`src/gp-host.ts`), its identities and settings are this plugin's, its version check is removed, and its mermaid module loads where no module loader is present. Its license:

MIT License

Copyright (c) 2026 xbzbing

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dsh-git-panel acknowledgment (MIT)

[dsh-git-panel](https://github.com/a792883583/dsh-git-panel), by Jaden Tang, is an upstream UI reference; this package’s icon source specifically acknowledges its style. The upstream [license](https://github.com/a792883583/dsh-git-panel/blob/main/LICENSE) is reproduced below. This acknowledgment does not assert that every upstream feature has been ported or verified, nor that all referenced designs are copied source.

Copyright (c) 2026 dsh-git-panel contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

The browser bundle includes the packages below, each under the license of its section; their copyright notices are listed with them. Regenerate this file with `node ../../scripts/third-party-notices.mjs`.

## MIT License

- `bail` 2.0.2: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `ccount` 2.0.1: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `comma-separated-tokens` 2.0.3: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `decode-named-character-reference` 1.3.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `devlop` 1.1.0: Copyright (c) 2023 Titus Wormer <tituswormer@gmail.com>
- `escape-string-regexp` 5.0.0: Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
- `estree-util-is-identifier-name` 3.0.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `extend` 3.0.2: Copyright (c) 2014 Stefan Thomas
- `hast-util-to-jsx-runtime` 2.3.6: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `hast-util-whitespace` 3.0.0: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `html-url-attributes` 3.0.1: Copyright (c) Titus Wormer
- `inline-style-parser` 0.2.7: Copyright (c) 2012 TJ Holowaychuk <tj@vision-media.ca>
- `is-plain-obj` 4.1.0: Copyright (c) Sindre Sorhus <sindresorhus@gmail.com> (https://sindresorhus.com)
- `longest-streak` 3.1.0: Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>
- `markdown-table` 3.0.4: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-find-and-replace` 3.0.3: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-from-markdown` 2.1.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-gfm` 3.1.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-gfm-autolink-literal` 2.0.1: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `mdast-util-gfm-footnote` 2.1.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-gfm-strikethrough` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-gfm-table` 2.0.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `mdast-util-gfm-task-list-item` 2.0.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `mdast-util-phrasing` 4.1.0: Copyright (c) 2017 Titus Wormer <tituswormer@gmail.com>
- `mdast-util-to-hast` 13.2.1: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `mdast-util-to-markdown` 2.2.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `mdast-util-to-string` 4.0.0: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `micromark` 4.0.3: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-core-commonmark` 2.0.4: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm` 3.0.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm-autolink-literal` 2.1.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm-footnote` 2.1.0: Copyright (c) 2021 Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm-strikethrough` 2.1.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm-table` 2.1.2: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm-tagfilter` 2.0.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `micromark-extension-gfm-task-list-item` 2.1.0: Copyright (c) 2020 Titus Wormer <tituswormer@gmail.com>
- `micromark-factory-destination` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-factory-label` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-factory-space` 2.1.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-factory-title` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-factory-whitespace` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-character` 2.1.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-chunked` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-classify-character` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-combine-extensions` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-decode-numeric-character-reference` 2.0.2: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-decode-string` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-edit-map` 1.0.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-encode` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-html-tag-name` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-normalize-identifier` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-resolve-all` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-sanitize-uri` 2.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `micromark-util-subtokenize` 2.1.0: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `property-information` 7.2.0: Copyright (c) Titus Wormer <mailto:tituswormer@gmail.com>
- `react-markdown` 10.1.0: Copyright (c) Espen Hovlandsdal
- `remark-gfm` 4.0.1: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `remark-parse` 11.0.0: Copyright (c) 2014 Titus Wormer <tituswormer@gmail.com>
- `remark-rehype` 11.1.2: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `space-separated-tokens` 2.0.2: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `style-to-js` 1.1.21: Copyright (c) 2020 Menglin "Mark" Xu <mark@remarkablemark.org>
- `style-to-object` 1.0.14: Copyright (c) 2017 Menglin "Mark" Xu <mark@remarkablemark.org>
- `trim-lines` 3.0.1: Copyright (c) 2015 Titus Wormer <mailto:tituswormer@gmail.com>
- `trough` 2.2.0: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `unified` 11.0.5: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `unist-util-is` 6.0.1: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `unist-util-position` 5.0.0: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `unist-util-stringify-position` 4.0.0: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `unist-util-visit` 5.1.0: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `unist-util-visit-parents` 6.0.2: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>
- `vfile` 6.0.3: Copyright (c) 2015 Titus Wormer <tituswormer@gmail.com>
- `vfile-message` 4.0.3: Copyright (c) Titus Wormer <tituswormer@gmail.com>
- `zwitch` 2.0.4: Copyright (c) 2016 Titus Wormer <tituswormer@gmail.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## ISC License

- `@ungap/structured-clone` 1.4.0: Copyright (c) 2021, Andrea Giammarchi, @WebReflection

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
