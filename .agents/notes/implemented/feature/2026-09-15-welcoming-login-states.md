# Login and desktop waiting states

The QR sign-in page preserves the existing GEA logo, environment choice, and request flow. It reserves the QR area while loading, distinguishes ready, expired, and failed states, and provides paired Chinese and English instructions for phone confirmation. Its only repeating motion is the pending QR indicator; reduced-motion preferences render it statically.

Desktop waiting pages receive an explicit operation from the existing lifecycle: initial startup, manual restart, applying a plugin update, or recovery of the previous graph. Update and recovery pages no longer describe first-time login. Failure details remain escaped and open by default; optional log guidance is collapsed while waiting. These presentation states do not change credential handling, backend health checks, plugin installation, or rollback behavior.

The client page can ship in a plugin release. Desktop waiting copy and its lifecycle context are included in the desktop archive and take effect with a later desktop package. Browser checks use isolated, synthetic QR responses and render all waiting states without starting the business application or repeating startup timing and synchronization diagnostics.
