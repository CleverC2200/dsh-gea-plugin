import * as fs from 'node:fs/promises';
import {createRequire} from 'node:module';
// Virtual ASAR reads are useful for packages; owned on-disk cache containers
// must be copied/removed as physical files, including the archive itself.
export const physicalFs=process.versions.electron?createRequire(import.meta.url)('original-fs').promises:fs;
