import fs from 'fs'

const masterCode = fs.readFileSync('src/lib/converter.ts', 'utf8')
console.log(masterCode.includes('URL.createObjectURL(imgBlob)'))
