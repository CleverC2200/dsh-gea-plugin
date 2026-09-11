# Agent Note: Keep the GEA approval workspace read-only

Status: implemented

## Context

The business reference uses a three-column approval workbench with organization navigation, a plan queue, and an analysis panel. The GEA endpoints currently verified by this plugin provide read-only plan data, but do not provide a stable user-scoped approval-node write contract.

## Decision

The plugin now presents the workbench frame and organization selectors while keeping every approval control read-only. Summary values use the selected page data, unknown upstream fields remain visibly unknown, and the analysis action sends only the selected plan snapshot through the existing dsh Session path. Table rows keep plan/version identifiers, organization, type/status, quantities, amounts, and update time visible.

## Rejected alternatives

The plugin does not fabricate node progress, approval permissions, save, pass, return, or notification state. Those controls require a confirmed GEA contract and user-scoped permissions. It also does not change dsh core or introduce an AionUi runtime dependency.

## Verification

The Web regression covers the approval heading, organization selection, read-only banner, disabled pre-preview handoff, and durable Session receipt. Typechecking, build, and the full keyless suite pass.

## Limits

The frame is a visual migration step. Node statuses, write actions, notification inboxes, and production acceptance remain open work tracked by the plugin issues.
