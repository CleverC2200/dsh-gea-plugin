# Read-only GEA notifications

Status: implemented

The message inbox is a separate DSH panel using the current Host identity. It reads only the fixed GEA notification list and detail endpoints, projects display fields, preserves upstream totals and states, and rejects duplicate or mismatched identities. Changing environments aborts pending reads; opening a notification does not change its read or approval state.

This replaces the disabled inbox described in the forecast-surface composition note. GEA source references are displayed without interpreting them as local Session IDs. Source navigation and processing history need an authoritative mapping and are not implemented by this read-only panel. The notification tests use the real DSH profile and browser with a simulated external service; deployment acceptance remains separate.
