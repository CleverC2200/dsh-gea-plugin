export async function compileWindowsCore(run) {
  await run("build-official", ["run", "build:official"]);
  await run("build-native-ts", ["--dir", "native/system", "run", "build:ts"]);
}
