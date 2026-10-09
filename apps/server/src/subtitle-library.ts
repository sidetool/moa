import { createHash, randomUUID } from 'node:crypto';
import type { SavedSubtitle, SubtitlePreference, SubtitleTrack } from '@moa/shared';
import type { Store } from './db.js';
import type { Catalog } from './catalog.js';
import type { Translations } from './translation/service.js';
import type { OnlineSubtitles } from './online.js';
import { importSubtitles } from './subtitle-upload.js';
import { ApiFailure } from './util.js';
import type { TitleGroups } from './title-groups.js';
import { subtitleQuery } from './subtitle-query.js';

interface Upload { id: string; episode_id: string; profile_id: string; filename: string; format: 'ass' | 'vtt'; content: string }

export class SubtitleLibrary {
  constructor(private db: Store, private catalog: Catalog, private translations: Translations, private online: OnlineSubtitles, private groups: TitleGroups) {
    db.db.exec(`CREATE TABLE IF NOT EXISTS uploaded_subtitles(
      id TEXT PRIMARY KEY,episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,filename TEXT NOT NULL,
      format TEXT NOT NULL,content TEXT NOT NULL,content_hash TEXT NOT NULL,created_at INTEGER NOT NULL,
      UNIQUE(episode_id,profile_id,content_hash));
      CREATE TABLE IF NOT EXISTS subtitle_preferences(
      profile_id TEXT NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
      episode_id TEXT NOT NULL REFERENCES episodes(id) ON DELETE CASCADE,
      choice TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(profile_id,episode_id));`);
  }

  private episode(episodeId: string, profileId: string) {
    const episode = this.db.get('SELECT media_id FROM episodes WHERE id=?', episodeId);
    if (!episode) throw new ApiFailure(404, 'episode-not-found');
    if (!this.db.get('SELECT 1 FROM profiles WHERE id=?', profileId)) throw new ApiFailure(401, 'profile-required');
    this.catalog.kids.assert(episode.media_id, profileId);
    return episode;
  }

  private related(episodeId: string, profileId: string) {
    const episode = this.episode(episodeId, profileId), mapping = this.groups.mapping(profileId), group = mapping.get(episode.media_id);
    const mediaIds = group ? [...mapping].filter(([, key]) => key === group).map(([id]) => id) : [episode.media_id as string];
    if (mediaIds.length === 1) return { episodeIds: [episodeId], mediaIds };
    const rows = this.db.all(`SELECT e.*,m.title AS original_title FROM episodes e JOIN media m ON m.id=e.media_id
      WHERE e.media_id IN (${mediaIds.map(() => '?').join(',')})`, ...mediaIds);
    const identity = (row: Record<string, any>) => { try { return subtitleQuery(this.db, row); } catch { return undefined; } };
    const current = identity(rows.find(row => row.id === episodeId)!);
    const episodeIds = rows.filter(row => {
      if (row.id === episodeId) return true;
      if (row.media_id === episode.media_id) return false;
      const query = identity(row);
      return current && query && !current.warnings.length && !query.warnings.length && query.season === current.season && query.episode === current.episode;
    }).map(row => row.id as string);
    return { episodeIds, mediaIds };
  }

  preference(episodeId: string, profileId: string): { choice?: SubtitlePreference | null } {
    const { episodeIds, mediaIds } = this.related(episodeId, profileId);
    const row = this.db.get(`SELECT choice FROM subtitle_preferences WHERE profile_id=? AND episode_id IN (${episodeIds.map(() => '?').join(',')})
      ORDER BY updated_at DESC LIMIT 1`, profileId, ...episodeIds);
    if (row) {
      const choice = JSON.parse(row.choice) as SubtitlePreference | null;
      if (choice === null || episodeIds.includes(choice.episodeId)) return { choice };
    }
    const title = this.db.get(`SELECT p.choice FROM subtitle_preferences p JOIN episodes e ON e.id=p.episode_id
      WHERE p.profile_id=? AND e.media_id IN (${mediaIds.map(() => '?').join(',')}) ORDER BY p.updated_at DESC LIMIT 1`, profileId, ...mediaIds);
    return title?.choice === 'null' ? { choice: null } : {};
  }

