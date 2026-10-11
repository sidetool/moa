// Supplies credits and a person's other works to MOA's own title-page cast row through the `title.people` hook.
// MOA renders and validates the answers; this plugin has no interface, network origins, or image downloads.
// Only TMDB is supported, because MOA's attribution and image rules for this feature exist only for TMDB.
const PROVIDER = 'tmdb';

/** Passes through only answers for the requested title from the supported provider. */
function checked(result, mediaId) {
  if (!result || typeof result !== 'object' || result.provider !== PROVIDER) throw new Error('Unsupported provider');
  if (result.status === 'ready' && result.title?.mediaId !== mediaId) throw new Error('Title changed');
  return result;
}

moa.hooks.register('title.people', async request => {
  if (!request || typeof request !== 'object' || typeof request.mediaId !== 'string') throw new Error('Invalid request');
  if (typeof moa.metadata?.credits !== 'function') throw new Error('Metadata SDK unavailable');
  if (request.action === 'credits') return checked(await moa.metadata.credits(), request.mediaId);
  if (request.action === 'person') {
    const { provider, id } = request.person || {};
    if (provider !== PROVIDER || typeof id !== 'string' || !id) throw new Error('Unsupported person');
    // The identity is passed through unchanged: provider IDs are opaque strings.
    return checked(await moa.metadata.person({ provider, id }), request.mediaId);
  }
  throw new Error('Unknown request');
}).catch(() => {});
