#!/usr/bin/env python3
"""Validate all four published lifestyle edits, posters, and accessibility files."""
from pathlib import Path
import hashlib
import json
import shutil
import struct
import subprocess
from PIL import Image

ROOT=Path(__file__).resolve().parents[2]
VIDEO=ROOT/'website/video'

def command(args):
    return subprocess.run(args,check=True,text=True,capture_output=True)

def atoms(path):
    names=[]
    with path.open('rb') as f:
        while True:
            header=f.read(8)
            if len(header)<8: break
            size,name=struct.unpack('>I4s',header);header_size=8
            if size==1:size=struct.unpack('>Q',f.read(8))[0];header_size=16
            names.append(name.decode('ascii'))
            if size==0:break
            assert size>=header_size
            f.seek(size-header_size,1)
    return names

def main():
    ffmpeg=shutil.which('ffmpeg');ffprobe=shutil.which('ffprobe')
    assert ffmpeg and ffprobe,'FFmpeg and ffprobe are required'
    films=json.loads((VIDEO/'films.json').read_text())['films']
    assert {f['slug'] for f in films}=={'a-clearer-day','make-room-for-dinner'}
    for film in films:
        assert film['durationSeconds']==30 and film['fps']==24
        for entry,size in [(film,(1920,1080)),(film['portrait'],(720,1280))]:
            path=VIDEO/entry['file']
            probe=json.loads(command([ffprobe,'-v','error','-show_streams','-show_format','-of','json',str(path)]).stdout)
            v=next(s for s in probe['streams'] if s['codec_type']=='video')
            a=next(s for s in probe['streams'] if s['codec_type']=='audio')
            assert v['codec_name']=='h264' and v['pix_fmt']=='yuv420p'
            assert (v['width'],v['height'])==size
            assert v['avg_frame_rate']=='24/1' and int(v['nb_frames'])==720
            assert abs(float(v['duration'])-30)<.001
            assert abs(float(probe['format']['duration'])-30)<.05
            assert a['codec_name']=='aac' and a['channels']==2 and int(a['sample_rate'])==48000
            atom_names=atoms(path);assert atom_names.index('moov')<atom_names.index('mdat')
            assert entry['bytes']==path.stat().st_size
            assert entry['sha256']==hashlib.sha256(path.read_bytes()).hexdigest()
            assert Image.open(VIDEO/entry['poster']).size==size
            result=command([ffmpeg,'-v','error','-i',str(path),'-f','null','-'])
            assert not result.stderr,result.stderr
            print(f'PASS {path.name}: {size[0]}×{size[1]}, 720 frames, H.264/AAC, fast start, full decode',flush=True)
        assert (VIDEO/(film['slug']+'.vtt')).read_text().startswith('WEBVTT')
        assert 'Dramatized scenes' in (VIDEO/(film['slug']+'.txt')).read_text()
    assert (VIDEO/'credits.html').is_file()
    print('All four lifestyle films passed validation.')

if __name__=='__main__':main()
