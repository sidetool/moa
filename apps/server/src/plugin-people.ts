import type { DiscoveryItem, LinkedPluginTitle, PersonWorksResponse, TitlePeople, TitlePeopleResponse, PeopleStatus } from '@moa/shared';
import type { Store } from './db.js';
import { ApiFailure } from './util.js';

export interface PeopleProvider {
  readonly providerId: string;
  readonly enabled: boolean;
  readonly configurationRevision: number;
  linkedTitle(mediaId: string): LinkedPluginTitle | null;
  peopleCredits(title: LinkedPluginTitle): Promise<TitlePeople>;
  personWorks(id: string): Promise<{items: DiscoveryItem[]; truncated: boolean}>;
}
type Cached = {value?: unknown; until: number; retry: number; pending?: Promise<unknown>};
const creditsEmpty = (provider: string, status: PeopleStatus): TitlePeopleResponse => ({provider,status,title:null,cast:[],crew:[],truncated:false});
const worksEmpty = (provider: string, status: PeopleStatus): PersonWorksResponse => ({provider,status,title:null,person:null,items:[],truncated:false});
/** Public provider data only; authorization and current linkage are never cached. */
export class PluginPeople {
  private cache = new Map<string, Cached>();
  private stamp = '';
  private active = 0;
  constructor(private db: Store, private source: PeopleProvider, private now = Date.now) {}
  private generation() { return JSON.stringify([this.source.providerId,this.source.configurationRevision]); }
  private allowed(profile: string) { return this.db.get('SELECT kids FROM profiles WHERE id=?',profile)?.kids === 0; }
  private async cached<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const stamp = this.generation();
    if (this.stamp !== stamp) { this.cache.clear(); this.stamp = stamp; }
    let entry = this.cache.get(key);
    if (entry?.value !== undefined && this.now() < entry.until) return entry.value as T;
    if (entry?.pending) return entry.pending as Promise<T>;
    if ((entry && this.now() < entry.retry) || this.active >= 4) throw new Error('provider-busy');
    if (!entry) {
      if (this.cache.size >= 128) {
        const oldest = [...this.cache].find(([,e]) => !e.pending);
        if (oldest) this.cache.delete(oldest[0]); else throw new Error('provider-busy');
      }
      entry = {until:0,retry:0}; this.cache.set(key,entry);
    }
    const target = entry; this.active++;
    const request = Promise.resolve().then(fetcher).then(value => {
      target.value = value; target.until = this.now() + 6*60*60_000; return value;
    }).catch(error => {target.value = undefined; target.retry = this.now() + 60_000; throw error;})
      .finally(() => {target.pending = undefined;this.active--;});
    target.pending = request;
    return request;
  }
  private status(profile: string, generation: string, title: LinkedPluginTitle): PeopleStatus | null {
    if (!this.allowed(profile)) return 'restricted';
    if (!this.source.enabled) return 'unconfigured';
    if (generation !== this.generation() || JSON.stringify(title) !== JSON.stringify(this.source.linkedTitle(title.mediaId))) return 'unavailable';
    return null;
  }
  async credits(profile: string, mediaId: string): Promise<TitlePeopleResponse> {
    const provider = this.source.providerId, generation = this.generation();
    if (!this.allowed(profile)) return creditsEmpty(provider,'restricted');
    if (!this.source.enabled) return creditsEmpty(provider,'unconfigured');
    const title = this.source.linkedTitle(mediaId);
    if (!title) return creditsEmpty(provider,'unlinked');
    let result: TitlePeople;
    try { result = await this.cached(JSON.stringify(['title',provider,title.kind,title.id]),()=>this.source.peopleCredits(title)); }
    catch { return creditsEmpty(provider,this.status(profile,generation,title) || 'unavailable'); }
    const changed = this.status(profile,generation,title);
    return changed ? creditsEmpty(provider,changed) : {provider,status:'ready',title,...result};
  }
  async person(profile: string, mediaId: string, identity: {provider:string;id:string}): Promise<PersonWorksResponse> {
    const generation = this.generation(), credits = await this.credits(profile,mediaId);
    if (credits.status !== 'ready' || !credits.title) return worksEmpty(credits.provider,credits.status);
    const matches = [...credits.cast,...credits.crew].filter(p => p.provider === identity.provider && p.id === identity.id);
    if (!matches.length) throw new ApiFailure(403,'person-not-in-title');
    const person = {...matches[0],roles:[...new Set(matches.flatMap(p=>p.roles))].slice(0,16)};
    let result: {items:DiscoveryItem[];truncated:boolean};
    try { result = await this.cached(JSON.stringify(['person',identity.provider,identity.id]),()=>this.source.personWorks(identity.id)); }
    catch { return worksEmpty(credits.provider,this.status(profile,generation,credits.title) || 'unavailable'); }
    const changed = this.status(profile,generation,credits.title);
    return changed ? worksEmpty(credits.provider,changed) : {provider:credits.provider,status:'ready',title:credits.title,person,...result};
  }
}