  remember(episodeId: string, profileId: string, choice: SubtitlePreference | null) {
    const { episodeIds } = this.related(episodeId, profileId);
    if (choice) {
      let origin = choice.episodeId;
      if (choice.source === 'upload') origin = this.db.get('SELECT episode_id FROM uploaded_subtitles WHERE id=? AND profile_id=?', choice.id.replace(/^upload-/, ''), profileId)?.episode_id;
      else if (choice.source === 'online') origin = this.db.get('SELECT episode_id FROM online_subtitles WHERE id=?', choice.id)?.episode_id;
      else if (choice.source === 'translation') {
        const key = choice.id.replace(/^translation-/, '');
        origin = this.db.get(`SELECT episode_id FROM translated_subtitles WHERE cache_key=? AND episode_id IN (${episodeIds.map(() => '?').join(',')}) LIMIT 1`, key, ...episodeIds)?.episode_id ?? this.translations.trackEpisode(key, profileId);
      }
      if (!episodeIds.includes(origin)) throw new ApiFailure(404, 'subtitle-not-found');
      choice = { ...choice, episodeId: origin };
    }
    const updatedAt = Math.max(Date.now(), (this.db.get('SELECT MAX(updated_at) AS latest FROM subtitle_preferences WHERE profile_id=?', profileId)?.latest ?? 0) + 1);
    this.db.run('INSERT OR REPLACE INTO subtitle_preferences VALUES(?,?,?,?)', profileId, episodeId, JSON.stringify(choice), updatedAt);
    return { choice };
  }

  private track(row: Upload): SubtitleTrack {
    return { id: `upload-${row.id}`, label: row.filename, source: 'upload', format: row.format, url: `/api/playback/upload-${row.id}/subtitles/${row.id}.${row.format}` };
  }

  async import(episodeId: string, profileId: string, filename: string, data: string) {
    this.episode(episodeId, profileId);
    const files = await importSubtitles(filename, data), tracks: SubtitleTrack[] = [];
    this.db.transaction(() => {
      this.episode(episodeId, profileId);
      for (const file of files) {
        const digest = createHash('sha256').update(file.content).digest('hex');
        this.db.run('INSERT OR IGNORE INTO uploaded_subtitles VALUES(?,?,?,?,?,?,?,?)', randomUUID(), episodeId, profileId, file.filename, file.format, file.content, digest, Date.now());
        tracks.push(this.track(this.db.get<Upload>('SELECT * FROM uploaded_subtitles WHERE episode_id=? AND profile_id=? AND content_hash=?', episodeId, profileId, digest)!));
      }
    });
    return [...new Map(tracks.map(track => [track.id, track])).values()];
  }

  tracks(episodeId: string, profileId: string, source?: 'upload' | 'translation' | 'online') {
    const { episodeIds } = this.related(episodeId, profileId), tracks: SubtitleTrack[] = [];
    if (!source || source === 'upload') tracks.push(...this.db.all<Upload>(`SELECT id,filename,format FROM uploaded_subtitles
      WHERE episode_id IN (${episodeIds.map(() => '?').join(',')}) AND profile_id=? ORDER BY created_at DESC,id`, ...episodeIds, profileId).map(row => this.track(row)));
    for (const id of episodeIds) {
      if (!source || source === 'translation') tracks.push(...this.translations.tracks(id, profileId));
      if (!source || source === 'online') tracks.push(...this.online.tracks(id, profileId));
    }
    return [...new Map(tracks.map(track => [track.id, track])).values()];
  }

  assetProfile(sessionId: string) {
    return sessionId.startsWith('upload-') ? this.db.get('SELECT profile_id FROM uploaded_subtitles WHERE id=?', sessionId.slice(7))?.profile_id as string | undefined : undefined;
  }

  asset(sessionId: string, track: string, profileId?: string) {
    if (!sessionId.startsWith('upload-')) return undefined;
    const row = this.db.get<Upload>('SELECT * FROM uploaded_subtitles WHERE id=?', sessionId.slice(7));
    if (!row || track !== `${row.id}.${row.format}`) throw new ApiFailure(404, 'subtitle-not-found');
    if (profileId !== undefined && profileId !== row.profile_id) throw new ApiFailure(403, 'session-profile-mismatch');
    this.episode(row.episode_id, row.profile_id);
    return row;
  }

