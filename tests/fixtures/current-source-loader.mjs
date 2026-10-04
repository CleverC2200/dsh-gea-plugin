/** Directed source tests resolve the declared owner package from its built sibling. */
import {registerHooks} from 'node:module';
registerHooks({resolve(specifier, context, next) {
  if (specifier === 'dsh-agent-manage/business-resources')
    return next(new URL('../../../dsh-agent-manage/lib/runtime/business-resources.js', import.meta.url).href, context);
  return next(specifier, context);
}});
