#!/usr/bin/env python3
"""Generate original CC0 synthetic 2x2 CFA DNG and PNG control; no camera photo."""
from pathlib import Path
import struct,zlib,binascii,hashlib,json
root=Path(__file__).parent
# Little-endian TIFF, DNGVersion 1.4; uncompressed 16-bit Bayer CFA sample.
tags=[(256,4,1,2),(257,4,1,2),(258,3,1,16),(259,3,1,1),(262,3,1,32803),(273,4,1,0),(277,3,1,1),(278,4,1,2),(279,4,1,8),(33421,3,2,0x00020002),(33422,1,4,0x02010100),(50706,1,4,0x00000401),(50707,1,4,0x00000101)]
offset=8+2+12*len(tags)+4
tags=[(t,k,n,offset if t==273 else v) for t,k,n,v in tags]
data=b'II'+struct.pack('<HIH',42,8,len(tags))+b''.join(struct.pack('<HHII',*t) for t in tags)+struct.pack('<I',0)+struct.pack('<4H',0,16384,32768,65535)
(root/'IMG_3921_7-50-59.DNG').write_bytes(data)
def chunk(t,b): return struct.pack('>I',len(b))+t+b+struct.pack('>I',binascii.crc32(t+b)&0xffffffff)
png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>2I5B',2,2,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b'\x00\xff\x00\x00\x00\xff\x00\x00\x00\x00\xff\xff\xff\xff'))+chunk(b'IEND',b'')
(root/'control.png').write_bytes(png)
print(json.dumps({p.name:dict(size=p.stat().st_size,sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in [root/'IMG_3921_7-50-59.DNG',root/'control.png']},indent=2))
