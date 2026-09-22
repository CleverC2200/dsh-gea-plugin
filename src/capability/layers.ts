/**
 * 能力层：把"对话能做什么"切成几层，每层一套统一策略——限流、超时、回执、执行前确认、
 * 是否会写业务数据。模块只声明"我有哪几层"，执行侧统一按这张表执行。
 *
 * 之前这些参数散在三处：草稿层（限流/回执）、页面桥（动作超时）、只读工具（读取超时），
 * 各自写各自的数。这里收成一份，改一处就是改所有模块。
 *
 * 只放"策略数值"，不认识任何具体业务，也不执行任何动作。
 */

/** 影响等级（与契约里的 effect 同一套名字，这里避免反向依赖）。 */
export type LayerEffect = "view" | "draft" | "submit" | "approve";

export const CAPABILITY_LAYERS = [
  "read",
  "draft",
  "submit",
  "approve",
  "export",
] as const;
export type CapabilityLayer = (typeof CAPABILITY_LAYERS)[number];

export type LayerPolicy = {
  /** 这一层要不要在宿主侧留回执（可追溯"刚才那次到底怎么了"）。 */
  receipt: boolean;
  /** 单次调用超时（毫秒）。 */
  timeoutMs: number;
  /** 同一个会话在这一层每分钟最多多少次。 */
  maxPerMinute: number;
  /** 执行前是否必须复述对象 + 动作 + 依据（写业务数据的两层要）。 */
  confirm: boolean;
  /** 会不会改业务数据（只读与改草稿都不改）。 */
  writes: boolean;
};

export const LAYER_POLICY: Record<CapabilityLayer, LayerPolicy> = {
  read: {
    receipt: false,
    timeoutMs: 60_000,
    maxPerMinute: 120,
    confirm: false,
    writes: false,
  },
  draft: {
    receipt: true,
    timeoutMs: 8_000,
    maxPerMinute: 30,
    confirm: false,
    writes: false,
  },
  submit: {
    receipt: true,
    timeoutMs: 55_000,
    maxPerMinute: 6,
    confirm: true,
    writes: true,
  },
  approve: {
    receipt: true,
    timeoutMs: 55_000,
    maxPerMinute: 6,
    confirm: true,
    writes: true,
  },
  export: {
    receipt: false,
    timeoutMs: 60_000,
    maxPerMinute: 12,
    confirm: false,
    writes: false,
  },
};

const LAYER_RANK: Record<CapabilityLayer, number> = {
  read: 0,
  draft: 1,
  submit: 2,
  approve: 3,
  export: 4,
};

export function layerRank(layer: CapabilityLayer): number {
  return LAYER_RANK[layer];
}

/** 元素影响等级 → 能力层。 */
export function layerForEffect(effect: LayerEffect): CapabilityLayer {
  return effect === "view" ? "read" : effect;
}

/**
 * 契约声明"我有哪几层"：
 * - 有页面或可读数据 → 有读层；
 * - 最大影响等级决定 draft / submit / approve 展开到哪一层；
 * - 模块显式声明的层与派生结果取并集（将来模块自己声明时直接生效）。
 */
export function layersForContract(input: {
  hasView?: boolean;
  hasData?: boolean;
  maxEffect: LayerEffect;
  declared?: readonly CapabilityLayer[];
}): CapabilityLayer[] {
  const layers = new Set<CapabilityLayer>();
  if (input.hasView === true || input.hasData === true) layers.add("read");
  for (const effect of ["draft", "submit", "approve"] as const) {
    if (layerRank(effect) <= layerRank(layerForEffect(input.maxEffect)))
      layers.add(effect);
  }
  for (const layer of input.declared ?? []) layers.add(layer);
  return CAPABILITY_LAYERS.filter((layer) => layers.has(layer));
}

/** 这一层的策略；模块不允许的层不放行（读层永远可用，兜底数据问题）。 */
export function layerPolicy(layer: CapabilityLayer): LayerPolicy {
  return LAYER_POLICY[layer];
}
