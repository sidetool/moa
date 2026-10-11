// Data only: MOA renders reviews with its existing title-page typography and controls.
moa.hooks.register('title.reviews', async ({mediaId,provider,selection}) => {
  if (!['tmdb','anilist'].includes(provider) || typeof moa.reviews?.list !== 'function') throw new Error('Reviews SDK unavailable');
  const result = await moa.reviews.list(provider,selection);
  if (!result || result.mediaId !== mediaId || result.provider !== provider) throw new Error('Title changed');
  return result;
}).catch(() => {});
