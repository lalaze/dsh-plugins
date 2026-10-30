// Tests run the client outside DSH's web shell; the shell's UI primitives resolve to a plain stand-in.
import { register } from 'node:module';
register('./resolve.mjs', import.meta.url);
