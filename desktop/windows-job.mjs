const exited = (pid) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
};

export function windowsJobStopped(proof, observation) {
  if (
    !observation?.sawAlive ||
    typeof observation.startIdentity !== "string" ||
    !observation.startIdentity ||
    !proof ||
    proof.nonce !== observation.startIdentity ||
    proof.pid !== observation.pid
  )
    return false;
  if (proof.stage === "empty") return Number.isInteger(proof.exitCode);
  return (
    proof.stage === "running" &&
    Number.isSafeInteger(proof.targetPid) &&
    proof.targetPid > 0 &&
    proof.targetPid !== observation.pid &&
    exited(observation.pid) &&
    exited(proof.targetPid)
  );
}
