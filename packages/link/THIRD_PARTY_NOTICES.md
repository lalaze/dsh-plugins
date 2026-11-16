# Third-party notices

## Kivotos

DSH Link (dsh-link) is an independent implementation of the approach of Kivotos (https://github.com/dsh-labs/kivotos, Apache License 2.0, Copyright the Kivotos authors): admitting tailnet requests by `tailscale whois`, forwarding into the local DSH with an in-process login cookie, mounting other machines under a path prefix, and the restart helper's hand-off.

The desktop boot guard in `src/rewrite.ts` (`guardDesktopBoot`), the per-machine localStorage namespace and the file intake in `src/client/peer-files.ts` follow Kivotos' `src/dsh/desktop.ts`, `src/dsh/sessions.ts` and `src/dsh/peer-files.ts` closely, because both depend on the same DSH 0.2.2 internals. Kivotos is licensed under the Apache License, Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