  list(): SavedSubtitle[] {
    const uploads = this.db.all<SavedSubtitle>(`SELECT s.id,'upload' AS source,s.filename AS name,s.format,
      m.title AS title,p.name AS profile,length(CAST(s.content AS BLOB)) AS bytes,s.created_at AS createdAt,1 AS complete
      FROM uploaded_subtitles s JOIN episodes e ON e.id=s.episode_id JOIN media m ON m.id=e.media_id JOIN profiles p ON p.id=s.profile_id`);
    const translations = this.db.all<SavedSubtitle>(`SELECT c.key AS id,'translation' AS source,'한국어 AI 번역' AS name,c.format,
      COALESCE(group_concat(DISTINCT m.title),'AI 번역') AS title,NULL AS profile,length(CAST(c.content AS BLOB)) AS bytes,
      COALESCE(max(s.created_at),c.touched) AS createdAt,c.complete
      FROM translation_cache c LEFT JOIN translated_subtitles s ON s.cache_key=c.key LEFT JOIN episodes e ON e.id=s.episode_id
      LEFT JOIN media m ON m.id=e.media_id WHERE c.content IS NOT NULL GROUP BY c.key`);
    const online = this.db.all<SavedSubtitle>(`SELECT s.id,'online' AS source,s.creator_name || ' · 한국어' AS name,s.format,
      m.title AS title,NULL AS profile,length(CAST(s.content AS BLOB)) AS bytes,s.created_at AS createdAt,1 AS complete
      FROM online_subtitles s JOIN episodes e ON e.id=s.episode_id JOIN media m ON m.id=e.media_id`);
    const episodes = new Map<string, SavedSubtitle['episodes']>();
    for (const { subtitleId, source, ...episode } of this.db.all<SavedSubtitle['episodes'][number] & { subtitleId: string; source: SavedSubtitle['source'] }>(`SELECT s.id AS subtitleId,s.source,
      e.id,e.media_id AS mediaId,e.season,e.number,e.title,m.title AS mediaTitle FROM (
        SELECT id,'upload' AS source,episode_id FROM uploaded_subtitles
        UNION ALL SELECT cache_key,'translation',episode_id FROM translated_subtitles
        UNION ALL SELECT id,'online',episode_id FROM online_subtitles
      ) s JOIN episodes e ON e.id=s.episode_id JOIN media m ON m.id=e.media_id ORDER BY m.title,e.season,e.number,e.id`)) {
      const key = `${source}:${subtitleId}`;
      const linked = episodes.get(key);
      if (linked) linked.push(episode);
      else episodes.set(key, [episode]);
    }
    return [...uploads, ...translations, ...online].map(row => ({ ...row, episodes: episodes.get(`${row.source}:${row.id}`) ?? [], complete: Boolean(row.complete) })).sort((a, b) => b.createdAt - a.createdAt);
  }

  content(source: SavedSubtitle['source'], id: string) {
    const row = source === 'upload'
      ? this.db.get<{ name: string; format: 'ass' | 'vtt'; content: string }>('SELECT filename AS name,format,content FROM uploaded_subtitles WHERE id=?', id)
      : source === 'online'
        ? this.db.get<{ name: string; format: 'ass' | 'vtt'; content: string }>("SELECT creator_name || ' · 한국어' AS name,format,content FROM online_subtitles WHERE id=?", id)
        : this.db.get<{ name: string; format: 'ass' | 'vtt'; content: string }>("SELECT '한국어 AI 번역' AS name,format,content FROM translation_cache WHERE key=? AND content IS NOT NULL", id);
    if (!row) throw new ApiFailure(404, 'subtitle-not-found');
    return row;
  }

  remove(source: SavedSubtitle['source'], id: string) {
    this.content(source, id);
    if (source === 'translation') this.translations.removeSaved(id);
    else if (source === 'online') this.online.remove(this.db.get('SELECT episode_id FROM online_subtitles WHERE id=?', id)!.episode_id, id);
    else this.db.run('DELETE FROM uploaded_subtitles WHERE id=?', id);
  }
}
