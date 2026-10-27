/** TMDB language/official flags are ranking hints, not viewer-country availability. */
export function trailerCandidates(results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  const videos = results.filter(v => v && v.site === 'YouTube' && ['Trailer', 'Teaser'].includes(v.type)
    && typeof v.key === 'string' && /^[A-Za-z0-9_-]{11}$/.test(v.key));
  videos.sort((a,b) => Number(b.iso_639_1 === 'ko') - Number(a.iso_639_1 === 'ko')
    || Number(b.official === true) - Number(a.official === true)
    || Number(b.type === 'Trailer') - Number(a.type === 'Trailer'));
  return [...new Set<string>(videos.map(v => v.key))].slice(0,5);
}
