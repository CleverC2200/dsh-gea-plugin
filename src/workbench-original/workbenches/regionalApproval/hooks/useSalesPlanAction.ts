/** Adapted from AionUi (Apache-2.0): local imports and explicit DSH host adapter. See SOURCE.md. */
import { salesPlan, type GeaSalesPlanActionReceipt } from '../../../bridge.ts';
import { useCallback, useRef, useState } from 'react';
import {
  SalesPlanActionAttempt,
  classifySalesPlanActionError,
  type SalesPlanActionClient,
  type SalesPlanActionError,
  type SalesPlanActionInput,
} from '../models/salesPlanActionModel.ts';

export type SalesPlanActionState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'success'; receipt: GeaSalesPlanActionReceipt }
  | { status: 'error'; error: SalesPlanActionError };

export const useSalesPlanAction = ({ client = salesPlan }: { client?: SalesPlanActionClient }) => {
  const attempt = useRef(new SalesPlanActionAttempt(client));
  const operation = useRef(0);
  const [state, setState] = useState<SalesPlanActionState>({ status: 'idle' });

  const settle = useCallback(async (promise: Promise<GeaSalesPlanActionReceipt>) => {
    const current = ++operation.current;
    setState({ status: 'loading' });
    try {
      const receipt = await promise;
      if (operation.current === current) setState({ status: 'success', receipt });
      return receipt;
    } catch (error) {
      const classified = classifySalesPlanActionError(error);
      if (operation.current === current) setState({ status: 'error', error: classified });
      throw classified;
    }
  }, []);

  return {
    state,
    execute: (input: SalesPlanActionInput) => {
      try {
        return settle(attempt.current.submit(input));
      } catch (error) {
        return settle(Promise.reject(error));
      }
    },
    retry: () => settle(attempt.current.retry()),
  };
};
