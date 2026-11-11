# Third-party notices

The browser artifact bundles this workspace's private `@dsh-plugins/i18n` helper and the private `@dsh-plugins/remote-core`, which the server includes too. React, React DOM and DSH host modules remain external peer dependencies. Coding CLIs execute separately on the remote machine under their own terms.

The interaction model follows [Paseo](https://github.com/getpaseo/paseo); no Paseo source, SDK or runtime dependency is included.

The Codex logo in `src/client/tui.tsx` is adapted from [`@lobehub/icons-static-svg`](https://github.com/lobehub/lobe-icons) (1.102.0, MIT License, Copyright (c) 2023 LobeHub).

`lib/terminal-holder.mjs`, which runs on SSH hosts, bundles `@xterm/headless` 6.0.0 and `@xterm/addon-serialize` 0.14.0, each under the MIT License: Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js).

`lib/client.js` bundles `@xterm/addon-webgl` 0.19.0 under the MIT License: Copyright (c) 2017-2019, The xterm.js authors (https://github.com/xtermjs/xterm.js).

The browser bundle includes the packages below, each under the license of its section; their copyright notices are listed with them. Regenerate this file with `node ../../scripts/third-party-notices.mjs`.

## MIT License

- `@phosphor-icons/react` 2.1.10: Copyright (c) 2020 Phosphor Icons
- `@xterm/addon-webgl` 0.19.0: Copyright (c) 2018, The xterm.js authors (https://github.com/xtermjs/xterm.js)

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
