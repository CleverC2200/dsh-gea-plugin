# Agent Note: Keep the forecast surface separate from dsh chat ownership

Status: implemented

## Context

The AionUi reference composes a GEA business surface from a business navigation column, an independent sales-plan workbench, and a dsh conversation rail. The plugin previously kept these responsibilities in one `client.tsx` component and rendered a plugin-owned composer in the rail.

## Decision

`src/forecast-surface.tsx` now owns the business-surface interfaces and components: `BusinessNavigation`, `BusinessMessageInbox`, `SalesPlanWorkbench`, `ForecastConversationRail`, and `ForecastAssistantSurface`. Query, login, preview, and Session ownership stay in `client.tsx`. The rail accepts an optional host-provided `nativeConversation` node and reports whether that slot is pending or mounted; the fallback is status-only and does not imitate dsh ChatView.

## Rejected alternatives

The plugin does not create a second chat implementation, route arbitrary messages through a local textarea, or claim that the DSH native conversation rail is mounted. The message-inbox entry remains disabled until its GEA data contract and host route are available.

## Verification

The Web regression checks the forecast rail marker and `native-host-pending` state. `npm run typecheck`, `npm run build`, `npm test`, and `git diff --check` pass.

## Limits

The host still needs to expose an official ChatSurface injection point before the native right rail can be mounted. The current composition is an adapter seam, not proof of native chat integration.
