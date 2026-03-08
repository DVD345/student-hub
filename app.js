function renderWidgetToday() {
  const el = document.getElementById('w-today');
  if(!el) return;
  const now = Date.now()/1000;
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const todayEnd   = new Date(); todayEnd.setHours(23,59,59,999);
  const dlDel = typeof _dlDeleted!=='undefined' ? _dlDeleted : [];
  const urgH  = typeof _dlUrgentH!=='undefined' ? _dlUrgentH : 48;
  const items = allDl.filter(d =>
    !dlDel.includes(String(d.id)) &&
    d.due >= now &&
    d.due >= todayStart.getTime()/1000 &&
    d.due <= todayEnd.getTime()/1000
  );
  if(!items.length) { el.innerHTML='<div class="widget-empty">🎉 Сьогодні дедлайнів немає</div>'; return; }
  el.innerHTML = items.slice(0,4).map(d => {
    const t = new Date(d.due*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
    const diff = d.due - now;
    const color = diff < urgH*3600 ? 'var(--accent2)' : 'var(--warning)';
    const onclick = d.url&&d.url!=='#' ? "window.open('"+escHtml(d.url)+"','_blank')" : "go('deadlines')";
    return '<div class="widget-item" onclick="'+onclick+'" title="'+escHtml(d.name)+'">' +
      '<span class="widget-item-dot" style="background:'+color+'"></span>' +
      '<span class="widget-item-name">'+escHtml(d.name)+'</span>' +
      '<span class="widget-item-meta">'+t+'</span>' +
      '</div>';
  }).join('');
}
