document.body.innerHTML = '<h2>Genre labels</h2><p style="color:var(--moa-muted)">Catalog badges show each title’s first genre.</p>';
moa.on('ready', () => moa.ui.resize(120).catch(() => {}));
moa.hooks.register('catalog.transform', ({ items }) => items
  .filter(item => item.genres?.length)
  .map(item => ({ id: item.id, badge: item.genres[0] }))
).catch(error => { document.body.textContent = error.message; });
