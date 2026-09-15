# GEA Desktop business distribution

GEA Desktop 0.0.5 provisions company deployment settings, an offline company suite catalog, and an archive refresh URL without asking business users for GitHub repository details or credentials. Existing resource checkouts and account/session data survive application restarts and plugin updates. Suites remain selectable in Agent Manage; startup does not automatically enable new capabilities.

The desktop release channel is separate from the earlier channel whose compatibility list excludes Desktop 0.0.4. Its stable and test assets explicitly declare Desktop 0.0.5 and the bundled company plugin versions. Immutable package digests remain the authority for downloads.

A CPU profile of the released DSH runtime showed browser combo composition and identity source-map generation dominating repeated startup. The distribution build minifies browser registrations and ships compact precomputed maps; it does not modify DSH Host code. The payload retains archive/lock inputs for the official staging installer and removes the unused third-party UI bundle root. Each transformed client artifact has a before/after digest receipt. Source-map preparation belongs to packaging, so it also works on Windows without a first-launch compiler.

Validation covers first launch without configuration, offline source discovery, live anonymous source refresh, plugin preparation and restart, user-data preservation, and MCP discovery/call/logout through the model loop. macOS startup timing is measured independently of builds. Windows native binaries are checked for the target architecture; cross-building does not establish Windows installation or launch latency.

The NSIS installer retains the default 7z format. Direct ZIP extraction exceeded the 600-second Windows installation limit; the compact 7z candidate completed in 177 seconds. Package size and file-count reductions remain the installation optimization. Agent Manage 0.6.3-company.4 uses platform path separators and sequential validated ZIP writes, preserving traversal rejection without exhausting file handles.

Plugin preparation runs pnpm install in the private staging graph before adding an artifact. pnpm reconciles builder-specific store paths and platform-specific directory settings; pnpm add alone rejects those differences. The staging install allows lock reconciliation after pinning the official versions and ignores lifecycle scripts. It can recreate staged dependencies, while the active graph and user data remain untouched.
