export type LayerEffect = "view" | "draft" | "submit" | "approve";

export const CAPABILITY_LAYERS = ["read", "draft", "submit", "approve", "export"] as const;
export type CapabilityLayer = (typeof CAPABILITY_LAYERS)[number];

export type LayerPolicy = {
  receipt: boolean;

  timeoutMs: number;

  maxPerMinute: number;

  confirm: boolean;

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

export function layerForEffect(effect: LayerEffect): CapabilityLayer {
  return effect === "view" ? "read" : effect;
}

export function layersForContract(input: {
  hasView?: boolean;
  hasData?: boolean;
  maxEffect: LayerEffect;
  declared?: readonly CapabilityLayer[];
}): CapabilityLayer[] {
  const layers = new Set<CapabilityLayer>();
  if (input.hasView === true || input.hasData === true) layers.add("read");
  for (const effect of ["draft", "submit", "approve"] as const) {
    if (layerRank(effect) <= layerRank(layerForEffect(input.maxEffect))) layers.add(effect);
  }
  for (const layer of input.declared ?? []) layers.add(layer);
  return CAPABILITY_LAYERS.filter((layer) => layers.has(layer));
}

export function layerPolicy(layer: CapabilityLayer): LayerPolicy {
  return LAYER_POLICY[layer];
}
