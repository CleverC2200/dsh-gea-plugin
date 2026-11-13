export function watchBoot({
  onTimeout,
  idleMs,
  totalMs,
}: {
  onTimeout: (error: Error) => void;
  idleMs?: number;
  totalMs?: number;
}): {
  touch(): void;
  stop: () => void;
};
