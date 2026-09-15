# GEA 0.0.18

Scope: recover expired MCP transport sessions and guide invalid local skill references.
Base: GitLab main 4ef1527 (GEA 0.0.17). Preserve tool source routing and all existing release features.

Validation: 15 gateway/skill tests passed, including concurrent reconnect, retry bounds,
logout cancellation, source routing and visible skill catalog. Typecheck and build passed.
The live GEA transport endpoint reproduced empty HTTP 404 after closing the diagnostic
session; the patched SDK recovered and completed two subsequent pings. No business
queries or credentials were used in that transport probe.

Dependencies, package allowlist and runtime entry points are unchanged; only the root
package version changes in the shrinkwrap. Retain the previously published 0.0.17 host
compatibility combinations and installation path. No desktop shell update is included.
The original desktop business conversation has not been replayed.

Publication target: test and stable, fixed source tag gea-v0.0.18.
Artifact digest and download location are recorded in the source GitLab Release and
public distribution index after packaging the merged main commit.
