#!/usr/bin/env python3
"""Build Zelos lifestyle films from eight individually reviewed, licensed stock clips.

Raw source footage stays outside the repository. See README.md and stock-sources.json.
"""
import argparse
from array import array
import hashlib
import json
import math
from pathlib import Path
import shutil
import subprocess
import sys
import wave
from PIL import Image, ImageDraw, ImageFont
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parents[2]
FPS = 24
DURATION = 30
FILMS = [
    dict(slug="a-clearer-day", title="A clearer day", description="Meetings, replies, and next steps in focus. A little more room to get outside.",
         shots=[("typing-4938.mp4",12,168,360), ("closing-42653.mp4",60,120,620), ("forest-86.mp4",0,216,680), ("lake-41581.mp4",24,234,940)],
         captions=[(.8,4.7,["Let Zelos bring", "your day together."]), (6.9,10.8,["Meetings. Replies.","Your next move."]), (13,18.0,["Less catching up.","More getting out."]), (24,29.5,["Make room for life."])],
         visuals=["Hands working at a laptop in morning light.", "A person finishes typing and closes a laptop.", "A walk along a sunlit forest trail.", "Two people take in the view together beside a lake."], poster=22.5),
    dict(slug="make-room-for-dinner", title="Make room for dinner", description="Choose meals, review your grocery list, and put your attention back into cooking and being together.",
         shots=[("tutorial-12159.mp4",36,144,770), ("unpacking-12152.mp4",48,144,700), ("cooking-12153.mp4",24,216,920), ("dinner-12162.mp4",72,234,1160)],
         captions=[(1,5.4,["Zelos plans around", "your goals and tastes."]), (6.5,10.9,["Choose your meals.", "Review your grocery list."]), (14,18.7,["Less time deciding.", "More time cooking together."]), (24,29.5,["Make room for dinner."])],
         visuals=["A couple discusses a recipe with a laptop nearby.", "The same couple unpacks fresh groceries in their kitchen.", "They chop vegetables and prepare a meal together.", "They enjoy dinner and conversation at home."], poster=22.5),
]


def run(args):
    subprocess.run(args, check=True)


def smooth(x):
    x=max(0,min(1,x)); return x*x*(3-2*x)


def soundtrack(path, variant):
    """Original synthesized score. No recordings, third-party samples, or voice."""
    rate=48000
    roots=[146.832,130.813,164.814,146.832] if variant == 0 else [130.813,146.832,110.0,130.813]
    pcm=array('h')
    for n in range(rate*DURATION):
        t=n/rate; envelope=smooth(t/1.5)*smooth((DURATION-t)/1.9)
        left=right=0.0
        for section,root in enumerate(roots):
            env=smooth((t-section*7.5+.8)/1.6)*smooth(((section+1)*7.5+.8-t)/1.6)
            if not env: continue
            for i,ratio in enumerate([1,1.25,1.5,2]):
                freq=root*ratio
                mod=.7+.3*math.sin(t*.41+i)
                tone=math.sin(2*math.pi*freq*t)+.12*math.sin(2*math.pi*freq*2*t)
                amp=.033*env*mod
                left+=amp*tone*(.78+i*.05); right+=amp*tone*(.98-i*.05)
        for beat,index in [(1.0,2),(4.2,0),(8,1),(11.5,3),(15.5,2),(19,1),(23.8,0),(27,3)]:
            local=t-beat
            if 0 <= local < 3:
                freq=roots[min(3,int(beat/7.5))]*[1,1.25,1.5,2][index]*2
                bell=math.sin(2*math.pi*freq*local)*math.exp(-local*1.8)*smooth(local/.03)*.052
                left+=bell*.88; right+=bell*.94
        pcm.extend((round(left*envelope*32767),round(right*envelope*32767)))
    if sys.byteorder != 'little': pcm.byteswap()
    with wave.open(str(path),'wb') as f:
        f.setnchannels(2);f.setsampwidth(2);f.setframerate(rate);f.writeframes(pcm.tobytes())


