/** Validate the public deployment before credentials or runtime state are used. */
export function validateSqlReadLimit(config) {
  if (config === undefined) return;
  if (
    !config ||
    Array.isArray(config) ||
    typeof config !== "object" ||
    Object.keys(config).some(
      (key) =>
        !["consumerCode", "maxRequests", "maxPagesPerQuery", "maxRowsPerQuery"].includes(key),
    ) ||
    !/^[a-z][a-z0-9-]+$/.test(config.consumerCode ?? "") ||
    !Number.isSafeInteger(config.maxRequests) ||
    config.maxRequests < 0 ||
    !Number.isSafeInteger(config.maxPagesPerQuery) ||
    config.maxPagesPerQuery < 1 ||
    !Number.isSafeInteger(config.maxRowsPerQuery) ||
    config.maxRowsPerQuery < 1
  )
    throw Error("INVALID_SQL_READ_LIMIT");
}

/** A fixed Host lifetime shares one physical SQL allowance, including retries. */
export function createSqlReadLimit(config) {
  validateSqlReadLimit(config);
  if (config === undefined) return undefined;
  const { consumerCode: allowedConsumer, maxRequests, maxPagesPerQuery, maxRowsPerQuery } = config;
  let spent = 0;
  const fail = (code, message) => {
    throw Object.assign(Error(message), { code, retryable: false });
  };
  const assertAvailable = (consumerCode) => {
    if (consumerCode !== allowedConsumer)
      fail("GEA_SQL_CONSUMER_LIMIT", "本次只读范围未开放这个业务");
    if (spent >= maxRequests) fail("GEA_SQL_REQUEST_LIMIT", "本次读取额度已用完，未发出额外查询");
  };
  return {
    assertAvailable,
    maxRows: maxRowsPerQuery,
    maxPages: maxPagesPerQuery,
    beforeRequest() {
      assertAvailable(allowedConsumer);
      spent++;
    },
  };
}
