from pathlib import Path
import sys
sys.path.insert(0,'.tools')
import cv2
import numpy as np
sources = [Path(value) for value in sys.argv[1:]]
if not sources:
    raise SystemExit('usage: python reference/match-annotations.py <reference-image> [...]')
frames=[(p,cv2.resize(cv2.imread(str(p)),(480,270)).astype(float)) for p in Path('reference/motion').glob('[0-9]*.jpg')]
for source in sources:
    im=cv2.imread(source)[:1080,:1920]
    im=cv2.resize(im,(480,270)).astype(float)
    mask=~((im[:,:,2]>170)&(im[:,:,1]>130)&(im[:,:,0]<160))
    mask[:55,:90]=False
    scores=sorted((np.mean(np.abs(im-f)[mask]),p.stem) for p,f in frames)
    print(Path(source).name,[(int(n)/25,round(float(s),2)) for s,n in scores[:4]])
