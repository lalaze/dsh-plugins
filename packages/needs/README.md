# Plugins a plugin needs

Private build-time helpers for a DSH plugin whose page depends on another plugin. Client bundles
include this code; installed plugins do not depend on a separately published shared package.

`offerFor` looks a plugin up in the plugin markets the person has added to DSH and says what can be
done about it: install it, update it, or nothing because it is there already or no market lists it.
`install` runs that through DSH's own plugin manager, as the Plugins page does. Both go through the
client's `remote` service, so they work in the desktop application and in a browser alike.

`usePluginOffer` wraps the two for a React page. The page draws its own notice and button in its
own style and language.
