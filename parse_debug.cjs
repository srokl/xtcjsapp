const fs = require('fs');

const ts = require('typescript');
const code = fs.readFileSync('src/lib/xtc-reader.ts', 'utf8')
  .replace(/import { decompressXtczLz4 } from '\.\/processing\/lz4-compress'/g, "const { decompressXtczLz4 } = require('./lz4-compress-compiled.cjs')")
  .replace(/import .* from.*/g, ""); // strip other imports

const jsCode = ts.transpileModule(code, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
fs.writeFileSync('xtc-reader-compiled.cjs', jsCode);
