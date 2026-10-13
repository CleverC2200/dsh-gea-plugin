/** Validate calendar dates once while preserving each receipt format contract. */
export function normalizeReceiptTime(value) {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
    !Number.isFinite(Date.parse(value))
  )
    return null;
  const calendar = new Date(`${value.slice(0, 10)}T00:00:00.000Z`);
  return calendar.toISOString().slice(0, 10) === value.slice(0, 10)
    ? new Date(value).toISOString()
    : null;
}

export function isObservationTime(value) {
  return (
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) &&
    normalizeReceiptTime(value) === value
  );
}
