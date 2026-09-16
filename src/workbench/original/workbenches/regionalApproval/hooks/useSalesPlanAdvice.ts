/** 改编自 AionUi（Apache-2.0）：已替换为本地导入并使用显式 DSH Host 适配器，见 SOURCE.md。 */
import { modelInference } from '../../../bridge.ts';
import { BackendHttpError } from '../../../http-error.ts';
import { useEffect, useRef, useState } from 'react';

type AdviceStatus =
  | 'ready'
  | 'idle'
  | 'loading'
  | 'partial'
  | 'noAnswer'
  | 'noModel'
  | 'toolsRequired'
  | 'failed'
  | 'timeout'
  | 'unavailable'
  | 'invalidResponse'
  | 'authentication'
  | 'rateLimited';
export type SalesPlanAdviceState = {
  key: string;
  status: AdviceStatus;
  answers: Record<string, string>;
  completed: number;
  total: number;
};
const empty = (key: string, status: AdviceStatus): SalesPlanAdviceState => ({
  key,
  status,
  answers: {},
  completed: 0,
  total: 0,
});

/** 无状态推理：每批五行、同时运行两批，不创建聊天 Session。 */
export const useSalesPlanAdvice = (scope: string | undefined, prompt: string) => {
  const key = JSON.stringify([scope, prompt]);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<SalesPlanAdviceState>(empty('', 'idle'));
  const completedAdvice = useRef<{ key: string; answers: Record<string, string> } | undefined>(undefined);
  useEffect(() => {
    if (!scope) {
      completedAdvice.current = undefined;
      return;
    }
    let active = true;
    const retrying = completedAdvice.current?.key === key && revision > 0;
    const answers: Record<string, string> = retrying ? { ...completedAdvice.current!.answers } : {};
    completedAdvice.current = { key, answers };
    let payload: Record<string, unknown> | undefined;
    try {
      const value = JSON.parse(scope);
      if (value && Array.isArray(value.rows)) payload = value;
    } catch {
      /* 继续支持不透明的 scope。 */
    }
    const rows = (payload?.rows ?? []) as Array<{ id: string; [key: string]: unknown }>;
    const aliases = new Map(rows.map((row, index) => ['r' + index, row.id]));
    const pendingRows = rows
      .map((row, index) => ({ ...row, id: 'r' + index }))
      .filter((row) => !answers[aliases.get(row.id)!]);
    const batchSize = retrying ? 1 : 5;
    const batches =
      payload && rows.length
        ? Array.from({ length: Math.ceil(pendingRows.length / batchSize) }, (_, index) => {
            const batchRows = pendingRows.slice(index * batchSize, index * batchSize + batchSize);
            return {
              question: prompt + '\n' + JSON.stringify({ ...payload, rows: batchRows }),
              ids: batchRows.map((row) => row.id),
            };
          })
        : [{ question: prompt + '\n' + scope, ids: [] as string[] }];
    const failures: AdviceStatus[] = [];
    const controllers = new Set<AbortController>();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    let next = 0;
    let settled = 0;
    setState({
      key,
      status: batches.length ? 'loading' : 'ready',
      answers: { ...answers },
      completed: Object.keys(answers).length,
      total: rows.length,
    });
    const launch = () => {
      if (!active || next >= batches.length) return;
      const batch = batches[next++];
      const controller = new AbortController();
      controllers.add(controller);
      let done = false;
      const finish = (status: AdviceStatus, result: Record<string, string> = {}) => {
        if (!active || done) return;
        done = true;
        clearTimeout(timer);
        timers.delete(timer);
        controllers.delete(controller);
        if (status !== 'ready') failures.push(status);
        if (batch.ids.length) {
          for (const alias of batch.ids) {
            const id = aliases.get(alias)!;
            if (result[alias]?.trim()) answers[id] = result[alias];
            else if (status === 'ready') failures.push('noAnswer');
          }
        } else Object.assign(answers, result);
        settled++;
        const completed = Object.keys(answers).length;
        setState({
          key,
          answers: { ...answers },
          completed,
          total: rows.length,
          status:
            settled < batches.length
              ? 'loading'
              : failures.length
                ? completed
                  ? 'partial'
                  : failures[0]
                : completed
                  ? 'ready'
                  : 'noAnswer',
        });
        launch();
      };
      const timer = setTimeout(() => {
        controller.abort();
        finish('timeout');
      }, 60000);
      timers.add(timer);
      void modelInference
        .invoke({ question: batch.question, signal: controller.signal })
        .then((response) => {
          if (response.status !== 'ok') {
            finish(response.status);
            return;
          }
          const raw = (response.answer ?? '')
            .trim()
            .replace(/^```(?:json)?\s*/, '')
            .replace(/\s*```$/, '');
          const value: unknown = JSON.parse(raw);
          if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid advice');
          finish(
            'ready',
            Object.fromEntries(
              Object.entries(value).filter(
                (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim().length > 0
              )
            )
          );
        })
        .catch((error: unknown) =>
          finish(
            error instanceof BackendHttpError
              ? /MODEL_NOT_SELECTED|GEA_ADVICE_MODEL_REQUIRED/.test(error.code)
                ? 'noModel'
                : error.status === 401 || error.code.includes('401') || error.code === 'LOGIN_REQUIRED'
                  ? 'authentication'
                  : error.status === 429 || /429|RATE_LIMIT|TOO_MANY_REQUESTS/.test(error.code) ? 'rateLimited'
                  : error.code.includes('INCOMPLETE') ? 'noAnswer'
                  : /TIMEOUT|TIMED_OUT/.test(error.code) ? 'timeout'
                  : error.status === 404 || error.status >= 500 || /UNAVAILABLE|UPSTREAM/.test(error.code)
                  ? 'unavailable'
                  : 'failed'
              : error instanceof SyntaxError ? 'invalidResponse' : 'failed'
          )
        );
    };
    for (let index = 0; index < Math.min(2, batches.length); index++) launch();
    return () => {
      active = false;
      controllers.forEach((controller) => controller.abort());
      timers.forEach((timer) => clearTimeout(timer));
    };
  }, [key, scope, prompt, revision]);
  return {
    state: !scope ? empty(key, 'idle') : state.key === key ? state : empty(key, 'loading'),
    retry: () => setRevision((value) => value + 1),
  };
};
