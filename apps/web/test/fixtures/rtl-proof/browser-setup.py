#!/usr/bin/env python3
"""Print an expression for preview_evaluate; explicit test-environment font fallback."""
import json,pathlib,shutil
font=pathlib.Path('/usr/share/fonts/truetype/noto/NotoNaskhArabic-Regular.ttf')
target=pathlib.Path(__file__).resolve().parents[5]/'.evidence-r3-home/proof-arabic.ttf'
target.parent.mkdir(exist_ok=True)
shutil.copyfile(font,target)
url='/@fs'+str(target)
print('''(async()=>{
if(!window.__proofOriginalDate){const D=Date;window.__proofOriginalDate=D;window.Date=class extends D{constructor(...a){super(...(a.length?a:['2026-10-21T11:00:00.000Z']))}static now(){return 1792580400000}}}
if(!window.__proofArabic){const f=new FontFace('Proof Arabic', 'url(' + FONT_URL + ')',{unicodeRange:'U+0600-06FF,U+0750-077F,U+08A0-08FF,U+FB50-FDFF,U+FE70-FEFF'});await f.load();document.fonts.add(f);const s=document.createElement('style');s.textContent=':root {--font-sans: "Proof Arabic", -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif !important; --font-mono: "Proof Arabic", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace !important} body {font-family:var(--font-sans)}';document.head.append(s);window.__proofArabic=true}
await document.fonts.ready;
return {clock:new Date().toISOString(),viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,ua:navigator.userAgent,rootFont:getComputedStyle(document.documentElement).fontSize,bodyFont:getComputedStyle(document.body).fontFamily,zoom:visualViewport.scale,theme:matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light'};
})()'''.replace('FONT_URL',json.dumps(url)))
