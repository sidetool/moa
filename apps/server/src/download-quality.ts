import type { DownloadQuality } from '@moa/shared';

export const DOWNLOAD_QUALITIES: readonly DownloadQuality[] = ['best','1080p','720p','480p'];
export function qualityHeight(label: string): number | undefined {
  const dimension=/(?:^|\D)\d{2,5}\s*[x×]\s*(\d{2,5})(?:\D|$)/i.exec(label);
  if(dimension)return Number(dimension[1]);
  const pixels=/(?:^|\D)(\d{3,4})\s*p\b/i.exec(label) ?? /^\s*(\d{3,4})\s*$/.exec(label);
  if(pixels)return Number(pixels[1]);
  if(/\b4k\b|\buhd\b/i.test(label))return 2160;
  if(/\b2k\b|\bqhd\b/i.test(label))return 1440;
  if(/\bfhd\b|full\s*hd/i.test(label))return 1080;
  if(/\bhd\b/i.test(label))return 720;
}
/** Stable source order breaks ties. Missing target uses the lowest known resolution, then source default. */
export function preferredQuality<T>(items: readonly T[], preference: DownloadQuality, height: (item:T)=>number|undefined): T | undefined {
  const known=items.map((item,index)=>({item,index,height:height(item)})).filter(x=>x.height!==undefined&&Number.isFinite(x.height)&&x.height>0) as {item:T;index:number;height:number}[];
  known.sort((a,b)=>b.height-a.height||a.index-b.index);
  if(!known.length)return items[0];
  if(preference==='best')return known[0].item;
  const max=Number.parseInt(preference,10);
  return known.find(x=>x.height<=max)?.item ?? known.filter(x=>x.height===known.at(-1)!.height)[0].item;
}