def font_file(work):
    path=work/'hanken-grotesk.ttf'
    font=TTFont(ROOT/'website/fonts/hankengrotesk.woff2');font.flavor=None;font.save(path)
    return path


def font(path,size,weight=600):
    f=ImageFont.truetype(str(path),size)
    try: f.set_variation_by_axes([weight])
    except (AttributeError,OSError): pass
    return f


def overlay_assets(film, work, width, height, font_path):
    portrait=height>width; suffix='portrait' if portrait else 'landscape'
    base=work/f"{film['slug']}-{suffix}";base.mkdir(exist_ok=True)
    # All picture motion remains the real source video. Only type is rendered here.
    gradient=Image.new('RGBA',(width,height),(0,0,0,0));pixels=gradient.load()
    begin=height*(.52 if portrait else .55)
    for y in range(height):
        a=round(152*smooth((y-begin)/(height-begin)))
        for x in range(width): pixels[x,y]=(0,0,0,a)
    gradient.save(base/'gradient.png')
    left=52 if portrait else 100
    size=48 if portrait else 70
    text_font=font(font_path,size,600)
    label_font=font(font_path,20 if portrait else 26,500)
    cue_files=[]
    for i,(start,end,lines) in enumerate(film['captions']):
        lines=list(lines)
        if portrait and film['slug']=='make-room-for-dinner' and i==2:
            lines=["Less time deciding.","More time cooking", "together."]
        image=Image.new('RGBA',(width,290 if portrait else 320),(0,0,0,0));d=ImageDraw.Draw(image)
        if i==3:
            d.text((left,5),'ZELOS',font=label_font,fill=(255,255,255,224),stroke_width=0)
        y=45 if i==3 else 28
        for line in lines:
            if d.textlength(line,font=text_font)>width-left*2:
                raise ValueError(f'Text exceeds safe width: {line}')
            d.text((left,y),line,font=text_font,fill='white',stroke_width=0)
            y+=62 if portrait else 86
        path=base/f'caption-{i}.png';image.save(path);cue_files.append(path)
    disclosure=Image.new('RGBA',(width,70),(0,0,0,0));d=ImageDraw.Draw(disclosure)
    # A small consistent scene label is readable without taking over the film.
    d.text((left,20),'Dramatized scenes',font=label_font,fill=(255,255,255,222))
    disclosure.save(base/'disclosure.png')
    return base,cue_files


def footage(film, sources, work, width, height, ffmpeg):
    suffix='portrait' if height>width else 'landscape'
    out=work/f"{film['slug']}-{suffix}-picture.mp4"
    command=[ffmpeg,'-hide_banner','-loglevel','error','-y','-filter_complex_threads','2']
    for name,_,_,_ in film['shots']: command+=['-i',str(sources/name)]
    filters=[]
    for i,(name,start,count,cropx) in enumerate(film['shots']):
        # setpts preserves every selected source frame; the 30fps forest is gently
        # slowed to 24fps. Native 23.976 shots run at 24 without cadence skipping.
        f=f'[{i}:v]trim=start_frame={start}:end_frame={start+count},setpts=N/(24*TB),fps=24,settb=1/24'
        if height>width:
            f+=f',crop=608:1080:{cropx}:0,scale={width}:{height}:flags=lanczos'
        else: f+=f',scale={width}:{height}:flags=lanczos'
        f+=',setsar=1,format=yuv420p'+f'[s{i}]'; filters.append(f)
    offset=film['shots'][0][2]/FPS-.25
    previous='s0'
    for i in range(1,4):
        tag=f'x{i}'
        filters.append(f'[{previous}][s{i}]xfade=transition=fade:duration=0.25:offset={offset:.6f}[{tag}]')
        previous=tag;offset+=film['shots'][i][2]/FPS-.25
    command+=['-filter_complex',';'.join(filters),'-map',f'[{previous}]','-an','-c:v','libx264','-preset','fast','-crf','17','-pix_fmt','yuv420p','-r','24','-frames:v','720',str(out)]
    run(command)
    return out


