import { DatabaseSync } from 'node:sqlite';
import { kidsAllowed, certificationAge } from '../src/profiles/kids.js';

// Run only against a copy. Never use Store: it runs migrations and enables WAL.
const file = process.argv[2];
if (!file?.startsWith('/tmp/')) throw new Error('Pass a copied /tmp/.../moa.db');
const db = new DatabaseSync(file, { readOnly: true });
try {
  const integrity = db.prepare('PRAGMA quick_check').all();
  const rows = db.prepare(`SELECT m.metadata,t.card FROM media m
    LEFT JOIN tmdb_links l ON l.media_id=m.id AND l.status IN ('auto','manual')
    LEFT JOIN tmdb_titles t ON t.kind=l.kind AND t.tmdb_id=l.tmdb_id`).all().map(r => ({ meta: JSON.parse(String(r.metadata)), info: r.card ? JSON.parse(String(r.card)) : undefined }));
  const stats = (items: typeof rows) => {
    const allowed = items.filter(r => !r.meta.adult && kidsAllowed(r.info)).length;
    const unrated = items.filter(r => !r.info?.certification?.trim()).length;
    return { total: items.length, allowed, blocked: items.length - allowed, unrated, unratedPercent: items.length ? +(100 * unrated / items.length).toFixed(2) : 0,
      unlinked: items.filter(r => !r.info).length,
      unknownRating: items.filter(r => r.info?.certification?.trim() && certificationAge(r.info.certification) === undefined).length,
      adult: items.filter(r => r.meta.adult || r.info?.adult).length,
      legacyAdultUnknown: items.filter(r => r.info && r.info.adult === undefined).length };
  };
  console.log(JSON.stringify({ integrity, all: stats(rows), local: stats(rows.filter(r => !r.meta.provider || r.meta.provider.kind === 'local')), remote: stats(rows.filter(r => r.meta.provider && r.meta.provider.kind !== 'local')) }, null, 2));
} finally { db.close(); }
