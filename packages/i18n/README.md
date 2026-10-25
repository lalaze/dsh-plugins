# Plugin localization

Private build-time helpers for English-first DSH plugins. Client bundles include this code;
installed plugins do not depend on a separately published shared package.

Register each plugin's English/Chinese dictionary with the optional DSH `locale` service in a
context effect. React roots subscribe with `useLocale`; DOM integrations subscribe directly and
redraw when the locale changes. Without the host service, English is used. Keep API messages in
English and translate known messages at display time so existing errors also follow live switches.