def render(film,variant,sources,work,output,ffmpeg,font_path,reuse_picture=False):
    width,height=(720,1280) if variant=='portrait' else (1920,1080)
    suffix='-portrait' if variant=='portrait' else ''
    stem=film['slug']+suffix
    picture=work/f"{film['slug']}-{variant}-picture.mp4"
    if not (reuse_picture and picture.is_file()):
        picture=footage(film,sources,work,width,height,ffmpeg)
    assets,cue_files=overlay_assets(film,work,width,height,font_path)
    sound=work/(film['slug']+'.wav')
    if not sound.exists(): soundtrack(sound,FILMS.index(film))
    command=[ffmpeg,'-hide_banner','-loglevel','error','-y','-filter_complex_threads','2','-i',str(picture),'-i',str(sound)]
    overlays=[assets/'gradient.png']+cue_files+[assets/'disclosure.png']
    for p in overlays: command+=['-loop','1','-framerate','24','-i',str(p)]
    filters=['[0:v][2:v]overlay=0:0:shortest=1[v0]']
    y=936 if variant=='portrait' else 742
    for i,(start,end,_) in enumerate(film['captions']):
        index=i+3
        filters.append(f'[{index}:v]format=rgba,fade=t=in:st={start}:d=0.3:alpha=1,fade=t=out:st={end-.3}:d=0.3:alpha=1[t{i}]')
        filters.append(f'[v{i}][t{i}]overlay=0:{y}:shortest=1[v{i+1}]')
    filters.append("[v4][7:v]overlay=0:28:shortest=1:enable='between(t,0.8,4.7)+between(t,24,29.5)'[video]")
    movie=output/(stem+'.mp4')
    command+=['-filter_complex',';'.join(filters),'-map','[video]','-map','1:a','-c:v','libx264','-preset','medium','-crf','22' if variant=='landscape' else '21','-maxrate','5M' if variant=='landscape' else '2500k','-bufsize','10M' if variant=='landscape' else '5M','-pix_fmt','yuv420p','-af','volume=2','-c:a','aac','-b:a','160k','-r','24','-t','30','-movflags','+faststart','-metadata',f"title=Zelos — {film['title']}",'-metadata','comment=Dramatized scenes. Licensed live-action footage with original edit and instrumental score.',str(movie)]
    run(command)
    # Uncaptioned moving-picture poster, independently framed for each format.
    png=work/(stem+'-poster.png')
    run([ffmpeg,'-hide_banner','-loglevel','error','-y','-ss',str(film['poster']),'-i',str(picture),'-frames:v','1',str(png)])
    Image.open(png).convert('RGB').save(output/(stem+'.jpg'),quality=86,subsampling=2,optimize=True,progressive=True)
    return dict(file=stem+'.mp4',poster=stem+'.jpg',width=width,height=height,bytes=movie.stat().st_size,sha256=hashlib.sha256(movie.read_bytes()).hexdigest())


def timestamp(seconds):
    ms=round(seconds*1000);return f'{ms//3600000:02}:{ms//60000%60:02}:{ms//1000%60:02}.{ms%1000:03}'


def accessibility(film,output):
    vtt=['WEBVTT','','NOTE On-screen text. Original instrumental music; no spoken narration.','']
    text=[film['title'],'='*len(film['title']),'',film['description'],'','30-second lifestyle film. Dramatized scenes with licensed stock actors, not customer testimonials. Original instrumental score; no spoken narration.','']
    for i,(start,end,lines) in enumerate(film['captions']):
        vtt.extend([str(i+1),f'{timestamp(start)} --> {timestamp(end)}','\n'.join(lines),''])
        text.extend([f'{timestamp(start)[:-4]}–{timestamp(end)[:-4]}  '+ ' '.join(lines),'Scene: '+film['visuals'][i],''])
    text.extend(['Small on-screen label at the beginning and end: Dramatized scenes. The final image also displays ZELOS.',''])
    if film['slug']=='make-room-for-dinner':
        text.extend(['Zelos helps suggest meals and prepare a grocery list using preferences you provide. You review the plan and choose what to buy. The people shown do the shopping, cooking, and cleanup. No automatic ordering, delivery, or robotic cooking is demonstrated.',''])
    else:
        text.extend(['Zelos helps bring meetings, replies, and next steps together. These illustrative scenes do not promise or measure a specific amount of time saved.',''])
    text.extend(['Footage and music credits: https://zelos.life/video/credits.html',''])
    (output/(film['slug']+'.vtt')).write_text('\n'.join(vtt))
    (output/(film['slug']+'.txt')).write_text('\n'.join(text))


