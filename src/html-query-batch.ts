export async function readHtmlBatch(input: unknown, read: (query: Record<string, unknown>) => Promise<unknown>, options: {compactRows?: boolean} = {}) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 8 ||
      input.some(q=>!q || typeof q !== 'object' || Array.isArray(q) || typeof q.sql !== 'string' || 'queries' in q))
    throw Error('INVALID_SQL_BATCH');
  const results = await Promise.all(input.map(async query=>{
    try {
      const value = await read(query);
      if (options.compactRows && value && typeof value === 'object' &&
          'rows' in value && 'records' in value && Array.isArray(value.rows) && value.records === value.rows) {
        const {records, ...compact} = value;
        return {ok:true, value:compact};
      }
      return {ok:true, value};
    }
    catch(error) { return {ok:false, error:error instanceof Error ? error.message : 'GEA_SQL_QUERY_FAILED'}; }
  }));
  return {results};
}
