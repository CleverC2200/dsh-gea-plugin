# HTML contract regression ownership

Workbench owns HTML discovery and frame presentation. GEA keeps identity observation,
credentials, capability admission and Host authorization. The removed GEA
`registerHtmlClient` is not a supported presentation entry point.

The two GEA suite adapters execute the fixed Workbench owner in its own prepared
dependency layout. They verify its commit and tracked test bytes, propagate the real
exit code, require a nonempty result, and reject any failure, cancellation, skip or todo.
They do not implement a replacement HTML client or grant authority.

| Previous assertion | Current owner assertion |
| --- | --- |
| First ready while opening a replacement Session | `html-frame-contract.test.mjs`: latest opening receives one connection |
| Two consecutive replacements, repeated ready, late completion | Three-generation opening test; obsolete owners close and only the latest Session connects |
| Ready without a valid Session | Absent association remains available for later valid binding |
| Unmount during first opening | Pending opening transfers no port and releases its Session |
| Managed request carrying an obsolete Session | Session replacement rejects both the old port and an old Session on the new port; current request uses the new owner |
| Page values, scroll, marker and prompt/register/close continuity | Session replacement retains the iframe and UI state, binds the current Session, closes the obsolete owner and preserves the Core draft |
| Theme source, current Session and listener cleanup | Current owned port/theme projection test, including context withdrawal and unmount cleanup |
| Shipped sample query controls and four rows | Actual standalone sample renders its original four rows without an invented business lease |
| Every declared page and preset identity | Current catalog preserves each page's declared `resourceId`; demo pages without a resource do not create or select a Session |
| Hidden page | `html-pages.test.mjs`: `visible:false` hides the catalog entry while retaining the installed package, resource and HTML |
| No second identity observation | Catalog discovery reads only the current Workbench endpoint; GEA identity observer tests remain in the GEA suite |
| HTTP/network failure, no polling and cleanup | Discovery failure stays visible until explicit retry; unmount removes the slot, aborts the request and rejects a late catalog response |

The old assertion that the same port survives across Session generations is expressed
by retained page/UI state plus revocation of the old port and ownership by the new
generation. It must not restore authority across Session generations. The old demo
fallback to `auto-negotiation` is expressed by the current explicit association rule;
discovery and display must not silently create or select a hidden resource.

Branch inventory's assembled MCP is compared with the independently frozen Manage
owner and with the original FC contract at
`906b3b08947b71cecf627073c0b0e9a389b692bf:mcp.json` (Git blob
`80ec24ef18810e43dea3ea33ae57b528b02a0b02`, SHA256
`56fee7836b133f8d3e0c3bc97b2b2e140b071b345c452682894f6dd47c684e5d`).
Only the declared protocol migration from `gea-html-v1` to `gea-html-v2` is allowed.
