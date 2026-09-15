# Desktop release check scope

Routine desktop delivery selects checks for the changed code and verifies the package contents and digest. Startup timing, business API synchronization, and resource synchronization are issue-specific diagnostics. Their successful evidence is reused until the problem recurs or the user explicitly requests another diagnostic run.

The Windows installer workflow is manual-only. Its default path downloads and verifies an existing installer and installs it without fetching plugin fixtures, preparing a browser driver, or starting the application. The explicit `run_diagnostics` input retains the existing startup, synchronization, and plugin-switch investigation path. The installer must exist exactly once and appear in the checksum file before either path continues.

Source, lock, platform, company configuration, and resource snapshot identify the inputs to reuse. Commits, merges, and channel promotion do not require rebuilding unchanged packages. Final archives, digests, and build records are retained; unused intermediate payloads and isolated diagnostic copies can be removed after delivery without discarding dependency caches or user data.
