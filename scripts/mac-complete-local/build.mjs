import { runSignedMacBuild } from "./signing.mjs";

await runSignedMacBuild(...process.argv.slice(2, 5), process.argv.slice(5));
