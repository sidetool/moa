import { cp, copyFile } from 'node:fs/promises';
await cp(new URL('../src/sources/extensions/vendor/',import.meta.url),new URL('../dist/sources/extensions/vendor/',import.meta.url),{recursive:true});
await copyFile(new URL('../src/sources/extensions/filters.mjs',import.meta.url),new URL('../dist/sources/extensions/filters.mjs',import.meta.url));
