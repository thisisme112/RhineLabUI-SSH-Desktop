// Reuse the web's fixed phrase artwork, without embedding a new font.
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
let sharp;
try { sharp=require(process.env.RHINE_SHARP_MODULE || 'sharp'); }
catch { throw new Error('This optional artwork export needs sharp. Install it locally or set RHINE_SHARP_MODULE to its absolute module path.'); }
const root=resolve(import.meta.dirname,'..');
const art=JSON.parse(readFileSync(resolve(root,'src/boot-lettering-art.json'),'utf8')).brand;
const em=50.75, tracking=1, scale=4;
let x=0;
const paths=art.letters.map((letter,i)=>{
  const path=`<path transform="translate(${x},1.425) scale(${em/art.units})" d="${letter.path}"/>`;
  x+=letter.width*em+(i<art.letters.length-1?tracking:0);
  return path;
}).join('');
const width=Math.ceil(x), height=54;
const svg=`<svg xmlns="http://www.w3.org/2000/svg" width="${width*scale}" height="${height*scale}" viewBox="0 0 ${width} ${height}"><g fill="white">${paths}</g></svg>`;
const out=resolve(root,'prototypes/unreal/Content/Data');
mkdirSync(out,{recursive:true});
await sharp(Buffer.from(svg)).png().toFile(resolve(out,'archive-brand.png'));
writeFileSync(resolve(out,'archive-brand.json'),JSON.stringify({source:'src/boot-lettering-art.json / brand',em,tracking,width,height,scale},null,2)+'\n');
console.log(`Exported fixed RHINE LAB artwork: ${width} x ${height}, ${scale}x raster`);