def contact_sheet(movie,work,ffmpeg):
    portrait='-portrait' in movie.stem
    times=[1.6,4,7.7,10.3,13.5,17,21.5,26,29]
    tw,th=(240,427) if portrait else (480,270)
    sheet=Image.new('RGB',(tw*3,(th+24)*3),'#101114');draw=ImageDraw.Draw(sheet)
    for i,t in enumerate(times):
        png=work/f'{movie.stem}-review-{i}.png'
        run([ffmpeg,'-hide_banner','-loglevel','error','-y','-ss',str(t),'-i',str(movie),'-frames:v','1','-vf',f'scale={tw}:{th}',str(png)])
        x=(i%3)*tw;y=(i//3)*(th+24)
        sheet.paste(Image.open(png),(x,y));draw.text((x+8,y+th+4),f'{t:.1f}s',fill='white')
    sheet.save(work/f'{movie.stem}-contact.jpg',quality=94)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--sources',type=Path,required=True)
    parser.add_argument('--work',type=Path,required=True)
    parser.add_argument('--output',type=Path,default=ROOT/'website/video')
    parser.add_argument('--film',choices=[f['slug'] for f in FILMS])
    parser.add_argument('--variant',choices=['landscape','portrait'])
    parser.add_argument('--reuse-picture',action='store_true',help='Reuse reviewed picture masters when only type, audio, or encoding changes.')
    args=parser.parse_args();args.work.mkdir(parents=True,exist_ok=True);args.output.mkdir(parents=True,exist_ok=True)
    ffmpeg=shutil.which('ffmpeg')
    if not ffmpeg: parser.error('ffmpeg with libx264 is required')
    films=[f for f in FILMS if not args.film or f['slug']==args.film]
    for film in films:
        for name,_,_,_ in film['shots']:
            if not (args.sources/name).is_file(): parser.error(f'Missing licensed source: {name}')
    fp=font_file(args.work)
    manifest_path=args.output/'films.json'
    existing=json.loads(manifest_path.read_text()).get('films',[]) if manifest_path.exists() else []
    manifest={f['slug']:f for f in existing}
    for film in films:
        entry=manifest.get(film['slug'],{})
        entry.update(slug=film['slug'],title=film['title'],description=film['description'],durationSeconds=30,fps=24,previewVersion='1.8.4',footage='Licensed live-action; dramatized scenes',creditsURL='/video/credits.html')
        for variant in ([args.variant] if args.variant else ['landscape','portrait']):
            print(f"Rendering {film['title']} — {variant}",flush=True)
            result=render(film,variant,args.sources,args.work,args.output,ffmpeg,fp,args.reuse_picture)
            if variant=='landscape': entry.update(result)
            else: entry['portrait']=result
            contact_sheet(args.output/result['file'],args.work,ffmpeg)
        accessibility(film,args.output)
        # Preserve another film/variant completed while this render was running.
        current=json.loads(manifest_path.read_text()).get('films',[]) if manifest_path.exists() else []
        manifest={f['slug']:f for f in current}
        if args.variant=='landscape' and 'portrait' in manifest.get(film['slug'],{}):
            entry['portrait']=manifest[film['slug']]['portrait']
        if args.variant=='portrait':
            fresh=manifest.get(film['slug'],{})
            for key in ('file','poster','width','height','bytes','sha256'):
                if key in fresh: entry[key]=fresh[key]
        manifest[film['slug']]=entry
        manifest_path.write_text(json.dumps({'films':[manifest[f['slug']] for f in FILMS if f['slug'] in manifest]},indent=2)+'\n')
    print('Finished selected films and review sheets.',flush=True)

if __name__=='__main__':main()
