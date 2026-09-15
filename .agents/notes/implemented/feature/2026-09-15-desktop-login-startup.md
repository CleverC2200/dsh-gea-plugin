# Desktop login initialization

The Electron owner decrypts saved login state after the previous backend stops and before the next backend starts. The private login endpoint serves that in-memory snapshot, and successful saves or explicit logout update it after persistence completes. System credential prompts therefore do not consume the backend's five-second loopback request timeout. Storage errors still stop startup and preserve the encrypted file.

Desktop 0.0.7 can exit with a GEA plugin initialization TimeoutError when synchronous credential access takes longer than the backend request timeout. An isolated real-Electron regression delays only the OS decryption seam by eight seconds and checks that the actual bundled backend restores a fixture identity, opens the workbench, and leaves the encrypted file intact. This reproduces the reported exit code and error class; the original user's single failure log does not establish why their credential request was delayed.
