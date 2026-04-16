
var MOODLE = 'https://moodle-proxy.dvdkunec.workers.dev';
let token='', userData={}, allDl=[], courses=[], group={}, userRole='student';
let unsubs=[], cachedFiles=[], cachedMats=[], currentChatRoom=null, chatUnsub=null;
let cvMode='grid', csMode='name';
var _chatUsers = [];
var _chatDmRooms = [];

// ── XSS PROTECTION ──
function escHtml(t) { return (t==null?'':String(t)).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#039;'); }

// ══════════════════════════════════════════════
// ✅ IMPROVEMENT 1: Debounced batch renderer
// Replaces multiple sequential applyDlFilter() + renderDashDl() + renderDashWidgets() + renderCalendar() calls
// ══════════════════════════════════════════════
var _renderTimer = null;
function scheduleRender() {
  clearTimeout(_renderTimer);
  _renderTimer = setTimeout(function() {
    applyDlFilter();
    renderDashDl();
    renderDashWidgets();
    renderCalendar();
    _renderCalNotesInDeadlines();
  }, 50);
}

// ✅ IMPROVEMENT 3: Generic debounce utility
function debounce(fn, ms) {
  var t;
  return function() {
    var args = arguments;
    clearTimeout(t);
    t = setTimeout(function(){ fn.apply(null, args); }, ms);
  };
}

// ── COURSE CALC ──
function calcCourse(entryYear) {
  const now = new Date();
  const acadYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  return Math.min(Math.max(acadYear - entryYear + 1, 1), 6);
}
function getGroupCourse(g) {
  if(g.manualCourse) return g.manualCourse;
  if(g.entryYear) return calcCourse(g.entryYear);
  return g.course || '?';
}

// ── ROLES ──
var ROLES = { superadmin:'🔴 Супер-адмін', admin:'🟠 Адмін', moderator:'🟡 Модератор', student:'🟢 Студент' };
var ROLE_COLORS = { superadmin:'#e05050', admin:'#f0a030', moderator:'#f0c040', student:'#40d080' };
function canAdmin() { return ['superadmin','admin'].includes(userRole); }
function canMod() { return ['superadmin','admin','moderator'].includes(userRole); }
var _adminGroups = [];
var _allAdminUsers = [];

// ── AUTH ──
async function doLogin() {
  const username = document.getElementById('li').value.trim();
  const password = document.getElementById('lp').value;
  const btn = document.getElementById('login-btn');
  const err = document.getElementById('lerr');
  err.style.display='none';
  if (!username||!password) { showErr('Введіть логін та пароль'); return; }
  btn.disabled=true; btn.textContent='Входимо...';
  try {
    const r = await fetch(MOODLE+'/login/token.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username, password, service: 'moodle_mobile_app' })
    });
    const d = await r.json();
    if (!d.token) { showErr(d.error || 'Невірний логін або пароль'); btn.disabled=false; btn.textContent='Увійти'; return; }
    token = d.token;

    btn.textContent='Визначаємо групу...';
    const siteData = await moodleCall('core_webservice_get_site_info');

    const roles = Array.isArray(siteData.roles) ? siteData.roles : [];
    const teacherShortnames = ['teacher','editingteacher','coursecreator','manager'];
    const isTeacher = roles.some(r =>
      teacherShortnames.includes((r.shortname||'').toLowerCase()) || [1,2,3,4].includes(Number(r.roleid))
    );
    if (isTeacher) {
      token = '';
      showErr('Цей портал лише для студентів. Викладачі не можуть увійти.');
      btn.disabled=false; btn.textContent='Увійти'; return;
    }

    const userId = siteData.userid;
    let moodleGroupName = null;
    let moodleFaculty = null;

    try {
      const cohorts = await moodleCall('core_cohort_get_user_cohorts', { userid: userId });
      if(Array.isArray(cohorts) && cohorts.length) {
        moodleGroupName = cohorts[0].name || cohorts[0].idnumber;
        moodleFaculty = cohorts[0].description || cohorts[0].theme || null;
        if(moodleFaculty) moodleFaculty = moodleFaculty.replace(/<[^>]*>/g,'').trim() || null;
      }
    } catch(e) {}

    if(!moodleGroupName) {
      try {
        const enrolledCourses = await moodleCall('core_enrol_get_users_courses', { userid: userId });
        if(Array.isArray(enrolledCourses) && enrolledCourses.length) {
          for(const course of enrolledCourses.slice(0,5)) {
            try {
              const grps = await moodleCall('core_group_get_course_user_groups', { courseid: course.id, userid: userId });
              if(grps && Array.isArray(grps.groups) && grps.groups.length) {
                moodleGroupName = grps.groups[0].name;
                break;
              }
            } catch(e2) {}
          }
        }
      } catch(e) {}
    }

    if(!moodleGroupName) {
      try {
        const enrolledCourses = await moodleCall('core_enrol_get_users_courses', { userid: userId });
        if(Array.isArray(enrolledCourses) && enrolledCourses.length) {
          for(const c of enrolledCourses) {
            const match = (c.fullname||'').match(/\b([А-ЯІЇЄA-Z]{1,5}-?\d{2,4}[А-ЯA-Z]?\d{0,2})\b/i);
            if(match) { moodleGroupName = match[1]; break; }
          }
        }
      } catch(e) {}
    }

    if(!moodleGroupName) {
      await showGroupFallback(token, siteData);
      btn.disabled=false; btn.textContent='Увійти';
      return;
    }

    btn.textContent='Синхронізація...';
    group = await findOrCreateGroup(moodleGroupName, moodleFaculty);
    localStorage.setItem('sh_token', token);
    localStorage.setItem('sh_creds', btoa(unescape(encodeURIComponent(username + ':' + password))));
    localStorage.setItem('sh_gid', group.id);
    await initApp();

  } catch(e) { console.error('Login error:', e); showErr('Помилка підключення'); }
  btn.disabled=false; btn.textContent='Увійти';
}

async function findOrCreateGroup(name, faculty) {
  const { collection, getDocs, addDoc } = window._fb;
  const snap = await getDocs(collection(window._db, 'groups'));
  const existing = snap.docs.map(d=>({id:d.id,...d.data()}))
    .find(g => (g.name||'').toLowerCase().trim() === name.toLowerCase().trim());
  if(existing) return existing;

  const now2 = new Date();
  const acadYear = now2.getMonth() >= 7 ? now2.getFullYear() : now2.getFullYear() - 1;
  let course = 1, entryYear = null, manualCourse = null;
  const yearMatch = name.match(/[ДД]?(\d{2})$/i) || name.match(/(\d{4})/);
  if(yearMatch) {
    let yr = parseInt(yearMatch[1]);
    if(yr < 100) yr += 2000;
    course = Math.min(Math.max(acadYear - yr + 1, 1), 6);
    entryYear = yr;
  }
  const newDoc = await addDoc(collection(window._db,'groups'), {
    name, faculty: faculty || '', course, entryYear, manualCourse,
    createdAt: Date.now(), autoCreated: true
  });
  if(window._loadGroupsForLogin) window._loadGroupsForLogin();
  return { id: newDoc.id, name, faculty: faculty||'', course, entryYear };
}

async function showGroupFallback(tok, siteData) {
  showErr('Не вдалося визначити групу автоматично. Оберіть групу вручну:');
  let sel = document.getElementById('lg-fallback');
  if(!sel) {
    sel = document.createElement('select');
    sel.id = 'lg-fallback';
    sel.className = 'field';
    sel.style.cssText = 'width:100%;background:var(--bg3);border:1px solid var(--border);border-radius:var(--r);padding:11px 13px;color:var(--text);font-family:Inter,sans-serif;font-size:13px;outline:none;margin-top:8px;-webkit-appearance:none;';
    sel.innerHTML = '<option value="">— Оберіть групу —</option>';
    const { collection, getDocs } = window._fb;
    const gsnap = await getDocs(collection(window._db,'groups'));
    const groups = gsnap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.name||'').localeCompare(b.name||''));
    groups.forEach(g => { sel.innerHTML += '<option value="'+escHtml(g.id)+'">'+escHtml(g.name)+'</option>'; });
    document.getElementById('lerr').after(sel);
    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'btn-primary';
    confirmBtn.style.marginTop = '8px';
    confirmBtn.textContent = 'Продовжити';
    confirmBtn.onclick = async () => {
      const gid = sel.value;
      if(!gid) { showErr('Оберіть групу'); return; }
      confirmBtn.disabled=true; confirmBtn.textContent='Входимо...';
      const { doc, getDoc } = window._fb;
      const gSnap = await getDoc(doc(window._db,'groups',gid));
      if(!gSnap.exists()) { showErr('Групу не знайдено'); confirmBtn.disabled=false; confirmBtn.textContent='Продовжити'; return; }
      group = { id: gid, ...gSnap.data() };
      sel.remove(); confirmBtn.remove();
      localStorage.setItem('sh_token', tok);
      localStorage.setItem('sh_gid', gid);
      await initApp();
    };
    sel.after(confirmBtn);
  }
}

function showErr(msg) { const e=document.getElementById('lerr'); e.textContent=msg; e.style.display='block'; }
document.getElementById('lp').addEventListener('keydown', e => { if(e.key==='Enter') doLogin(); });
document.getElementById('li').addEventListener('keydown', e => { if(e.key==='Enter') document.getElementById('lp').focus(); });

// ══════════════════════════════════════════════
// LOGIN CANVAS ANIMATION
// ✅ IMPROVEMENT 4: store RAF id, cancel on login
// ══════════════════════════════════════════════
var _loginRafId = null;
(function() {
  const canvas = document.getElementById('login-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let W, H, particles = [], rails = [], trains = [];
  const COLORS = ['#f0c040','#3a7fff','#38c870','#cccccc'];

  function resize() {
    W = canvas.width = window.innerWidth;
    H = canvas.height = window.innerHeight;
    buildRails();
  }

  function buildRails() {
    rails = [
      {x1:0,y1:H*.15,x2:W,y2:H*.15},
      {x1:0,y1:H*.38,x2:W,y2:H*.38},
      {x1:0,y1:H*.6,x2:W,y2:H*.6},
      {x1:0,y1:H*.82,x2:W,y2:H*.82},
      {x1:0,y1:H*.7,x2:W,y2:H*.05},
      {x1:0,y1:H,x2:W*.65,y2:0},
    ];
    trains = rails.map((r,i) => ({
      rail:r, t:Math.random(),
      speed:(.0003+Math.random()*.0005)*(Math.random()>.5?1:-1),
      color:COLORS[i%COLORS.length],
      len:.07+Math.random()*.1
    }));
  }

  function initParticles() {
    particles = Array.from({length:70},()=>({
      x:Math.random()*W, y:Math.random()*H,
      r:.4+Math.random()*1.2,
      phase:Math.random()*Math.PI*2,
      speed:.005+Math.random()*.01,
      dy:-.015-Math.random()*.04,
    }));
  }

  function lerp(a,b,t){return a+(b-a)*t;}

  function drawRail(r) {
    const dx=r.y2-r.y1, dy=r.x1-r.x2;
    const len=Math.sqrt(dx*dx+dy*dy)||1;
    const ox=(dx/len)*5, oy=(dy/len)*5;
    ctx.strokeStyle='rgba(255,255,255,.035)';
    ctx.lineWidth=1;
    ctx.beginPath(); ctx.moveTo(r.x1,r.y1); ctx.lineTo(r.x2,r.y2); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(r.x1+ox,r.y1+oy); ctx.lineTo(r.x2+ox,r.y2+oy); ctx.stroke();
    const steps=Math.floor(Math.sqrt((r.x2-r.x1)**2+(r.y2-r.y1)**2)/30);
    for(let i=0;i<=steps;i++){
      const t=i/steps;
      const sx=lerp(r.x1,r.x2,t), sy=lerp(r.y1,r.y2,t);
      ctx.strokeStyle='rgba(255,255,255,.02)';
      ctx.lineWidth=1.5;
      ctx.beginPath();
      ctx.moveTo(sx-oy*1.2, sy-ox*1.2);
      ctx.lineTo(sx+oy*1.2+ox, sy+ox*1.2+oy);
      ctx.stroke();
    }
  }

  function drawTrain(tr) {
    const r=tr.rail;
    const t0=((tr.t%1)+1)%1;
    const t1=((tr.t+tr.len)%1+1)%1;
    const x0=lerp(r.x1,r.x2,t0),y0=lerp(r.y1,r.y2,t0);
    const x1=lerp(r.x1,r.x2,t1),y1=lerp(r.y1,r.y2,t1);
    const g=ctx.createLinearGradient(x0,y0,x1,y1);
    g.addColorStop(0,'transparent');
    g.addColorStop(.5,tr.color+'44');
    g.addColorStop(1,tr.color+'bb');
    ctx.beginPath(); ctx.strokeStyle=g; ctx.lineWidth=2;
    ctx.moveTo(x0,y0); ctx.lineTo(x1,y1); ctx.stroke();
    ctx.beginPath(); ctx.arc(x1,y1,2.5,0,Math.PI*2);
    ctx.fillStyle=tr.color; ctx.shadowColor=tr.color; ctx.shadowBlur=12;
    ctx.fill(); ctx.shadowBlur=0;
  }

  function tick() {
    // ✅ Check stop flag before scheduling next frame
    if(window._loginAnimStop) { _loginRafId = null; return; }
    ctx.clearRect(0,0,W,H);
    particles.forEach(p=>{
      p.phase+=p.speed; p.y+=p.dy;
      if(p.y<0){p.y=H;p.x=Math.random()*W;}
      ctx.beginPath(); ctx.arc(p.x,p.y,p.r,0,Math.PI*2);
      ctx.fillStyle=`rgba(255,255,255,${Math.abs(Math.sin(p.phase))*.35})`;
      ctx.fill();
    });
    rails.forEach(drawRail);
    trains.forEach(tr=>{ tr.t+=tr.speed; drawTrain(tr); });
    const sy=(Date.now()*.00004%1)*H;
    const sg=ctx.createLinearGradient(0,sy-80,0,sy+80);
    sg.addColorStop(0,'transparent');
    sg.addColorStop(.5,'rgba(240,192,64,.018)');
    sg.addColorStop(1,'transparent');
    ctx.fillStyle=sg; ctx.fillRect(0,sy-80,W,160);
    _loginRafId = requestAnimationFrame(tick);
  }

  window.addEventListener('resize',()=>{resize();initParticles();});
  resize(); initParticles(); tick();
})();

async function initApp() {
  // ✅ IMPROVEMENT 4: cancel canvas RAF immediately
  window._loginAnimStop = true;
  if(_loginRafId) { cancelAnimationFrame(_loginRafId); _loginRafId = null; }

  // Fix black gap under bottom nav on iPhone
  setTimeout(function() {
    var nav = document.getElementById('bottom-nav');
    if(!nav) return;
    // Force re-apply padding with !important via inline style
    nav.style.setProperty('padding-bottom', 'max(20px, env(safe-area-inset-bottom, 20px))', 'important');
  }, 300);

  const loginScreen = document.getElementById('screen-login');
  const appScreen = document.getElementById('screen-app');
  loginScreen.style.transition = 'opacity .35s ease, transform .35s ease';
  loginScreen.style.opacity = '0';
  loginScreen.style.transform = 'scale(.97)';
  setTimeout(() => {
    loginScreen.classList.remove('active');
    loginScreen.style.cssText = '';
    appScreen.style.opacity = '0';
    appScreen.style.transform = 'translateY(16px)';
    appScreen.classList.add('active');
    appScreen.style.transition = 'opacity .35s ease, transform .35s ease';
    requestAnimationFrame(() => { appScreen.style.opacity='1'; appScreen.style.transform='translateY(0)'; });
    setTimeout(() => { appScreen.style.cssText = ''; }, 400);
  }, 320);

  document.getElementById('gpill').textContent = '📌 ' + group.name;
  document.getElementById('files-lbl').textContent = group.name;
  document.getElementById('mats-lbl').textContent = group.name;

  _loadCachedData();
  _setupDebouncedInputs();
  _enableAdminCardResize();
  _applyUiFontScale();
  _applySidebarWidth();
  _initSidebarResizer();
  _initDeadlinesWidthResizer();
  _applyDeadlinesWidth();
  // Clear any browser-restored input values
  var chatInp = document.getElementById('chat-inp');
  if(chatInp) chatInp.value = '';
  var aiInp = document.getElementById('ai-inp');
  if(aiInp) aiInp.value = '';

  await loadUserInfo();
  await loadUserRole();
  _initChatDmRoomsSync();
  _initNotificationsSync();
  setupNav();
  await startUserSettingsSync();

  // ✅ IMPROVEMENT 2: load courses and deadlines in PARALLEL
  await syncMoodle();

  listenFiles(); listenMats(); setupChatRooms();
  if (canAdmin()) listenAdminData();
  loadNotes();
  loadNotifications();
  renderCalendar();
  _applyDynamicLayouts();
  scheduleDeadlineNotifs();
  updateBellCount();
  _startPresence();
}

// ✅ IMPROVEMENT 3: Wire up all debounced search inputs
function _setupDebouncedInputs() {
  // Mobile keyboard detection — update --vh and scroll chat to bottom
  function _updateVH() {
    document.documentElement.style.setProperty('--vh', window.innerHeight * 0.01 + 'px');
  }
  _updateVH();
  window.addEventListener('resize', function() {
    _updateVH();
    var wasKeyboard = document.body.classList.contains('keyboard-open');
    // If viewport shrunk by >150px — keyboard opened
    var keyboardOpen = window.innerHeight < (window._fullHeight || window.innerHeight) - 150;
    if(!window._fullHeight) window._fullHeight = window.innerHeight;
    if(window.innerHeight > window._fullHeight - 50) window._fullHeight = window.innerHeight;
    document.body.classList.toggle('keyboard-open', keyboardOpen);
    if(_currentPage === 'chat') {
      setTimeout(function() {
        var msgs = document.getElementById('chat-msgs');
        if(msgs) msgs.scrollTop = msgs.scrollHeight;
      }, 100);
    }
  });
  const dlQ = document.getElementById('dl-q');
  if(dlQ) dlQ.oninput = debounce(applyDlFilter, 200);

  const cQ = document.getElementById('c-q');
  if(cQ) cQ.oninput = debounce(filterCourses, 200);

  const filesInp = document.getElementById('files-search-inp');
  if(filesInp) filesInp.oninput = debounce(function(){ filesSearchQuery=filesInp.value; renderFilesWithSearch(cachedFiles, filesInp.value); }, 200);

  const matsInp = document.getElementById('mats-search-inp');
  if(matsInp) matsInp.oninput = debounce(function(){ filterMats(matsInp.value); }, 200);

  const notesInp = document.getElementById('notes-search-inp');
  if(notesInp) notesInp.oninput = debounce(function(){ searchNotes(notesInp.value); }, 200);

  const usersSearch = document.getElementById('users-search');
  if(usersSearch) usersSearch.oninput = debounce(function(){ filterAdminUsers(usersSearch.value); }, 200);
}

function _applyDynamicLayouts() {
  var content = document.querySelector('.content');
  var pageChat = document.getElementById('page-chat');
  var chatWrap = pageChat ? pageChat.querySelector('.chat-wrap') : null;
  var chatSidebar = document.getElementById('chat-rooms');
  var chatSection = chatSidebar ? chatSidebar.firstElementChild : null;
  var chatMain = pageChat ? pageChat.querySelector('.chat-main') : null;
  var chatMsgs = document.getElementById('chat-msgs');
  var chatHeader = pageChat ? pageChat.querySelector('.page-header') : null;
  var isChat = _currentPage === 'chat' && pageChat;
  var mobile = window.innerWidth <= 899;

  if(content) content.style.overflow = isChat ? 'hidden' : '';
  if(!isChat || !chatWrap || !chatSidebar || !chatMain) return;

  if(mobile) {
    if(chatHeader) chatHeader.style.display = 'none';
    chatWrap.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;border:none;background:transparent;border-radius:0;';
    chatSidebar.style.cssText = 'display:block;width:100%;overflow-x:auto;overflow-y:hidden;padding:8px 0 10px;background:transparent;border:none;flex:0 0 auto;';
    if(chatSection) {
      chatSection.style.cssText = 'display:flex;flex-direction:row;align-items:stretch;gap:8px;width:max-content;min-width:max-content;padding:0 10px;';
    }
    chatSidebar.querySelectorAll('.chat-sidebar-divider,.chat-sidebar-caption').forEach(function(el){
      el.style.display = 'none';
    });
    chatSidebar.querySelectorAll('.chat-room,.chat-add-btn').forEach(function(el){
      el.style.minWidth = '210px';
      el.style.maxWidth = '210px';
      el.style.width = '210px';
      el.style.flexShrink = '0';
    });
    chatMain.style.cssText = 'display:flex;flex-direction:column;flex:1;min-height:0;overflow:hidden;background:var(--card);border-top:1px solid var(--border);border-radius:16px 16px 0 0;';
    if(chatMsgs) chatMsgs.style.cssText += ';flex:1;min-height:0;overflow-y:auto;-webkit-overflow-scrolling:touch;';
  } else {
    if(chatHeader) chatHeader.style.display = '';
    chatWrap.style.cssText = 'display:flex;flex-direction:row;align-items:stretch;gap:0;flex:1;min-height:0;overflow:hidden;background:var(--card);border:1px solid var(--border);border-radius:16px;';
    chatSidebar.style.cssText = 'display:flex;flex-direction:column;width:280px;flex:0 0 280px;overflow-y:auto;overflow-x:hidden;padding:12px 10px;background:var(--card);border-right:1px solid var(--border);border-bottom:none;';
    if(chatSection) {
      chatSection.style.cssText = 'display:flex;flex-direction:column;gap:6px;width:100%;min-width:0;padding:0;';
    }
    chatSidebar.querySelectorAll('.chat-sidebar-divider').forEach(function(el){
      el.style.display = '';
    });
    chatSidebar.querySelectorAll('.chat-sidebar-caption').forEach(function(el){
      el.style.display = '';
    });
    chatSidebar.querySelectorAll('.chat-room,.chat-add-btn').forEach(function(el){
      el.style.minWidth = '';
      el.style.maxWidth = '';
      el.style.width = '100%';
      el.style.flexShrink = '';
    });
    chatMain.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0;min-height:calc(100vh - 220px);overflow:hidden;background:var(--card);border:none;border-radius:0;';
    if(chatMsgs) chatMsgs.style.cssText += ';flex:1;min-height:0;overflow-y:auto;';
  }
}

function _enableAdminCardResize() {
  var grid = document.querySelector('#page-admin .admin-grid');
  if(!grid) return;
  document.querySelectorAll('#page-admin .admin-card').forEach(function(card){
    card.style.resize = 'none';
    card.style.minWidth = '260px';
    card.style.minHeight = '180px';
    card.style.maxWidth = '';
    _restoreAdminCardLayout(card);
    if(card.dataset.resizeReady === '1') return;
    card.dataset.resizeReady = '1';

    var head = card.querySelector('h3');
    if(head) head.addEventListener('mousedown', function(e){ _startAdminDrag(e, card); });

    ['n','e','s','w','ne','nw','se','sw'].forEach(function(dir){
      var h = document.createElement('div');
      h.className = 'admin-resize-handle';
      h.dataset.dir = dir;
      h.addEventListener('mousedown', function(e){ _startAdminResize(e, card, dir); });
      card.appendChild(h);
    });
  });
  _applyAdminDesktopLayout();
}
function _getAdminGrid() {
  return document.querySelector('#page-admin .admin-grid');
}
function _adminResizeStorageKey(card) {
  var key = card && card.dataset ? card.dataset.resizeKey : '';
  return key ? 'sh_admin_card_v3_' + key : '';
}
function _defaultAdminCardLayout(card, gridWidth) {
  var key = card && card.dataset ? card.dataset.resizeKey : '';
  var width = Math.max(960, gridWidth || (_getAdminGrid() ? _getAdminGrid().clientWidth : 1400) || 1400);
  var groupsW = Math.max(320, Math.min(360, Math.round(width * 0.24)));
  var statsW = Math.max(230, Math.min(270, Math.round(width * 0.18)));
  var usersW = Math.max(520, width - groupsW - statsW - 80);
  if(key === 'groups') return { x: 20, y: 20, w: groupsW, h: 430 };
  if(key === 'users') return { x: groupsW + 40, y: 20, w: usersW, h: 560 };
  if(key === 'stats') return { x: groupsW + usersW + 60, y: 20, w: statsW, h: 300 };
  return { x: 20, y: 20, w: 320, h: 260 };
}
function _restoreAdminCardLayout(card) {
  var storageKey = _adminResizeStorageKey(card);
  var layout = _defaultAdminCardLayout(card);
  if(!storageKey) {
    _applyAdminCardLayout(card, layout);
    return;
  }
  try {
    var raw = localStorage.getItem(storageKey);
    if(raw) {
      var saved = JSON.parse(raw);
      if(saved && typeof saved === 'object') layout = Object.assign(layout, saved);
    }
  } catch(e) {}
  _applyAdminCardLayout(card, layout);
}
function _saveAdminCardSize(card) {
  var storageKey = _adminResizeStorageKey(card);
  if(!storageKey) return;
  try {
    localStorage.setItem(storageKey, JSON.stringify({
      x: Math.round(parseFloat(card.style.left) || 0),
      y: Math.round(parseFloat(card.style.top) || 0),
      w: Math.round(card.offsetWidth),
      h: Math.round(card.offsetHeight)
    }));
  } catch(e) {}
}
function _applyAdminCardLayout(card, layout) {
  if(!card || !layout) return;
  card.style.width = Math.max(260, layout.w || 320) + 'px';
  card.style.height = Math.max(180, layout.h || 260) + 'px';
  card.style.left = Math.max(0, layout.x || 0) + 'px';
  card.style.top = Math.max(0, layout.y || 0) + 'px';
}
function _rectOverlapArea(a, b) {
  var x = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  var y = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return x * y;
}
function _adminHasSavedLayout() {
  var has = false;
  document.querySelectorAll('#page-admin .admin-card').forEach(function(card){
    if(localStorage.getItem(_adminResizeStorageKey(card))) has = true;
  });
  return has;
}
function _adminLayoutsLookBroken(gridWidth) {
  var cards = Array.from(document.querySelectorAll('#page-admin .admin-card'));
  var layouts = cards.map(function(card){
    return {
      key: card.dataset.resizeKey || '',
      x: parseFloat(card.style.left) || 0,
      y: parseFloat(card.style.top) || 0,
      w: parseFloat(card.style.width) || card.offsetWidth || _defaultAdminCardLayout(card, gridWidth).w,
      h: parseFloat(card.style.height) || card.offsetHeight || _defaultAdminCardLayout(card, gridWidth).h
    };
  });
  for(var i=0;i<layouts.length;i++) {
    var l = layouts[i];
    if(l.x < 0 || l.y < 0 || l.w < 260 || l.h < 180 || l.x > gridWidth - 40) return true;
    for(var j=i+1;j<layouts.length;j++) {
      var overlap = _rectOverlapArea(l, layouts[j]);
      if(overlap > Math.min(l.w * l.h, layouts[j].w * layouts[j].h) * 0.28) return true;
    }
  }
  return false;
}
function resetAdminCardLayout() {
  var grid = _getAdminGrid();
  if(!grid) return;
  var width = grid.clientWidth || 1400;
  document.querySelectorAll('#page-admin .admin-card').forEach(function(card){
    var next = _clampAdminCard(card, _defaultAdminCardLayout(card, width));
    _applyAdminCardLayout(card, next);
    _saveAdminCardSize(card);
  });
  _updateAdminGridHeight();
}
function _clampAdminCard(card, next) {
  var grid = _getAdminGrid();
  if(!grid) return next;
  var minW = 260, minH = 180;
  var maxW = Math.max(minW, grid.clientWidth - 20);
  var w = Math.max(minW, Math.min(maxW, next.w || card.offsetWidth || minW));
  var h = Math.max(minH, next.h || card.offsetHeight || minH);
  var maxX = Math.max(0, grid.clientWidth - w);
  var x = Math.max(0, Math.min(maxX, next.x || 0));
  var y = Math.max(0, next.y || 0);
  return { x:x, y:y, w:w, h:h };
}
function _updateAdminGridHeight() {
  var grid = _getAdminGrid();
  if(!grid || window.innerWidth < 900) return;
  var maxBottom = 0;
  grid.querySelectorAll('.admin-card').forEach(function(card){
    maxBottom = Math.max(maxBottom, card.offsetTop + card.offsetHeight);
  });
  grid.style.height = Math.max(720, maxBottom + 28) + 'px';
}
function _applyAdminDesktopLayout() {
  var grid = _getAdminGrid();
  if(!grid) return;
  if(window.innerWidth < 900) {
    grid.style.height = '';
    grid.querySelectorAll('.admin-card').forEach(function(card){
      card.style.left = '';
      card.style.top = '';
      card.style.width = '';
      card.style.height = '';
    });
    return;
  }
  var width = grid.clientWidth || 1400;
  if(!_adminHasSavedLayout() || _adminLayoutsLookBroken(width)) {
    resetAdminCardLayout();
    return;
  }
  grid.querySelectorAll('.admin-card').forEach(function(card){
    var next = _clampAdminCard(card, {
      x: parseFloat(card.style.left) || 0,
      y: parseFloat(card.style.top) || 0,
      w: parseFloat(card.style.width) || card.offsetWidth || _defaultAdminCardLayout(card, width).w,
      h: parseFloat(card.style.height) || card.offsetHeight || _defaultAdminCardLayout(card, width).h
    });
    _applyAdminCardLayout(card, next);
  });
  _updateAdminGridHeight();
}

function _deadlinesWidthStorageKey() {
  return 'sh_deadlines_page_width';
}
function _deadlinesFontStorageKey() {
  return 'sh_deadlines_font_multiplier';
}
function _uiFontStorageKey() {
  return 'sh_ui_font_scale';
}
function _sidebarWidthStorageKey() {
  return 'sh_sidebar_width';
}
function _defaultSidebarWidth() {
  return 256;
}
function _defaultDeadlinesWidth() {
  return 1280;
}
function _defaultDeadlinesFontScale() {
  return 1;
}
function _defaultUiFontScale() {
  return 1;
}
function _applyUiFontScale() {
  var root = document.documentElement;
  var appScreen = document.getElementById('screen-app');
  var loginScreen = document.getElementById('screen-login');
  var body = document.body;
  if(!root) return;
  var raw = parseFloat(localStorage.getItem(_uiFontStorageKey()) || _defaultUiFontScale());
  var scale = Math.max(0.82, Math.min(1.36, isNaN(raw) ? _defaultUiFontScale() : raw));
  var scaleStr = scale.toFixed(3);
  var canUseZoom = typeof CSS !== 'undefined' && CSS && typeof CSS.supports === 'function' && CSS.supports('zoom', '1');

  root.dataset.uiScaleMode = canUseZoom ? 'zoom' : 'fallback';
  root.style.setProperty('--ui-raw-scale', scaleStr);
  root.style.setProperty('--ui-font-scale', canUseZoom ? '1' : scaleStr);

  [appScreen, loginScreen, body].forEach(function(el){
    if(!el) return;
    el.style.zoom = '';
    el.style.transform = '';
    el.style.transformOrigin = '';
    el.style.width = '';
    el.style.height = '';
  });

  if(canUseZoom && body) {
    body.style.zoom = scaleStr;
  }

  requestAnimationFrame(function(){
    _applyDynamicLayouts();
    try { renderCalendar(); } catch(e) {}
    try { _updateAdminGridHeight(); } catch(e) {}
  });
}
function adjustUiFontScale(delta) {
  var current = parseFloat(localStorage.getItem(_uiFontStorageKey()) || _defaultUiFontScale());
  var next = Math.max(0.82, Math.min(1.36, (isNaN(current) ? _defaultUiFontScale() : current) + delta * 0.08));
  localStorage.setItem(_uiFontStorageKey(), String(next));
  _applyUiFontScale();
}
function resetUiFontScale() {
  localStorage.setItem(_uiFontStorageKey(), String(_defaultUiFontScale()));
  _applyUiFontScale();
}
function _applySidebarWidth() {
  var root = document.documentElement;
  if(!root) return;
  if(window.innerWidth < 900) {
    root.style.setProperty('--sidebar', '0px');
    return;
  }
  var raw = parseInt(localStorage.getItem(_sidebarWidthStorageKey()) || _defaultSidebarWidth(), 10);
  var width = Math.max(220, Math.min(360, isNaN(raw) ? _defaultSidebarWidth() : raw));
  root.style.setProperty('--sidebar', width + 'px');
}
function _applyDeadlinesWidth() {
  var page = document.getElementById('page-deadlines');
  if(!page) return;
  if(window.innerWidth < 900) {
    page.style.removeProperty('--deadlines-page-width');
    page.style.removeProperty('--dl-auto-scale');
    page.style.removeProperty('--dl-user-scale');
    page.style.removeProperty('--dl-item-pad-y');
    page.style.removeProperty('--dl-item-pad-x');
    return;
  }
  var raw = parseInt(localStorage.getItem(_deadlinesWidthStorageKey()) || _defaultDeadlinesWidth(), 10);
  var width = Math.max(980, Math.min(1500, isNaN(raw) ? _defaultDeadlinesWidth() : raw));
  var fontRaw = parseFloat(localStorage.getItem(_deadlinesFontStorageKey()) || _defaultDeadlinesFontScale());
  var fontScale = Math.max(0.82, Math.min(1.35, isNaN(fontRaw) ? _defaultDeadlinesFontScale() : fontRaw));
  var ratio = (width - 980) / (1500 - 980);
  var autoScale = 0.9 + ratio * 0.3;
  var padY = 10 + ratio * 6;
  var padX = 11 + ratio * 8;
  page.style.setProperty('--deadlines-page-width', width + 'px');
  page.style.setProperty('--dl-auto-scale', autoScale.toFixed(3));
  page.style.setProperty('--dl-user-scale', fontScale.toFixed(3));
  page.style.setProperty('--dl-item-pad-y', padY.toFixed(2) + 'px');
  page.style.setProperty('--dl-item-pad-x', padX.toFixed(2) + 'px');
}
function adjustDeadlinesWidth(delta) {
  var current = parseInt(localStorage.getItem(_deadlinesWidthStorageKey()) || _defaultDeadlinesWidth(), 10);
  var next = Math.max(980, Math.min(1500, (isNaN(current) ? _defaultDeadlinesWidth() : current) + delta));
  localStorage.setItem(_deadlinesWidthStorageKey(), String(next));
  _applyDeadlinesWidth();
}
function resetDeadlinesWidth() {
  localStorage.setItem(_deadlinesWidthStorageKey(), String(_defaultDeadlinesWidth()));
  _applyDeadlinesWidth();
}
function adjustDeadlinesFontSize(delta) {
  var current = parseFloat(localStorage.getItem(_deadlinesFontStorageKey()) || _defaultDeadlinesFontScale());
  var next = Math.max(0.82, Math.min(1.35, (isNaN(current) ? _defaultDeadlinesFontScale() : current) + delta * 0.08));
  localStorage.setItem(_deadlinesFontStorageKey(), String(next));
  _applyDeadlinesWidth();
}
function resetDeadlinesFontSize() {
  localStorage.setItem(_deadlinesFontStorageKey(), String(_defaultDeadlinesFontScale()));
  _applyDeadlinesWidth();
}
var _sidebarResizeState = null;
function _initSidebarResizer() {
  var handle = document.getElementById('sidebar-resizer');
  if(!handle || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';
  handle.addEventListener('mousedown', function(e){
    if(window.innerWidth < 900) return;
    e.preventDefault();
    document.body.classList.add('sidebar-resizing');
    var current = parseInt(localStorage.getItem(_sidebarWidthStorageKey()) || _defaultSidebarWidth(), 10);
    _sidebarResizeState = {
      startX: e.clientX,
      startWidth: isNaN(current) ? _defaultSidebarWidth() : current
    };
    document.addEventListener('mousemove', _onSidebarResizeMove);
    document.addEventListener('mouseup', _stopSidebarResize);
  });
}
function _onSidebarResizeMove(e) {
  if(!_sidebarResizeState) return;
  var next = Math.max(220, Math.min(360, _sidebarResizeState.startWidth + (e.clientX - _sidebarResizeState.startX)));
  localStorage.setItem(_sidebarWidthStorageKey(), String(next));
  _applySidebarWidth();
}
function _stopSidebarResize() {
  document.body.classList.remove('sidebar-resizing');
  document.removeEventListener('mousemove', _onSidebarResizeMove);
  document.removeEventListener('mouseup', _stopSidebarResize);
  _sidebarResizeState = null;
}
var _deadlinesResizeState = null;
function _initDeadlinesWidthResizer() {
  var handle = document.getElementById('dl-width-resizer');
  var page = document.getElementById('page-deadlines');
  if(!handle || !page || handle.dataset.bound === '1') return;
  handle.dataset.bound = '1';
  handle.addEventListener('mousedown', function(e){
    if(window.innerWidth < 900) return;
    e.preventDefault();
    document.body.classList.add('deadlines-resizing');
    var current = parseInt(localStorage.getItem(_deadlinesWidthStorageKey()) || _defaultDeadlinesWidth(), 10);
    _deadlinesResizeState = {
      startX: e.clientX,
      startWidth: isNaN(current) ? _defaultDeadlinesWidth() : current
    };
    document.addEventListener('mousemove', _onDeadlinesResizeMove);
    document.addEventListener('mouseup', _stopDeadlinesResize);
  });
}
function _onDeadlinesResizeMove(e) {
  if(!_deadlinesResizeState) return;
  var next = Math.max(980, Math.min(1500, _deadlinesResizeState.startWidth + (e.clientX - _deadlinesResizeState.startX)));
  localStorage.setItem(_deadlinesWidthStorageKey(), String(next));
  _applyDeadlinesWidth();
}
function _stopDeadlinesResize() {
  document.body.classList.remove('deadlines-resizing');
  document.removeEventListener('mousemove', _onDeadlinesResizeMove);
  document.removeEventListener('mouseup', _stopDeadlinesResize);
  _deadlinesResizeState = null;
}

var _adminResizeState = null;
var _adminDragState = null;
function _startAdminDrag(e, card) {
  if(window.innerWidth < 900) return;
  if(e.target && e.target.closest('.admin-resize-handle')) return;
  e.preventDefault();
  e.stopPropagation();
  card.classList.add('dragging');
  _adminDragState = {
    card: card,
    startX: e.clientX,
    startY: e.clientY,
    startLeft: parseFloat(card.style.left) || card.offsetLeft,
    startTop: parseFloat(card.style.top) || card.offsetTop
  };
  document.addEventListener('mousemove', _onAdminDragMove);
  document.addEventListener('mouseup', _stopAdminDrag);
}
function _onAdminDragMove(e) {
  if(!_adminDragState) return;
  var s = _adminDragState;
  var next = _clampAdminCard(s.card, {
    x: s.startLeft + (e.clientX - s.startX),
    y: s.startTop + (e.clientY - s.startY),
    w: s.card.offsetWidth,
    h: s.card.offsetHeight
  });
  _applyAdminCardLayout(s.card, next);
  _updateAdminGridHeight();
}
function _stopAdminDrag() {
  if(_adminDragState && _adminDragState.card) {
    _adminDragState.card.classList.remove('dragging');
    _saveAdminCardSize(_adminDragState.card);
  }
  document.removeEventListener('mousemove', _onAdminDragMove);
  document.removeEventListener('mouseup', _stopAdminDrag);
  _adminDragState = null;
}
function _startAdminResize(e, card, dir) {
  if(window.innerWidth < 900) return;
  e.preventDefault();
  e.stopPropagation();
  _adminResizeState = {
    card: card,
    dir: dir,
    startX: e.clientX,
    startY: e.clientY,
    startW: card.offsetWidth,
    startH: card.offsetHeight,
    startLeft: parseFloat(card.style.left) || card.offsetLeft,
    startTop: parseFloat(card.style.top) || card.offsetTop
  };
  document.addEventListener('mousemove', _onAdminResizeMove);
  document.addEventListener('mouseup', _stopAdminResize);
}
function _onAdminResizeMove(e) {
  if(!_adminResizeState) return;
  var s = _adminResizeState;
  var dx = e.clientX - s.startX;
  var dy = e.clientY - s.startY;
  var minW = 260, minH = 180;
  var x = s.startLeft;
  var y = s.startTop;
  var w = s.startW;
  var h = s.startH;
  if(s.dir.indexOf('e') !== -1) w = s.startW + dx;
  if(s.dir.indexOf('w') !== -1) { w = s.startW - dx; x = s.startLeft + dx; }
  if(s.dir.indexOf('s') !== -1) h = s.startH + dy;
  if(s.dir.indexOf('n') !== -1) { h = s.startH - dy; y = s.startTop + dy; }
  var next = _clampAdminCard(s.card, {
    x: x,
    y: y,
    w: Math.max(minW, w),
    h: Math.max(minH, h)
  });
  _applyAdminCardLayout(s.card, next);
  _updateAdminGridHeight();
}
function _stopAdminResize() {
  if(_adminResizeState && _adminResizeState.card) _saveAdminCardSize(_adminResizeState.card);
  document.removeEventListener('mousemove', _onAdminResizeMove);
  document.removeEventListener('mouseup', _stopAdminResize);
  _adminResizeState = null;
}

function _saveCache() {
  try {
    if(userData && userData.userid) localStorage.setItem('sh_cache_user', JSON.stringify(userData));
    if(group && group.id) localStorage.setItem('sh_cache_group', JSON.stringify(group));
    if(courses && courses.length) localStorage.setItem('sh_cache_courses', JSON.stringify(courses));
    if(allDl && allDl.length) localStorage.setItem('sh_cache_dl', JSON.stringify(allDl));
    localStorage.setItem('sh_cache_ts', Date.now());
  } catch(e) {}
}

function _loadCachedData() {
  try {
    const cachedUser = localStorage.getItem('sh_cache_user');
    const cachedGroup = localStorage.getItem('sh_cache_group');
    const cachedCourses = localStorage.getItem('sh_cache_courses');
    const cachedDl = localStorage.getItem('sh_cache_dl');
    const cacheTs = localStorage.getItem('sh_cache_ts');

    if(cachedUser) {
      userData = JSON.parse(cachedUser);
      const name = userData.fullname || 'Студент';
      document.getElementById('uname').textContent = name;
      document.getElementById('uav').textContent = name[0].toUpperCase();
      const today = new Date().toLocaleDateString('uk-UA',{weekday:'long',day:'numeric',month:'long'});
      document.getElementById('dash-sub').textContent = today + ' • ' + name;
      var dashSubHome = document.getElementById('dash-sub-home');
      if(dashSubHome) dashSubHome.textContent = today + ' • ' + name + ' • ' + (group.name || 'Група');
      // ── Передзавантажуємо overrides/settings з localStorage ──
      // щоб перший рендер (до відповіді Firebase) вже мав правильні дані
      // і завдання не "мигали" (з'являлись/пропадали)
      try {
        const localSettings = localStorage.getItem('ush_'+userData.userid);
        if(localSettings) {
          const ls = JSON.parse(localSettings);
          if(ls.dlOverrides && typeof ls.dlOverrides==='object') _dlOverrides = ls.dlOverrides;
          if(Array.isArray(ls.dlDeleted)) _dlDeleted = ls.dlDeleted;
          if(ls.dlUrgentH) _dlUrgentH = ls.dlUrgentH;
          if(ls.dlWarnD)   _dlWarnD   = ls.dlWarnD;
          if(ls.calNotes && typeof ls.calNotes==='object') _calNotes = ls.calNotes;
        }
      } catch(e2) {}
    }
    if(cachedGroup) { const cg = JSON.parse(cachedGroup); if(!group.id) group = cg; }
    if(cachedCourses) { courses = JSON.parse(cachedCourses); renderCourses(); }
    if(cachedDl) {
      allDl = JSON.parse(cachedDl);
      scheduleRender();
    }
    if(cacheTs) {
      const age = Math.round((Date.now() - parseInt(cacheTs)) / 60000);
      if(age > 30) _showOfflineBanner('Дані з кешу (' + (age > 1440 ? Math.round(age/1440)+'д' : age+'хв') + ' тому)');
    }
  } catch(e) {}
}


async function loadUserInfo() {
  try {
    const d = await moodleCall('core_webservice_get_site_info');
    if(!d) return;
    userData = d;
    const name = d.fullname || 'Студент';
    document.getElementById('uname').textContent = name;
    const avatarUrl = d.userpictureurl || null;
    const uav = document.getElementById('uav');
    if(avatarUrl && !avatarUrl.includes('/f/default')) {
      const img = document.createElement('img');
      img.src = avatarUrl;
      img.style.cssText = 'width:100%;height:100%;object-fit:cover;border-radius:50%;';
      img.onerror = function(){ uav.textContent = name[0].toUpperCase(); uav.style.padding=''; };
      uav.style.padding = '0';
      uav.textContent = '';
      uav.appendChild(img);
    } else {
      uav.textContent = name[0].toUpperCase();
    }
    const today = new Date().toLocaleDateString('uk-UA',{weekday:'long',day:'numeric',month:'long'});
    document.getElementById('dash-sub').textContent = today + ' • ' + name;
    var dashSubHome = document.getElementById('dash-sub-home');
    if(dashSubHome) dashSubHome.textContent = today + ' • ' + name + ' • ' + (group.name || 'Група');
    if (window._db && userData.userid) {
      const { doc, setDoc } = window._fb;
      await setDoc(doc(window._db,'users',String(userData.userid)), {
        name, groupId: group.id, groupName: group.name,
        moodleId: userData.userid, lastSeen: Date.now()
      }, { merge: true });
    }
    _saveCache();
  } catch(e) {}
}

async function loadUserRole() {
  if (!window._db || !userData.userid) return;
  const { doc, getDoc, updateDoc } = window._fb;
  try {
    const snap = await getDoc(doc(window._db,'users',String(userData.userid)));
    if (snap.exists() && snap.data().role) {
      userRole = snap.data().role;
    } else {
      // No role yet — assign student and save to Firestore
      userRole = 'student';
      try { await updateDoc(doc(window._db,'users',String(userData.userid)), { role: 'student' }); } catch(e) {}
    }
  } catch(e) { userRole = 'student'; }
  document.getElementById('urole').textContent = ROLES[userRole] || 'Студент';
  document.getElementById('uav').style.background = ROLE_COLORS[userRole] || '#f0c040';
}

function setupNav() {
  if (canAdmin()) {
    document.getElementById('admin-section').style.display='';
    document.getElementById('nav-admin').style.display='';
  }
}

async function _refreshMoodleToken() {
  const creds = localStorage.getItem('sh_creds');
  if(!creds) { doLogout(); return; }
  try {
    const decoded = decodeURIComponent(escape(atob(creds)));
    const [username, password] = decoded.split(':');
    const r = await fetch(MOODLE+'/login/token.php', {
      method: 'POST',
      headers: {'Content-Type':'application/x-www-form-urlencoded'},
      body: new URLSearchParams({username, password, service:'moodle_mobile_app'})
    });
    const d = await r.json();
    if(d.token) {
      token = d.token;
      localStorage.setItem('sh_token', token);
      const banner = document.getElementById('offline-banner');
      if(banner) banner.remove();
      syncMoodle();
    } else {
      doLogout();
    }
  } catch(e) { doLogout(); }
}

var _moodleFailStreak = 0;
var _moodleFailType = '';
var _moodleLastFailAt = 0;

function _markMoodleFailure(type) {
  var now = Date.now();
  if(_moodleFailType === type && now - _moodleLastFailAt < 30000) _moodleFailStreak++;
  else _moodleFailStreak = 1;
  _moodleFailType = type;
  _moodleLastFailAt = now;
}
function _clearMoodleFailureState() {
  _moodleFailStreak = 0;
  _moodleFailType = '';
  _moodleLastFailAt = 0;
}

function _showOfflineBanner(msg, mode) {
  let banner = document.getElementById('offline-banner');
  if(!banner) {
    banner = document.createElement('div');
    banner.id = 'offline-banner';
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9000;background:rgba(240,160,48,.95);color:#0a0a0f;font-size:12px;font-weight:600;padding:calc(env(safe-area-inset-top, 0px) + 7px) 14px 7px;text-align:center;display:flex;align-items:center;justify-content:center;gap:8px;';
    document.body.prepend(banner);
  }
  var btnAction = mode === '_refresh'
    ? 'onclick="_refreshMoodleToken()"'
    : 'onclick="syncMoodle();this.parentNode.remove()"';
  banner.innerHTML = '⚡ ' + msg + ' <button ' + btnAction + ' style="background:rgba(0,0,0,.15);border:none;border-radius:4px;padding:2px 8px;cursor:pointer;font-size:11px;font-family:Inter,sans-serif;font-weight:700;">Оновити</button> <button onclick="this.parentNode.remove()" style="background:none;border:none;cursor:pointer;font-size:16px;line-height:1;margin-left:4px;">✕</button>';
}

async function _parseMoodleResponse(r) {
  const text = await r.text();
  const t = text.trim();
  if(t.startsWith('<') || t.includes('<!DOCTYPE') || t.includes('<html') || t.includes('Увійдіть')) {
    console.warn('Moodle returned HTML instead of JSON');
    _markMoodleFailure('html');
    if(_moodleFailStreak >= 2) _showOfflineBanner('Moodle тимчасово не відповідає — натисніть Оновити', 'refresh');
    return null;
  }
  try {
    const data = JSON.parse(t);
    if(data && data.errorcode === 'invalidtoken') {
      _markMoodleFailure('invalidtoken');
      _showOfflineBanner('Сесія Moodle закінчилась — натисніть Оновити', '_refresh');
      return null;
    }
    _clearMoodleFailureState();
    return data;
  } catch(e) {
    console.warn('Moodle JSON parse error:', t.slice(0,120));
    _markMoodleFailure('parse');
    if(_moodleFailStreak >= 2) _showOfflineBanner('Moodle тимчасово не відповідає — натисніть Оновити', 'refresh');
    return null;
  }
}

async function moodleCall(fn, params={}) {
  const p = new URLSearchParams({ wstoken:token, wsfunction:fn, moodlewsrestformat:'json', ...params });
  const r = await fetch(MOODLE+'/webservice/rest/server.php?'+p);
  return _parseMoodleResponse(r);
}

async function moodlePost(fn, params={}) {
  const body = new URLSearchParams({ wstoken: token, wsfunction: fn, moodlewsrestformat: 'json' });
  Object.entries(params).forEach(([k,v]) => body.append(k, v));
  const r = await fetch(MOODLE+'/webservice/rest/server.php', { method:'POST', body });
  return _parseMoodleResponse(r);
}

async function loadSubmissionStatuses() {
  if(!token || !userData.userid) return;
  const assignDls = allDl.filter(d => d.assignid);
  if(!assignDls.length) return;
  const chunks = [];
  for(let i=0; i<assignDls.length; i+=8) chunks.push(assignDls.slice(i,i+8));
  for(const chunk of chunks) {
    await Promise.all(chunk.map(async d => {
      try {
        const res = await moodlePost('mod_assign_get_submission_status', { assignid: d.assignid, userid: userData.userid });
        if(res && res.lastattempt && res.lastattempt.submission) {
          const status = res.lastattempt.submission.status;
          d.submitted = (status === 'submitted') ? 'submitted' : (status === 'draft' ? 'draft' : null);
        }
      } catch(e) {}
    }));
  }
  // Save updated statuses to cache
  try { localStorage.setItem('sh_cache_dl', JSON.stringify(allDl)); } catch(e) {}
  scheduleRender();
}

async function openCourseContents(courseId, btn) {
  const courseName = btn ? btn.closest('.course-card').querySelector('.c-name').textContent : 'Курс';
  const modal = document.getElementById('course-contents-modal');
  const body = document.getElementById('cc-body');
  document.getElementById('cc-title').textContent = courseName;
  body.innerHTML = '<div class="loading"><div class="spinner"></div>Завантаження...</div>';
  modal.style.display = 'block';
  try {
    const sections = await moodlePost('core_course_get_contents', { courseid: courseId });
    if(!sections) { btn.textContent='📖 Вміст'; return; }
    if(!Array.isArray(sections)) { body.innerHTML = '<div class="empty"><p>Не вдалося завантажити</p></div>'; return; }
    const nonEmpty = sections.filter(s => s.modules && s.modules.filter(m=>m.modname!=='label').length);
    if(!nonEmpty.length) { body.innerHTML = '<div class="empty"><p>Розділів поки немає</p></div>'; return; }
    const modIco = { resource:'📄', url:'🔗', assign:'📝', quiz:'📊', forum:'💬', folder:'📁', page:'📃', video:'🎥' };
    body.innerHTML = nonEmpty.map(s => {
      const mods = s.modules.filter(m=>m.modname!=='label').map(m => {
        const ico = modIco[m.modname] || '📌';
        const fileUrl = m.contents && m.contents[0] ? m.contents[0].fileurl + '?token=' + token : null;
        const link = fileUrl || m.url || 'https://do.kart.edu.ua/mod/'+m.modname+'/view.php?id='+m.id;
        const sz = m.contents && m.contents[0] && m.contents[0].filesize > 1024
          ? ' <span style="color:var(--text2);font-size:10px;">' + Math.round(m.contents[0].filesize/1024) + ' КБ</span>' : '';
        return '<a href="'+escHtml(link)+'" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:10px 12px;color:var(--text);text-decoration:none;border-bottom:1px solid var(--border);transition:background .15s;" onmouseover="this.style.background=&quot;var(--bg3)&quot;" onmouseout="this.style.background=&quot;&quot;">'+
          '<span style="font-size:16px;flex-shrink:0;">'+ico+'</span>'+
          '<span style="flex:1;font-size:13px;">'+escHtml(m.name)+sz+'</span>'+
          '<span style="opacity:.4;font-size:11px;">↗</span></a>';
      }).join('');
      return '<div style="margin-bottom:12px;"><div style="font-size:10px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px;">'+escHtml(s.name)+'</div>'+
        '<div style="background:var(--card);border:1px solid var(--border);border-radius:10px;overflow:hidden;">'+mods+'</div></div>';
    }).join('');
  } catch(e) { body.innerHTML = '<div class="empty"><p>Помилка: '+escHtml(e.message)+'</p></div>'; }
}

// ✅ IMPROVEMENT 2: syncMoodle runs loadCourses + loadDeadlines in PARALLEL
async function syncMoodle() {
  await Promise.all([loadCourses(), loadDeadlines()]);
  renderCalendar();
  // Load submission statuses in background, re-render calendar when done
  loadSubmissionStatuses().then(function() { renderCalendar(); });
}

// ── COURSES ──
var _hiddenCourses = [];

function _loadHiddenCourses() {
  try {
    const key = 'sh_hc_' + (userData.userid || 'local');
    _hiddenCourses = JSON.parse(localStorage.getItem(key) || '[]');
  } catch(e) { _hiddenCourses = []; }
}

function _saveHiddenCourses() {
  try {
    const key = 'sh_hc_' + (userData.userid || 'local');
    localStorage.setItem(key, JSON.stringify(_hiddenCourses));
  } catch(e) {}
}

function hideCourse(id, e) {
  if(e) e.stopPropagation();
  const sid = String(id);
  if(!_hiddenCourses.includes(sid)) {
    _hiddenCourses.push(sid);
    _saveHiddenCourses();
    filterCourses();
  }
}

function restoreAllCourses() {
  _hiddenCourses = [];
  _saveHiddenCourses();
  filterCourses();
}

async function loadCourses() {
  document.getElementById('courses-list').innerHTML='<div class="loading"><div class="spinner"></div>Завантаження курсів...</div>';
  if(!token){ document.getElementById('courses-list').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Немає токену. Вийдіть і увійдіть знову.</p></div>'; return; }
  try {
    const info = await moodleCall('core_webservice_get_site_info');
    if(!info) return;
    const d = await moodleCall('core_enrol_get_users_courses',{userid:info.userid});
    if(!d) return;
    courses = Array.isArray(d) ? d : [];
    var sCourses = document.getElementById('s-courses');
    if(sCourses) sCourses.textContent = courses.length;
    filterCourses();
  } catch(e) { courses=[]; }
}

function renderCourses() { filterCourses(); }

function setCV(v) { cvMode=v; document.getElementById('vg').classList.toggle('on',v==='grid'); document.getElementById('vl').classList.toggle('on',v==='list'); filterCourses(); }
function setCS(s) { csMode=s; document.getElementById('cs-n').classList.toggle('on',s==='name'); document.getElementById('cs-num').classList.toggle('on',s==='num'); filterCourses(); }

function filterCourses() {
  _loadHiddenCourses();
  const q=(document.getElementById('c-q')||{value:''}).value.toLowerCase();
  let list = courses.filter(c => !_hiddenCourses.includes(String(c.id)));
  list = list.filter(c => !q || (c.fullname||c.shortname||'').toLowerCase().includes(q));
  if(csMode==='name') list=list.slice().sort((a,b)=>(a.fullname||a.shortname).localeCompare(b.fullname||b.shortname));
  const el=document.getElementById('courses-list');
  if(!list.length) {
    const hasHidden = _hiddenCourses.length > 0;
    el.innerHTML='<div class="empty"><div class="emo">📚</div><p>Курси не знайдено</p>'+(hasHidden?'<button class="btn" onclick="restoreAllCourses()" style="margin-top:10px;">↩ Відновити '+_hiddenCourses.length+' прихованих</button>':'')+'</div>';
    return;
  }
  const cls=cvMode==='list'?'course-grid lv':'course-grid';
  el.innerHTML='<div class="'+cls+'">'+list.map((c,i)=>
    '<div class="course-card" onclick="window.open(\'https://do.kart.edu.ua/course/view.php?id='+encodeURIComponent(c.id)+'\',\'_blank\',\'noopener,noreferrer\')">' +
    '<button class="hide-course-btn" data-cid="'+escHtml(String(c.id))+'" onclick="hideCourse(this.dataset.cid,event)" title="Сховати курс">✕ Сховати</button>'+
    '<div class="c-num">№'+(i+1)+'</div>'+
    '<div class="c-name">'+escHtml(c.fullname||c.shortname)+'</div>'+
    '<div class="c-meta">'+escHtml(c.shortname||'')+'</div><div style="margin-top:8px;"><button class="btn" style="font-size:10px;padding:4px 9px;min-height:28px;" onclick="event.stopPropagation();openCourseContents('+c.id+',this)">📖 Вміст</button></div></div>'
  ).join('')+'</div>';

  if(_hiddenCourses.length > 0) {
    el.innerHTML += '<div style="margin-top:10px;font-size:11px;color:var(--text2);display:flex;align-items:center;gap:8px;">🙈 Приховано '+_hiddenCourses.length+' курс(ів) <button class="btn" onclick="restoreAllCourses()" style="padding:4px 10px;font-size:10px;">↩ Відновити</button></div>';
  }
}

// ── DEADLINES ──
async function loadDeadlines() {
  const now=Math.floor(Date.now()/1000);
  document.getElementById('dl-list').innerHTML='<div class="loading"><div class="spinner"></div>Завантаження з Moodle...</div>';
  document.getElementById('dash-dl').innerHTML='<div class="loading"><div class="spinner"></div>Завантаження...</div>';
  if(!token){
    document.getElementById('dl-list').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Немає токену Moodle.</p></div>';
    document.getElementById('dash-dl').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Немає токену</p></div>';
    return;
  }
  try {
    let events = [];

    try {
      const d1 = await moodleCall('core_calendar_get_action_events_by_timesort',{
        timesortfrom: now - 60*60*24*365*3,
        timesortto: now + 60*60*24*365,
        limitnum: 50
      });
      if(d1 && !d1.errorcode) {
        const evts = d1.events || d1.data?.events || [];
        if(evts.length) events = evts;
      }
    } catch(e1) {}

    if(courses.length) {
      try {
        const chunkSize = 20;
        const chunks = [];
        for(let i=0; i<courses.length; i+=chunkSize) chunks.push(courses.slice(i,i+chunkSize));
        const chunkResults = await Promise.all(chunks.map(chunk => {
          const courseids = chunk.map((c,i)=>`courseids[${i}]=${c.id}`).join('&');
          return fetch(MOODLE+'/webservice/rest/server.php?wstoken='+token+'&wsfunction=mod_assign_get_assignments&moodlewsrestformat=json&'+courseids)
            .then(r=>r.json()).catch(()=>null);
        }));
        const extraEvents = [];
        window._assignMap = {};
        chunkResults.forEach(d4 => {
          if(d4 && d4.courses) {
            d4.courses.forEach(course => {
              (course.assignments||[]).forEach(a => {
                const deadline = a.duedate || 0;
                window._assignMap[a.id] = { cmid: a.cmid, courseid: course.id };
                if(deadline > 0) {
                  extraEvents.push({
                    id: 'assign_'+a.id, name: a.name,
                    course: { fullname: course.fullname },
                    timesort: deadline, modulename: 'assign',
                    assignid: a.id,
                    url: 'https://do.kart.edu.ua/mod/assign/view.php?id='+a.cmid
                  });
                }
              });
            });
          }
        });
        const existingKeys = new Set(events.map(e => {
          const cn = e.course ? (e.course.fullname||e.course.shortname||'') : '';
          return (e.name||'').toLowerCase().trim() + '|' + cn.toLowerCase().trim() + '|' + (e.timesort||0);
        }));
        extraEvents.forEach(e => {
          const cn = e.course ? (e.course.fullname||e.course.shortname||'') : '';
          const key = (e.name||'').toLowerCase().trim() + '|' + cn.toLowerCase().trim() + '|' + (e.timesort||0);
          if(!existingKeys.has(key)) { events.push(e); existingKeys.add(key); }
        });
      } catch(e45) {}
    }

    const IGNORE_MODULES = ['forum', 'chat', 'wiki', 'glossary'];
    const IGNORE_TYPES = ['open', 'opensubmission', 'expectcompletionon', 'gradingdue'];
    const DEADLINE_TYPES = ['due', 'close', 'closingdate', 'duedate', 'timeclose'];

    const seenIds = new Set();
    events = events.filter(e => {
      const key = String(e.id);
      if(seenIds.has(key)) return false;
      seenIds.add(key);
      return true;
    });

    allDl = events.filter(e => {
      const t = e.timesort || e.timestart || e.timefinish || 0;
      if(t <= 0) return false;
      const modname = (e.modulename || e.modname || e.activitytype || '').toLowerCase();
      if(modname && IGNORE_MODULES.some(x => modname === x)) return false;
      const etype = (e.eventtype || e.type || '').toLowerCase();
      if(etype && IGNORE_TYPES.some(x => etype === x)) return false;
      if(etype && DEADLINE_TYPES.some(x => etype.includes(x))) return true;
      if(e.timesort) return true;
      if(!e.timesort && e.timestart && !e.timefinish) return false;
      return true;
    }).map(e => {
      const due = e.timesort || e.timefinish || e.timestart;
      const courseName = e.course ? (e.course.fullname || e.course.shortname || '—') :
                        (e.coursename || (e.courseid ? 'Курс '+e.courseid : '—'));
      let name = e.name || e.activityname || 'Завдання';
      name = name.replace(/^(строк\s+|термін\s+|дедлайн\s+|здача\s+)/i, '').trim();
      name = name.replace(/\s*(спливає|закрито|закривається|відкрито|відкривається|завершується|closes|due|open|is due|is closing|has closed|closed)\s*$/i, '').trim();
      return {
        id: e.id, name,
        _normName: name.replace(/^(строк\s+|завдання\s+|тест\s+|здача\s+)/i,'').toLowerCase().trim(),
        course: courseName,
        due: due,
        past: due < now,
        url: e.url || e.activityurl || '#',
        assignid: e.assignid || null,
        submitted: null
      };
    }).sort((a,b) => a.due - b.due);

    const seenFinal = new Set();
    allDl = allDl.filter(dl => {
      const dayKey = Math.floor(dl.due / 86400);
      const key = dl._normName + '|' + dl.course.toLowerCase().trim() + '|' + dayKey;
      if(seenFinal.has(key)) return false;
      seenFinal.add(key);
      return true;
    });

    _saveCache();
    const urgent = allDl.filter(d=>!d.past&&(d.due-now)<60*60*48).length;
    const past = allDl.filter(d=>d.past).length;
    document.getElementById('s-urgent').textContent = urgent;
    var sDone = document.getElementById('s-done');
    if(sDone) sDone.textContent = past;

    // ✅ Use scheduleRender instead of 4 separate calls
    scheduleRender();

    scheduleDeadlineNotifs();
    _renderCalNotesInDeadlines();

  } catch(e) {
    console.error('Deadlines error:', e);
    const msg = e && e.message ? e.message : String(e);
    document.getElementById('dl-list').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Помилка дедлайнів: ' + escHtml(msg) + '</p></div>';
    document.getElementById('dash-dl').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Помилка завантаження</p></div>';
    document.getElementById('s-urgent').textContent='!';
    var sDoneErr = document.getElementById('s-done');
    if(sDoneErr) sDoneErr.textContent='!';
  }
}

// ── USER SETTINGS ──
var _dlUrgentH = 48;
var _dlWarnD   = 7;
var _dlDeleted = [];
var _calNotes  = {};
var _userSettingsUnsub = null;
var _settingsLoaded = false;

function _userSettingsDoc() {
  const { doc } = window._fb;
  return doc(window._db, 'userSettings', String(userData.userid));
}

function startUserSettingsSync() {
  return new Promise(resolve => {
    if(!window._db || !userData.userid) { resolve(); return; }
    const { onSnapshot } = window._fb;
    if(_userSettingsUnsub) _userSettingsUnsub();
    let firstLoad = true;
    _userSettingsUnsub = onSnapshot(_userSettingsDoc(), snap => {
      const data = snap.exists() ? snap.data() : {};
      _dlUrgentH = data.dlUrgentH ?? 48;
      _dlWarnD   = data.dlWarnD   ?? 7;
      _dlDeleted = Array.isArray(data.dlDeleted) ? data.dlDeleted : [];
      _calNotes  = (data.calNotes && typeof data.calNotes==='object') ? data.calNotes : {};
      _settingsLoaded = true;
      const uh = document.getElementById('dl-urgent-hours');
      const wd = document.getElementById('dl-warn-days');
      if(uh) uh.value = _dlUrgentH;
      if(wd) wd.value = _dlWarnD;
      if(allDl.length > 0) {
        // ✅ Use scheduleRender instead of 4 calls
        scheduleRender();
        _renderCalNotesInDeadlines();
      }
      if(firstLoad) { firstLoad = false; resolve(); }
    }, err => { console.warn('userSettings sync error:', err.code); resolve(); });
  });
}

var _saveSettingsTimer = null;
async function _saveUserSettings() {
  if(!window._db || !userData.userid) return;
  clearTimeout(_saveSettingsTimer);
  _saveSettingsTimer = setTimeout(async () => {
    const { setDoc } = window._fb;
    try {
      await setDoc(_userSettingsDoc(), {
        dlUrgentH: _dlUrgentH, dlWarnD: _dlWarnD,
        dlDeleted: _dlDeleted, calNotes: _calNotes,
        updatedAt: Date.now(), userId: String(userData.userid)
      });
    } catch(e) {
      localStorage.setItem('ush_'+userData.userid, JSON.stringify({
        dlUrgentH:_dlUrgentH, dlWarnD:_dlWarnD, dlDeleted:_dlDeleted, calNotes:_calNotes, dlOverrides:_dlOverrides
      }));
    }
  }, 800);
}

function loadDlSettings() {
  const uh = document.getElementById('dl-urgent-hours');
  const wd = document.getElementById('dl-warn-days');
  if(uh) uh.value = _dlUrgentH;
  if(wd) wd.value = _dlWarnD;
}

function saveDlSettings() {
  _dlUrgentH = parseInt(document.getElementById('dl-urgent-hours').value)||48;
  _dlWarnD   = parseInt(document.getElementById('dl-warn-days').value)||1;
  // ✅ scheduleRender instead of 4 calls
  scheduleRender();
  _saveUserSettings();
}

function toggleDlSettings() {
  const el = document.getElementById('dl-settings');
  el.style.display = el.style.display==='none' ? 'block' : 'none';
  if(el.style.display!=='none') loadDlSettings();
}

function deleteDl(id, e) {
  if(e) e.stopPropagation();
  if(!confirm('Приховати цей дедлайн?')) return;
  const sid = String(id);
  if(!_dlDeleted.includes(sid)) _dlDeleted.push(sid);
  // ✅ scheduleRender instead of 4 calls
  scheduleRender();
  _saveUserSettings();
}

// ── CALENDAR NOTES ──
function getCalNotes(ds) {
  const val = _calNotes[ds];
  if(!val) return [];
  if(typeof val === 'string') return val ? [{ id: 'legacy', text: val, time: '' }] : [];
  if(Array.isArray(val)) return val;
  return [];
}

function getCalNote(ds) {
  const ns = getCalNotes(ds);
  return ns.length ? ns[0].text : '';
}

function _renderCalNotesList(ds) {
  const container = document.getElementById('cal-notes-list-existing');
  if(!container) return;
  const notes = getCalNotes(ds);
  if(!notes.length) { container.innerHTML = ''; return; }
  container.innerHTML = '<div style="font-size:10px;font-weight:700;color:var(--text2);letter-spacing:.5px;text-transform:uppercase;margin-bottom:8px;">📋 Нотатки цього дня</div>' +
    notes.map(n => {
      const timeLabel = n.time ? n.time : '—';
      const preview = n.text.length > 60 ? n.text.slice(0,60)+'…' : n.text;
      return '<div class="cal-note-item" onclick="editCalNote(\''+escHtml(ds)+'\',\''+escHtml(n.id)+'\',event)">' +
        '<div class="cal-note-item-time">'+escHtml(timeLabel)+'</div>' +
        '<div class="cal-note-item-text">'+escHtml(preview)+'</div>' +
        '<button class="cal-note-item-del" onclick="event.stopPropagation();_deleteCalNoteById(\''+escHtml(ds)+'\',\''+escHtml(n.id)+'\')" title="Видалити">🗑</button>' +
        '</div>';
    }).join('');
}

function newCalNote() {
  window._calNoteEditId = null;
  document.getElementById('cal-note-inp').value = '';
  document.getElementById('cal-note-time').value = '';
  document.getElementById('cal-note-del').style.display = 'none';
  document.getElementById('cal-note-new-btn').style.display = 'none';
  document.getElementById('cal-note-form-label').textContent = '➕ Нова нотатка';
  document.getElementById('cal-note-inp').focus();
}

function editCalNote(ds, noteId, e) {
  if(e) e.stopPropagation();
  const notes = getCalNotes(ds);
  const note = notes.find(n => n.id === noteId);
  if(!note) return;
  window._calNoteEditId = noteId;
  document.getElementById('cal-note-inp').value = note.text;
  document.getElementById('cal-note-time').value = note.time || '';
  document.getElementById('cal-note-del').style.display = '';
  document.getElementById('cal-note-new-btn').style.display = '';
  document.getElementById('cal-note-form-label').textContent = '✏️ Редагувати нотатку';
}

function saveCalNote() {
  const txt = document.getElementById('cal-note-inp').value.trim();
  const time = document.getElementById('cal-note-time').value || '';
  const ds = window._calNoteDate;
  if(!txt) { closeCalNoteModal(); return; }

  let notes = getCalNotes(ds).filter(n => n.id !== 'legacy');
  if(typeof _calNotes[ds] === 'string') {
    const oldText = _calNotes[ds];
    if(oldText) notes = [{ id: 'n'+Date.now()+'a', text: oldText, time: '' }, ...notes];
  }

  const editId = window._calNoteEditId;
  if(editId && editId !== 'legacy') {
    const idx = notes.findIndex(n => n.id === editId);
    if(idx >= 0) notes[idx] = { ...notes[idx], text: txt, time };
    else notes.push({ id: 'n'+Date.now()+Math.random().toString(36).slice(2), text: txt, time });
  } else {
    notes.push({ id: 'n'+Date.now()+Math.random().toString(36).slice(2), text: txt, time });
  }

  notes.sort((a, b) => {
    const ta = a.time || '23:59', tb = b.time || '23:59';
    return ta.localeCompare(tb);
  });

  _calNotes[ds] = notes;
  closeCalNoteModal();
  renderCalendar();
  _renderCalNotesInDeadlines();
  _saveUserSettings();
}

function _deleteCalNoteById(ds, noteId) {
  let notes = getCalNotes(ds);
  notes = notes.filter(n => n.id !== noteId);
  if(notes.length === 0) delete _calNotes[ds];
  else _calNotes[ds] = notes;
  _renderCalNotesList(ds);
  renderCalendar();
  _renderCalNotesInDeadlines();
  _saveUserSettings();
  if(window._calNoteEditId === noteId) newCalNote();
}

function deleteCalNote() {
  const ds = window._calNoteDate;
  const editId = window._calNoteEditId;
  if(editId) {
    _deleteCalNoteById(ds, editId);
  } else {
    delete _calNotes[ds];
    closeCalNoteModal();
    renderCalendar();
    _renderCalNotesInDeadlines();
    _saveUserSettings();
  }
}

function openCalNoteModal(ds, e, noteId) {
  if(e) e.stopPropagation();
  window._calNoteDate = ds;
  window._calNoteEditId = null;
  const d = new Date(ds+'T12:00:00');
  document.getElementById('cal-note-date-lbl').textContent = d.toLocaleDateString('uk-UA',{weekday:'long',day:'numeric',month:'long'});

  _renderCalNotesList(ds);

  if(noteId) {
    editCalNote(ds, noteId, null);
    document.getElementById('cal-note-new-btn').style.display = '';
  } else {
    document.getElementById('cal-note-inp').value = '';
    document.getElementById('cal-note-time').value = '';
    document.getElementById('cal-note-del').style.display = 'none';
    document.getElementById('cal-note-new-btn').style.display = 'none';
    document.getElementById('cal-note-form-label').textContent = '➕ Нова нотатка';
  }

  const modal = document.getElementById('cal-note-modal');
  modal.style.display = 'flex';
  setTimeout(()=>document.getElementById('cal-note-inp').focus(),50);
}

function closeCalNoteModal() { document.getElementById('cal-note-modal').style.display='none'; }
document.addEventListener('keydown', e=>{
  if(e.key==='Escape') closeCalNoteModal();
  if(e.key==='Enter'&&e.ctrlKey&&document.getElementById('cal-note-modal').style.display!=='none') saveCalNote();
});

function _renderCalNotesInDeadlines() {
  const today = new Date(); today.setHours(0,0,0,0);
  const now = new Date();

  const allNoteRows = [];
  Object.entries(_calNotes).forEach(([ds, val]) => {
    const notes = getCalNotes(ds);
    notes.forEach(n => { allNoteRows.push({ ds, note: n }); });
  });
  allNoteRows.sort((a, b) => {
    const ta = a.ds + 'T' + (a.note.time || '23:59');
    const tb = b.ds + 'T' + (b.note.time || '23:59');
    return ta.localeCompare(tb);
  });

  const fVal = (document.getElementById('dl-f')||{value:'active'}).value;
  const dlList = document.getElementById('dl-list');
  if(dlList) {
    let noteBlock = document.getElementById('cal-notes-in-dl');
    if(!noteBlock) {
      noteBlock = document.createElement('div');
      noteBlock.id = 'cal-notes-in-dl';
      dlList.parentNode.insertBefore(noteBlock, dlList);
    }
    const filteredForDl = allNoteRows.filter(({ds, note}) => {
      const fullDt = new Date(ds + 'T' + (note.time || '23:59'));
      const isPast = fullDt <= now;
      if(fVal === 'active') return !isPast;
      if(fVal === 'past') return isPast;
      return true;
    });
    noteBlock.innerHTML = filteredForDl.length ? _buildNoteRows(filteredForDl, today, now) : '';
  }

  const dashDl = document.getElementById('dash-dl');
  if(dashDl) {
    let dashNotes = document.getElementById('cal-notes-in-dash');
    if(!dashNotes) {
      dashNotes = document.createElement('div');
      dashNotes.id = 'cal-notes-in-dash';
      dashDl.parentNode.insertBefore(dashNotes, dashDl);
    }
    const futureNotes = allNoteRows.filter(({ds, note}) => {
      const fullDt = new Date(ds + 'T' + (note.time || '23:59'));
      return fullDt > now;
    });
    dashNotes.innerHTML = futureNotes.length ? _buildNoteRows(futureNotes, today, now) : '';
  }
}

function _buildNoteRows(noteRows, today, now) {
  const rows = noteRows.map(({ds, note}) => {
    const fullDt = new Date(ds + 'T' + (note.time || '23:59'));
    const isPast = fullDt <= now;
    const diffSec = (fullDt - now) / 1000;
    const isUrgent = !isPast && diffSec < _dlUrgentH * 3600;
    const isWarn   = !isPast && !isUrgent && diffSec < _dlWarnD * 86400;
    const d = new Date(ds+'T12:00:00');
    const isToday = d.toDateString()===today.toDateString();
    const isTomorrow = d.toDateString()===new Date(today.getTime()+86400000).toDateString();
    const label = isToday ? '<span class="tag r">Сьогодні</span>' :
                  isTomorrow ? '<span class="tag y">Завтра</span>' :
                  isPast ? '<span class="tag" style="background:var(--bg3);color:var(--text2);">Минуло</span>' : '';
    const dateStr = d.toLocaleDateString('uk-UA',{day:'numeric',month:'short'});
    const preview = note.text.length > 70 ? note.text.slice(0,70)+'…' : note.text;
    const dotStyle = isPast || isUrgent
      ? 'background:var(--accent2);box-shadow:0 0 7px rgba(224,80,80,.65);'
      : isWarn
        ? 'background:var(--warning);box-shadow:0 0 5px rgba(240,160,48,.4);'
        : 'background:var(--success);';
    const timeColor = isPast ? 'var(--text2)' : isUrgent ? 'var(--accent2)' : isWarn ? 'var(--warning)' : isToday ? 'var(--accent)' : 'var(--text2)';
    const timeEl = note.time ? `<div class="dl-date" style="color:${timeColor};font-weight:700;font-size:11px;">${note.time}</div>` : '';
    return `<div class="dl-item" onclick="openCalNoteModal('${escHtml(ds)}',event,'${escHtml(note.id)}')" style="${isPast?'opacity:.5':''}">
      <div class="dl-dot" style="${dotStyle}flex-shrink:0;"></div>
      <div class="dl-info">
        <div class="dl-name">✏️ ${escHtml(preview)}</div>
        <div class="dl-course">Нотатка в календарі</div>
      </div>
      <div class="dl-right">
        ${timeEl}
        <div class="dl-date">${dateStr}</div>
        ${label}
      </div>
    </div>`;
  }).join('');
  if(!rows.trim()) return '';
  return `<div style="font-size:10px;font-weight:700;color:var(--text2);letter-spacing:.5px;text-transform:uppercase;margin-bottom:6px;">📅 Нотатки з календаря</div>
    <div class="dl-list" style="margin-bottom:8px;">${rows}</div>
    <div style="height:1px;background:var(--border);margin-bottom:12px;"></div>`;
}

function dlDot(d) {
  if(d.past) return 'dot-u';
  const diff = d.due - Date.now()/1000;
  if(diff < _dlUrgentH*3600) return 'dot-u';
  if(diff < _dlWarnD*86400)  return 'dot-s';
  return 'dot-o';
}
function dlDateCls(d) {
  if(d.past) return 'u';
  const diff = d.due - Date.now()/1000;
  if(diff < _dlUrgentH*3600) return 'u';
  if(diff < _dlWarnD*86400)  return 's';
  return '';
}
function fmtDate(ts) { return new Date(ts*1000).toLocaleDateString('uk-UA',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}); }

function applyDlFilter() {
  const q=(document.getElementById('dl-q')||{value:''}).value.toLowerCase();
  const f=(document.getElementById('dl-f')||{value:'active'}).value;
  const now = Date.now()/1000;
  let list=allDl.filter(d=>!_dlDeleted.includes(String(d.id)));
  list=list.filter(d=>!q||d.name.toLowerCase().includes(q)||d.course.toLowerCase().includes(q));
  if(f==='active') list=list.filter(d=>d.due > now && d.submitted !== 'submitted');
  else if(f==='urgent') list=list.filter(d=>d.due > now && (d.due-now)<_dlUrgentH*3600);
  else if(f==='past') list=list.filter(d=>d.due <= now);
  list = list.map(d => ({ ...d, past: d.due <= now }));
  renderDl(list, document.getElementById('dl-list'));
  _renderCalNotesInDeadlines();
}

function renderDl(list, el) {
  if(!list.length){el.innerHTML='<div class="empty"><div class="emo">🎉</div><p>Дедлайнів не знайдено</p></div>';return;}
  const now = Date.now()/1000;
  el.innerHTML='<div class="dl-list">'+list.map(d=>{
    const dc=dlDot(d), dtc=dlDateCls(d);
    const hasUrl=d.url&&d.url!=='#';
    const diff = d.due - now;
    let tag = '';
    if(d.submitted==='submitted') tag='<span class="tag g">✅ Здано</span>';
    else if(d.submitted==='draft') tag='<span class="tag y">📝 Чернетка</span>';
    else if(d.past||d.due<=now) tag='<span class="tag r">Минув</span>';
    else if(diff < _dlUrgentH*3600) tag='<span class="tag r">🔴 Термін!</span>';
    else if(diff < 86400*2) { const dueD=new Date(d.due*1000); const todD=new Date(); const isTomorrow=dueD.getDate()===todD.getDate()+1&&dueD.getMonth()===todD.getMonth()&&dueD.getFullYear()===todD.getFullYear(); if(isTomorrow) tag='<span class="tag y">Завтра</span>'; }
    return '<div class="dl-item'+(hasUrl?' click':'')+'"'+
      (hasUrl?' onclick="window.open(this.dataset.url)" data-url="'+escHtml(d.url)+'"':'')+(d.past||d.due<=now?' style="opacity:.6"':'')+'>'+
      '<div class="dl-dot '+dc+'"></div>'+
      '<div class="dl-info"><div class="dl-name">'+escHtml(d.name)+(hasUrl?' <span style="opacity:.35;font-size:9px">↗</span>':'')+'</div>'+
      '<div class="dl-course">'+escHtml(d.course)+'</div></div>'+
      '<div class="dl-right">'+
        '<div class="dl-date '+dtc+'">'+fmtDate(d.due)+'</div>'+
        tag+
        '<button onclick="event.stopPropagation();deleteDl(this.dataset.dlid,event)" data-dlid="'+escHtml(String(d.id))+'" title="Приховати" style="background:none;border:none;color:var(--text2);font-size:12px;cursor:pointer;opacity:.4;padding:2px 4px;border-radius:4px;transition:opacity .15s;margin-top:2px;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.4">✕</button>'+
      '</div></div>';
  }).join('')+'</div>';
}

function renderDashDl() {
  const el=document.getElementById('dash-dl');
  const elHome=document.getElementById('dash-dl-home');
  const dlDel=typeof _dlDeleted!=='undefined'?_dlDeleted:[];
  const now = Date.now()/1000;
  const top=allDl.filter(d=>{
    if(dlDel.includes(String(d.id))) return false;
    if(d.submitted==='submitted') return false;
    if(d._noDeadline) {
      const ov = _dlOverrides[String(d.id)];
      return ov && ov.due && ov.due > now;
    }
    const eff = (typeof getEffectiveDue === 'function') ? getEffectiveDue(d) : d.due;
    return eff && eff > now;
  }).map(d => {
    const eff = (typeof getEffectiveDue === 'function') ? getEffectiveDue(d) : d.due;
    return { ...d, due: eff, past: false };
  }).sort((a,b)=>a.due-b.due).slice(0,5);
  if(!top.length){el.innerHTML='<div class="empty"><div class="emo">🎉</div><p>Немає активних дедлайнів!</p></div>';return;}
  if(el) renderDl(top,el);
  if(elHome) renderDl(top,elHome);
}

// ── GRADES ──
var _grSubjects  = [];
var _grLoading   = false;
var _grLoaded    = false;
var _grModFilter = 0;    // 0=all, 1=mod1, 2=mod2
var _grGrCtx     = null;
var _grDeletedIds= {};   // {subjId: Set of deleted moodle item ids}

// ── storage ──
function _grKey(){ return 'sh_gr5_'+(userData.userid||'x'); }
function _grLocalSave(){
  try{
    var deletedArr={};
    Object.keys(_grDeletedIds).forEach(function(k){deletedArr[k]=[..._grDeletedIds[k]];});
    localStorage.setItem(_grKey(), JSON.stringify({subjects:_grSubjects,deletedIds:deletedArr}));
  }catch(e){}
}
function _grLocalLoad(){
  try{
    var raw=localStorage.getItem(_grKey());
    if(!raw) return;
    var d=JSON.parse(raw);
    if(Array.isArray(d)){
      // Old format - migrate
      _grSubjects=d;
      _grLoaded=(_grSubjects.length>0);
      return;
    }
    if(Array.isArray(d.subjects)){
      _grSubjects=d.subjects;
      var di=d.deletedIds||{};
      Object.keys(di).forEach(function(k){_grDeletedIds[k]=new Set(di[k]);});
      _grLoaded=(_grSubjects.length>0);
    }
  }catch(e){}
}
async function _grFireSave(){
  _grLocalSave();
  if(!window._db||!userData.userid) return;
  try{
    const {doc,setDoc}=window._fb;
    var deletedArr={};
    Object.keys(_grDeletedIds).forEach(function(k){deletedArr[k]=[..._grDeletedIds[k]];});
    // Save into users/{id} with merge so other fields are preserved
    await setDoc(doc(window._db,'users',String(userData.userid)),{
      grades:{subjects:_grSubjects,deletedIds:deletedArr,updatedAt:Date.now()}
    },{merge:true});
  }catch(e){ console.warn('grades save err:',e); }
}
async function _grFireLoad(){
  _grLocalLoad(); // show cached instantly while Firebase loads
  if(!window._db||!userData.userid) return;
  try{
    const {doc,getDoc}=window._fb;
    const snap=await getDoc(doc(window._db,'users',String(userData.userid)));
    if(snap.exists()&&snap.data().grades&&Array.isArray(snap.data().grades.subjects)){
      var d=snap.data().grades;
      _grSubjects=d.subjects;
      var di=d.deletedIds||{};
      _grDeletedIds={};
      Object.keys(di).forEach(function(k){_grDeletedIds[k]=new Set(di[k]);});
      _grLoaded=true;
      _grLocalSave();
    }
  }catch(e){ console.warn('grades load err:',e); }
}

// ── helpers ──
function _grIsAttend(n){ return /відвідув|attendance|присутн/i.test(n||''); }
function _grIsMod(n){ return /модул|мкр|підсумков|залік|іспит|exam|final|semest/i.test(n||''); }
function _grStrip(s){ return (s||'').replace(/<[^>]*>/g,'').replace(/&[a-z#0-9]+;/gi,'').trim(); }
function _grDetMod(n){
  if(/модул[ьь]?\s*1|module\s*1|мкр\s*1|перш/i.test(n)) return 1;
  if(/модул[ьь]?\s*2|module\s*2|мкр\s*2|друг/i.test(n)) return 2;
  return 1;
}
function _grSumF(arr){ return arr.reduce(function(s,g){return s+(parseFloat(g.grade)||0);},0); }
function _grMaxF(arr){ return arr.reduce(function(s,g){return s+(parseFloat(g.max)||0);},0); }
function _grColor(s,x){
  if(!x) return 'var(--text2)';
  var p=s/x*100;
  if(p>=90) return 'var(--success)';
  if(p>=75) return 'var(--accent)';
  if(p>=60) return 'var(--warning)';
  return 'var(--accent2)';
}
function _grFmt(s,x){ return x ? Math.round(s)+'/'+Math.round(x) : Math.round(s); }
function _grFind(id){ return _grSubjects.find(function(s){return s.id===id;}); }

// ── Moodle load ──
async function loadGrades(force){
  if(_grLoading) return;
  var el=document.getElementById('grades-list');
  if(!el) return;
  // Load from Firebase/local first
  if(!_grLoaded) await _grFireLoad();
  // If Firebase had data and not force-refresh → render, skip Moodle
  if(_grLoaded&&!force){ renderGradesTable(); return; }
  // Force refresh OR first time (no Firebase data yet) → sync from Moodle
  _grLoading=true;
  el.innerHTML='<div class="loading"><div class="spinner"></div>Синхронізація з Moodle...</div>';
  try{
    if(!token||!userData.userid){
      el.innerHTML='<div class="empty"><div class="emo">🔒</div><p>Увійдіть через Moodle</p></div>';
      return;
    }
    if(!courses.length){
      var d=await moodleCall('core_enrol_get_users_courses',{userid:userData.userid});
      if(d) courses=d;
    }
    var chunks=[];
    for(var i=0;i<courses.length;i+=10) chunks.push(courses.slice(i,i+10));
    await Promise.all(chunks.map(async function(chunk){
      await Promise.all(chunk.map(async function(course){
        try{
          var data=await moodleCall('gradereport_user_get_grade_items',{courseid:course.id,userid:userData.userid});
          if(!data||!data.usergrades||!data.usergrades[0]) return;
          var rawItems=(data.usergrades[0].gradeitems||[]).filter(function(item){
            if(item.gradetype===0||item.itemtype==='course') return false;
            if(item.graderaw==null||item.graderaw==='') return false;
            if(_grIsAttend(_grStrip(item.itemname||''))) return false;
            return true;
          });
          if(!rawItems.length) return;
          var subj=_grSubjects.find(function(s){return s.moodleCourseId===course.id;});
          if(!subj){
            subj={id:'mc_'+course.id,name:course.fullname||course.shortname,moodleCourseId:course.id,items:[],_moodle:true};
            _grSubjects.push(subj);
          }
          rawItems.forEach(function(item){
            var mid='m_'+item.id;
            // Skip if user explicitly deleted this Moodle item
            if(_grDeletedIds[subj.id]&&_grDeletedIds[subj.id].has(mid)) return;
            // Skip if already present (user may have edited it)
            if(subj.items.find(function(g){return g.id===mid||g.id==='e_'+mid;})) return;
            var name=_grStrip(item.itemname||item.itemmodule||'Завдання');
            subj.items.push({
              id:mid,name:name,
              grade:parseFloat(item.graderaw)||0,
              max:parseFloat(item.grademax)||100,
              mod:_grDetMod(name),
              isMod:_grIsMod(name),
              label:_grStrip(item.gradeformatted||String(Math.round(parseFloat(item.graderaw)||0))),
              _moodle:true
            });
          });
        }catch(e){}
      }));
    }));
    _grLoaded=true;
    // Save Moodle data to Firebase on first sync
    // (won't overwrite user edits because we use merge + deletedIds guards)
    await _grFireSave();
    renderGradesTable();
  }catch(e){
    el.innerHTML='<div class="empty"><div class="emo">⚠️</div><p>'+escHtml(String(e.message||e))+'</p></div>';
  }finally{ _grLoading=false; }
}

// ── render ──
function renderGradesTable(){
  var el=document.getElementById('grades-list');
  var sumEl=document.getElementById('grades-summary');
  if(!el) return;
  var q=(document.getElementById('gr-q')||{value:''}).value.toLowerCase().trim();
  var list=_grSubjects.filter(function(s){
    return !q||s.name.toLowerCase().includes(q)||s.items.some(function(i){return i.name.toLowerCase().includes(q);});
  });

  // Summary cards
  if(sumEl) sumEl.style.display='none';

  if(!list.length){
    el.innerHTML='<div class="empty"><div class="emo">🎓</div><p>'+(q?'Нічого не знайдено':'Немає оцінок — натисніть 🔄 або ＋')+'</p></div>';
    return;
  }

  // Filter tabs
  var html='<div style="display:flex;gap:6px;margin-bottom:10px;">'+
    _grTab(0,'Всі')+_grTab(1,'Модуль 1')+_grTab(2,'Модуль 2')+
  '</div>';

  var grandS=0,grandX=0;

  list.forEach(function(subj){
    var all=subj.items||[];
    var m1=all.filter(function(i){return i.mod===1;});
    var m2=all.filter(function(i){return i.mod===2;});
    var s1=_grSumF(m1),x1=_grMaxF(m1);
    var s2=_grSumF(m2),x2=_grMaxF(m2);
    var sA=s1+s2,xA=x1+x2;
    grandS+=sA; grandX+=xA;

    // Which items to show based on filter
    var showM1=(_grModFilter===0||_grModFilter===1);
    var showM2=(_grModFilter===0||_grModFilter===2);

    html+='<div class="gr-card">';

    // Compute итоговая оценка как средний балл двух модулей без процентов
    var autoFinal = (m1.length&&m2.length) ? (s1+s2)/2 : (m1.length?s1:(m2.length?s2:null));
    var finalGrade = subj._finalGrade!=null ? subj._finalGrade : (autoFinal!=null?Math.round(autoFinal):null);
    var isManual = subj._finalGrade!=null;
    var finalMax = (x1>0&&x2>0) ? ((x1+x2)/2) : (x1>0?x1:(x2>0?x2:null));

    // Header score: per-module view shows that module sum; "Всі" shows підсумкова without percents
    var headVal, headMax;
    if(_grModFilter===1){ headVal=Math.round(s1); headMax=Math.round(x1); }
    else if(_grModFilter===2){ headVal=Math.round(s2); headMax=Math.round(x2); }
    else { headVal=finalGrade; headMax=null; }

    var headStr = headVal!=null
      ? (headMax ? headVal+'<span style="font-size:10px;font-weight:400;color:var(--text2);">/'+headMax+'</span>' : String(headVal))
      : '—';
    var headColor = headMax ? _grColor(headVal,headMax) : (finalMax ? _grColor(headVal,finalMax) : 'var(--text)');

    html+='<div class="gr-card-head">'+
      '<div class="gr-card-name" title="'+escHtml(subj.name)+'">'+escHtml(subj.name)+'</div>'+
      '<div class="gr-head-actions">'+
        '<div class="gr-head-score" style="color:'+headColor+';">'+headStr+'</div>'+
        (_grModFilter===0
          ? '<button data-sid="'+escHtml(subj.id)+'" onclick="grEditFinal(this.dataset.sid)" title="Редагувати підсумкову" style="background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:2px 4px;opacity:.7;min-height:28px;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.7">✏️</button>'
          : '')+
        '<button class="gr-del-btn" data-sid="'+escHtml(subj.id)+'" onclick="grDeleteSubj(this.dataset.sid)">🗑</button>'+
      '</div>'+
    '</div>';

    // Table: in "Всі" show only module totals and final result
    html+='<div class="gr-table-wrap"><table class="gr-table" style="width:100%;border-collapse:collapse;">';
    if(_grModFilter!==0){
      html+='<thead><tr style="background:var(--bg3);">'+
        '<th class="gr-th" style="text-align:left;width:80px;">Тип</th>'+
        '<th class="gr-th" style="text-align:left;">Назва</th>'+
        '<th class="gr-th" style="width:50px;">Бал</th>'+
        '<th class="gr-th" style="width:46px;">Макс</th>'+
        '<th class="gr-th" style="width:32px;"></th>'+
      '</tr></thead>';
    }
    html+='<tbody>';

    // Filter items by module filter
    var visible=all.filter(function(i){return _grModFilter===0||i.mod===_grModFilter;});
    var cur=visible.filter(function(i){return !i.isMod;});
    var mods=visible.filter(function(i){return i.isMod;});
    var curS=_grSumF(cur),curX=_grMaxF(cur);
    var modS=_grSumF(mods),modX=_grMaxF(mods);

    if(_grModFilter!==0){
      // Draggable rows - поточна
      cur.forEach(function(item,idx){
        var ri=all.indexOf(item);
        var isFirst=(ri===0), isLast=(ri===all.length-1);
        html+='<tr class="gr-tr" data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'">'+
          '<td class="gr-td gr-drag-handle" style="color:var(--text2);font-size:11px;cursor:ns-resize;touch-action:none;" onmousedown="_grPointerStart(event,\''+escHtml(subj.id)+'\','+ri+')" ontouchstart="_grPointerStart(event,\''+escHtml(subj.id)+'\','+ri+')">'+
          '<span style="opacity:.3;font-size:10px;margin-right:3px;">⠿</span>'+(idx===0?'📋 Поточна':'')+'</td>'+
          '<td class="gr-td" style="color:var(--text);" title="'+escHtml(item.name)+'">'+
          escHtml(item.name)+
            '<span style="font-size:9px;background:var(--bg3);border-radius:3px;padding:1px 4px;margin-left:4px;color:var(--text2);">М'+item.mod+'</span>'+
          '</td>'+
          '<td class="gr-td" style="text-align:center;font-weight:700;color:'+_grColor(item.grade,item.max)+';">'+Math.round(item.grade)+'</td>'+
          '<td class="gr-td" style="text-align:center;color:var(--text2);">'+Math.round(item.max)+'</td>'+
          '<td class="gr-td" style="text-align:center;white-space:nowrap;">'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grMoveItem(this.dataset.sid,+this.dataset.ri,-1)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:11px;padding:1px 2px;min-height:22px;opacity:'+(isFirst?'.15':'.5')+';">▲</button>'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grMoveItem(this.dataset.sid,+this.dataset.ri,1)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:11px;padding:1px 2px;min-height:22px;opacity:'+(isLast?'.15':'.5')+';">▼</button>'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grEditGrade(this.dataset.sid,+this.dataset.ri)" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;padding:2px 3px;min-height:26px;opacity:.7;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.7">✏️</button>'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grDelGrade(this.dataset.sid,+this.dataset.ri)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;padding:2px 3px;min-height:26px;opacity:.5;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5">✕</button>'+
          '</td>'+
        '</tr>';
      });
      if(cur.length){
        html+='<tr style="background:var(--bg3);">'+
          '<td class="gr-td" colspan="2" style="font-size:11px;font-weight:700;color:var(--text2);">Сума поточна</td>'+
          '<td class="gr-td" style="text-align:center;font-weight:800;color:'+_grColor(curS,curX)+';">'+Math.round(curS)+'</td>'+
          '<td class="gr-td" style="text-align:center;color:var(--text2);">'+Math.round(curX)+'</td>'+
          '<td class="gr-td"><button data-sid="'+escHtml(subj.id)+'" data-mod="'+(_grModFilter||1)+'" onclick="grAddGrade(this.dataset.sid,+this.dataset.mod)" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;min-height:26px;padding:0 4px;">＋</button></td>'+
        '</tr>';
      } else {
        html+='<tr><td class="gr-td" colspan="4" style="color:var(--text2);font-size:11px;font-style:italic;">Поточних оцінок немає</td>'+
          '<td class="gr-td"><button data-sid="'+escHtml(subj.id)+'" data-mod="'+(_grModFilter||1)+'" onclick="grAddGrade(this.dataset.sid,+this.dataset.mod)" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;min-height:26px;padding:0 4px;">＋</button></td>'+
        '</tr>';
      }

      // Draggable rows - модульний
      mods.forEach(function(item,idx){
        var ri=all.indexOf(item);
        var isFirst=(ri===0), isLast=(ri===all.length-1);
        html+='<tr class="gr-tr" data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" style="background:rgba(240,192,64,.04);">'+
          '<td class="gr-td gr-drag-handle" style="color:var(--accent);font-size:11px;font-weight:600;cursor:ns-resize;touch-action:none;" onmousedown="_grPointerStart(event,\''+escHtml(subj.id)+'\','+ri+')" ontouchstart="_grPointerStart(event,\''+escHtml(subj.id)+'\','+ri+')">'+
          '<span style="opacity:.3;font-size:10px;margin-right:3px;">⠿</span>'+(idx===0?'📝 Модульний':'')+'</td>'+
          '<td class="gr-td" style="color:var(--text);" title="'+escHtml(item.name)+'">'+
          escHtml(item.name)+
            '<span style="font-size:9px;background:var(--bg3);border-radius:3px;padding:1px 4px;margin-left:4px;color:var(--text2);">М'+item.mod+'</span>'+
          '</td>'+
          '<td class="gr-td" style="text-align:center;font-weight:700;color:'+_grColor(item.grade,item.max)+';">'+Math.round(item.grade)+'</td>'+
          '<td class="gr-td" style="text-align:center;color:var(--text2);">'+Math.round(item.max)+'</td>'+
          '<td class="gr-td" style="text-align:center;white-space:nowrap;">'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grMoveItem(this.dataset.sid,+this.dataset.ri,-1)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:11px;padding:1px 2px;min-height:22px;opacity:'+(isFirst?'.15':'.5')+';">▲</button>'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grMoveItem(this.dataset.sid,+this.dataset.ri,1)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:11px;padding:1px 2px;min-height:22px;opacity:'+(isLast?'.15':'.5')+';">▼</button>'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grEditGrade(this.dataset.sid,+this.dataset.ri)" style="background:none;border:none;color:var(--accent);cursor:pointer;font-size:12px;padding:2px 3px;min-height:26px;opacity:.7;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.7">✏️</button>'+
            '<button data-sid="'+escHtml(subj.id)+'" data-ri="'+ri+'" onclick="grDelGrade(this.dataset.sid,+this.dataset.ri)" style="background:none;border:none;color:var(--text2);cursor:pointer;font-size:12px;padding:2px 3px;min-height:26px;opacity:.5;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5">✕</button>'+
          '</td>'+
        '</tr>';
      });
      if(!mods.length){
        html+='<tr style="background:rgba(240,192,64,.04);"><td class="gr-td" colspan="4" style="color:var(--text2);font-size:11px;font-style:italic;">📝 Модульний тест — немає</td>'+
          '<td class="gr-td"><button data-sid="'+escHtml(subj.id)+'" data-mod="'+(_grModFilter||1)+'" onclick="grAddGradeMod(this.dataset.sid,+this.dataset.mod)" style="background:none;border:none;color:var(--accent);font-size:14px;cursor:pointer;min-height:26px;padding:0 4px;">＋</button></td>'+
        '</tr>';
      }
    }

    // Total rows
    if(_grModFilter===0){
      // Всі: show M1 sum, M2 sum, then підсумкова = (M1 + M2) / 2
      html+='<tr style="background:var(--bg3);border-top:1px solid var(--border);">'+
        '<td class="gr-td" colspan="2" style="font-size:11px;color:var(--text2);">Σ Модуль 1</td>'+
        '<td class="gr-td" style="text-align:center;font-weight:700;color:'+_grColor(s1,x1)+';">'+Math.round(s1)+'</td>'+
        '<td class="gr-td" style="text-align:center;color:var(--text2);">'+Math.round(x1)+'</td>'+
        '<td class="gr-td"></td></tr>';
      html+='<tr style="background:var(--bg3);">'+
        '<td class="gr-td" colspan="2" style="font-size:11px;color:var(--text2);">Σ Модуль 2</td>'+
        '<td class="gr-td" style="text-align:center;font-weight:700;color:'+_grColor(s2,x2)+';">'+Math.round(s2)+'</td>'+
        '<td class="gr-td" style="text-align:center;color:var(--text2);">'+Math.round(x2)+'</td>'+
        '<td class="gr-td"></td></tr>';
      html+='<tr style="background:var(--bg3);border-top:2px solid var(--border);">'+
        '<td class="gr-td" colspan="2" style="font-size:12px;font-weight:800;color:var(--text);">'+
          '🏆 Підсумкова '+
          (isManual
            ? '<span style="font-size:9px;background:rgba(240,192,64,.2);color:var(--accent);border-radius:3px;padding:1px 5px;">вручну</span>'
            : '<span style="font-size:9px;color:var(--text2);">авто</span>')+
        '</td>'+
        '<td class="gr-td" colspan="2" style="text-align:center;font-size:16px;font-weight:800;color:'+(finalGrade!=null&&finalMax?_grColor(finalGrade,finalMax):(finalGrade!=null?'var(--text)':'var(--text2)'))+';">'+
          (finalGrade!=null?String(finalGrade):'—')+
        '</td>'+
        '<td class="gr-td">'+
          '<button data-sid="'+escHtml(subj.id)+'" onclick="grEditFinal(this.dataset.sid)" style="background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;padding:2px 4px;min-height:28px;opacity:.8;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.8">✏️</button>'+
          (isManual?'<button data-sid="'+escHtml(subj.id)+'" onclick="grClearFinal(this.dataset.sid)" style="background:none;border:none;color:var(--text2);font-size:10px;cursor:pointer;padding:2px 3px;min-height:28px;opacity:.5;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.5" title="Скинути">↺</button>':'')+
        '</td>'+
      '</tr>';
    } else {
      var ms=_grModFilter===1?s1:s2, mx=_grModFilter===1?x1:x2;
      html+='<tr style="background:var(--bg3);border-top:2px solid var(--border);">'+
        '<td class="gr-td" colspan="2" style="font-size:12px;font-weight:800;color:var(--text);">Σ Модуль '+_grModFilter+'</td>'+
        '<td class="gr-td" style="text-align:center;font-size:15px;font-weight:800;color:'+_grColor(ms,mx)+';">'+Math.round(ms)+'</td>'+
        '<td class="gr-td" style="text-align:center;color:var(--text2);">'+Math.round(mx)+'</td>'+
        '<td class="gr-td"></td>'+
      '</tr>';
    }

    html+='</tbody></table></div>';
    html+='</div>'; // gr-card
  });



  el.innerHTML=html;
}

function _grTab(n,lbl){
  var a=_grModFilter===n;
  return '<button onclick="grSetMF('+n+')" style="padding:7px 14px;border-radius:8px;border:1px solid '+(a?'var(--accent)':'var(--border)')+';background:'+(a?'var(--accent)':'var(--bg3)')+';color:'+(a?'#000':'var(--text2)')+';font-size:12px;font-weight:700;cursor:pointer;min-height:34px;">'+lbl+'</button>';
}
function grSetMF(n){ _grModFilter=n; renderGradesTable(); }
function grEditFinal(sid){
  var subj=_grFind(sid); if(!subj) return;
  var cur=subj._finalGrade!=null?String(subj._finalGrade):'';
  var val=prompt('Підсумкова оцінка. Пусто = авто', cur);
  if(val===null) return;
  val=val.trim();
  if(val===''){
    delete subj._finalGrade;
  } else {
    var n=parseFloat(val);
    if(isNaN(n)||n<0){ alert('Введіть коректну оцінку'); return; }
    subj._finalGrade=Math.round(n);
  }
  _grFireSave(); renderGradesTable();
}
function grClearFinal(sid){
  var subj=_grFind(sid); if(!subj) return;
  delete subj._finalGrade;
  _grFireSave(); renderGradesTable();
}

// ── MOVE + DRAG ──
function grMoveItem(sid,ri,dir){
  var subj=_grFind(sid); if(!subj) return;
  var items=subj.items;
  var newRi=ri+dir;
  if(newRi<0||newRi>=items.length) return;
  // Move item, adopt isMod of destination
  var item=items.splice(ri,1)[0];
  item.isMod=items[newRi-(dir>0?1:0)]!==undefined ? (dir>0 ? (items[newRi-1]||items[newRi]||item).isMod : (items[newRi]||item).isMod) : item.isMod;
  items.splice(newRi,0,item);
  _grFireSave(); renderGradesTable();
}

// ── POINTER DRAG ──
var _grPD={active:false,sid:null,ri:null,ghost:null,rows:[],startY:0,curRi:null};

function _grPointerStart(e,sid,ri){
  if(e.button!==undefined&&e.button!==0) return;
  e.preventDefault();
  var clientY=e.touches?e.touches[0].clientY:e.clientY;
  _grPD.active=true; _grPD.sid=sid; _grPD.ri=ri; _grPD.startY=clientY; _grPD.curRi=ri;

  // Collect all gr-draggable rows for this subject
  _grPD.rows=Array.from(document.querySelectorAll('.gr-tr[data-sid="'+sid+'"]'));

  // Create ghost
  var srcRow=_grPD.rows.find(function(r){return parseInt(r.dataset.ri)===ri;});
  if(!srcRow) return;
  var ghost=srcRow.cloneNode(true);
  ghost.style.cssText='position:fixed;z-index:9999;opacity:.85;pointer-events:none;background:var(--bg3);border:1px solid var(--accent);border-radius:6px;box-shadow:0 8px 24px rgba(0,0,0,.5);width:'+srcRow.offsetWidth+'px;left:'+srcRow.getBoundingClientRect().left+'px;top:'+(clientY-20)+'px;';
  document.body.appendChild(ghost);
  _grPD.ghost=ghost;
  srcRow.style.opacity='0.3';

  document.addEventListener('mousemove',_grPointerMove,{passive:false});
  document.addEventListener('touchmove',_grPointerMove,{passive:false});
  document.addEventListener('mouseup',_grPointerEnd);
  document.addEventListener('touchend',_grPointerEnd);
}

function _grPointerMove(e){
  if(!_grPD.active) return;
  e.preventDefault();
  var clientY=e.touches?e.touches[0].clientY:e.clientY;
  if(_grPD.ghost) _grPD.ghost.style.top=(clientY-20)+'px';

  // Find row under cursor
  _grPD.rows.forEach(function(r){r.style.borderTop='';});
  var target=null;
  _grPD.rows.forEach(function(r){
    var rect=r.getBoundingClientRect();
    if(clientY>=rect.top&&clientY<=rect.bottom) target=r;
  });
  if(target&&parseInt(target.dataset.ri)!==_grPD.ri){
    _grPD.curRi=parseInt(target.dataset.ri);
    target.style.borderTop='2px solid var(--accent)';
  }
}

function _grPointerEnd(e){
  document.removeEventListener('mousemove',_grPointerMove);
  document.removeEventListener('touchmove',_grPointerMove);
  document.removeEventListener('mouseup',_grPointerEnd);
  document.removeEventListener('touchend',_grPointerEnd);

  if(_grPD.ghost){ _grPD.ghost.remove(); _grPD.ghost=null; }
  _grPD.rows.forEach(function(r){r.style.opacity='';r.style.borderTop='';});

  if(_grPD.active&&_grPD.sid&&_grPD.curRi!==null&&_grPD.curRi!==_grPD.ri){
    var subj=_grFind(_grPD.sid);
    if(subj){
      var items=subj.items;
      var item=items.splice(_grPD.ri,1)[0];
      var targetItem=items[_grPD.curRi<items.length?_grPD.curRi:items.length-1];
      if(targetItem) item.isMod=targetItem.isMod;
      items.splice(_grPD.curRi,0,item);
      _grFireSave(); renderGradesTable();
    }
  }
  _grPD.active=false; _grPD.sid=null; _grPD.ri=null; _grPD.curRi=null;
}


// ── CRUD ──
function grDeleteSubj(id){
  if(!confirm('Видалити предмет "'+(_grFind(id)||{name:''}).name+'"?')) return;
  _grSubjects=_grSubjects.filter(function(s){return s.id!==id;});
  _grFireSave(); renderGradesTable();
}
function grDelGrade(sid,ri){
  var subj=_grFind(sid); if(!subj) return;
  var item=subj.items[ri];
  if(item&&item._moodle&&item.id){
    if(!_grDeletedIds[sid]) _grDeletedIds[sid]=new Set();
    _grDeletedIds[sid].add(item.id);
  }
  subj.items.splice(ri,1);
  _grFireSave(); renderGradesTable();
}
function grAddGrade(sid,modNum){
  _grGrCtx={sid:sid,gi:null,isMod:false};
  var subj=_grFind(sid);
  document.getElementById('gre-title').textContent='➕ Поточна оцінка';
  document.getElementById('gre-name').value='';
  document.getElementById('gre-grade').value='';
  document.getElementById('gre-max').value='100';
  document.getElementById('gre-mod').value=String(modNum||1);
  document.getElementById('gre-type').value='cur';
  document.getElementById('gre-course').value=subj?subj.name:'';
  document.getElementById('gre-course').readOnly=true;
  document.getElementById('modal-gr-edit').style.display='flex';
  setTimeout(function(){document.getElementById('gre-name').focus();},80);
}
function grAddGradeMod(sid,modNum){
  _grGrCtx={sid:sid,gi:null,isMod:true};
  var subj=_grFind(sid);
  document.getElementById('gre-title').textContent='➕ Модульний тест';
  document.getElementById('gre-name').value='Модульний тест';
  document.getElementById('gre-grade').value='';
  document.getElementById('gre-max').value='40';
  document.getElementById('gre-mod').value=String(modNum||1);
  document.getElementById('gre-type').value='mod';
  document.getElementById('gre-course').value=subj?subj.name:'';
  document.getElementById('gre-course').readOnly=true;
  document.getElementById('modal-gr-edit').style.display='flex';
  setTimeout(function(){document.getElementById('gre-grade').focus();},80);
}
function grEditGrade(sid,ri){
  var subj=_grFind(sid); if(!subj) return;
  var item=subj.items[ri]; if(!item) return;
  _grGrCtx={sid:sid,gi:ri,isMod:item.isMod};
  document.getElementById('gre-title').textContent='✏️ Редагувати оцінку';
  document.getElementById('gre-name').value=item.name||'';
  document.getElementById('gre-grade').value=item.grade;
  document.getElementById('gre-max').value=item.max||100;
  document.getElementById('gre-mod').value=String(item.mod||1);
  document.getElementById('gre-type').value=item.isMod?'mod':'cur';
  document.getElementById('gre-course').value=subj.name;
  document.getElementById('gre-course').readOnly=true;
  document.getElementById('modal-gr-edit').style.display='flex';
}
function openGrAdd(){
  var name=prompt('Назва предмету:','Новий предмет');
  if(!name||!name.trim()) return;
  _grSubjects.push({id:'u_'+Date.now(),name:name.trim(),items:[],_moodle:false});
  _grFireSave(); renderGradesTable();
}
function closeGrEdit(){
  document.getElementById('modal-gr-edit').style.display='none';
  _grGrCtx=null;
}
function saveGrEdit(){
  if(!_grGrCtx) return;
  var name=document.getElementById('gre-name').value.trim();
  var grade=parseFloat(document.getElementById('gre-grade').value);
  var max=parseFloat(document.getElementById('gre-max').value)||100;
  var mod=parseInt(document.getElementById('gre-mod').value)||1;
  var type=document.getElementById('gre-type').value||'cur';
  if(!name||isNaN(grade)) return;
  var subj=_grFind(_grGrCtx.sid); if(!subj) return;
  var isMod=(type==='mod');
  var entry={id:'u_'+Date.now(),name:name,grade:grade,max:max,mod:mod,isMod:isMod,label:Math.round(grade)+'/'+Math.round(max),_moodle:false};
  if(_grGrCtx.gi!=null) subj.items[_grGrCtx.gi]=Object.assign({},subj.items[_grGrCtx.gi],entry,{id:subj.items[_grGrCtx.gi].id});
  else subj.items.push(entry);
  _grFireSave(); closeGrEdit(); renderGradesTable();
}
// stubs
function openGrEdit(){}
function hideGrItem(){}
function deleteGrCustom(){}
function openGrCourseFilter(){}
function closeGrCourseFilter(){}
function grSelectAll(){}
function grSelectNone(){}
function applyGrCourseFilter(){}


// ── FILES ──
function listenFiles() {
  if(!window._db||!group.id) return;
  const {collection,query,where,onSnapshot}=window._fb;
  const q=query(collection(window._db,'files'),where('groupId','==',group.id));
  const unsub=onSnapshot(q,snap=>{
    cachedFiles=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));
    checkFileNotifs(cachedFiles);
    renderFilesWithSearch(cachedFiles, filesSearchQuery);
    var sFiles = document.getElementById('s-files');
    if(sFiles) sFiles.textContent=cachedFiles.length;
    renderDashboardEvents();
    renderWidgetFiles();
    renderAdminStats();
  },err=>{ document.getElementById('files-list').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Помилка завантаження файлів.</p></div>'; });
  unsubs.push(unsub);
}
function handleFileSelect(inp) { Array.from(inp.files).forEach(uploadFile); inp.value=''; }
function handleDrop(e) { e.preventDefault(); document.getElementById('uz').classList.remove('drag'); Array.from(e.dataTransfer.files).forEach(uploadFile); }
async function uploadFile(file) {
  const MAX = 700 * 1024;
  if(file.size > MAX){ alert('Файл більше 700КБ (\'' + file.name + '\'). Завантаж на Google Drive і додай через Матеріали.'); return; }
  if(!window._db){alert('Firebase не готовий');return;}
  const uz=document.getElementById('uz');
  uz.innerHTML='<div class="ui">⏳</div><p>Завантаження ' + escHtml(file.name) + '...</p>';
  const {collection,addDoc}=window._fb;
  const reader=new FileReader();
  reader.onload=async e=>{
    try {
      await addDoc(collection(window._db,'files'),{
        groupId:group.id, groupName:group.name,
        name:file.name, size:file.size,
        uploader:userData.fullname||'Студент',
        createdAt:Date.now(), dataUrl:e.target.result
      });
    } catch(err){ alert('Помилка завантаження: ' + err.message); }
    uz.innerHTML='<div class="ui">📤</div><p><strong>Натисніть або перетягніть</strong></p><p style="font-size:10px;margin-top:2px;">до 700КБ</p>';
  };
  reader.readAsDataURL(file);
}
function renderFiles(files) {
  const el=document.getElementById('files-list');
  if(!files.length){el.innerHTML='<div class="empty"><div class="emo">📂</div><p>Файлів ще немає</p></div>';return;}
  el.innerHTML='<div class="file-list">'+files.map(f=>{
    const ext=(f.name||'').split('.').pop().toLowerCase();
    const ec=ext==='pdf'?'ep':['doc','docx'].includes(ext)?'ed':['xls','xlsx'].includes(ext)?'ex':'eo';
    const sz=f.size>1048576?(f.size/1048576).toFixed(1)+' МБ':Math.round(f.size/1024)+' КБ';
    return '<div class="file-item">'+
      '<div class="file-ext '+ec+'">'+escHtml(ext.toUpperCase())+'</div>'+
      '<div class="file-info"><div class="file-name">'+escHtml(f.name)+'</div>'+
      '<div class="file-meta">'+escHtml(f.uploader||'?')+' • '+new Date(f.createdAt).toLocaleDateString('uk-UA')+' • '+escHtml(sz)+'</div></div>'+
      '<div class="file-actions">'+
        (f.dataUrl?'<button class="btn a" onclick="dlFile(this.dataset.id)" data-id="'+escHtml(f.id)+'">⬇</button>':'')+
        '<button class="btn d" onclick="rmFile(this.dataset.id)" data-id="'+escHtml(f.id)+'">🗑</button>'+
      '</div></div>';
  }).join('')+'</div>';
}
async function dlFile(id) { const f=cachedFiles.find(x=>x.id===id); if(!f||!f.dataUrl)return; const a=document.createElement('a');a.href=f.dataUrl;a.download=f.name;a.click(); }
async function rmFile(id) {
  if(!confirm('Видалити файл?'))return;
  try { const {doc,deleteDoc}=window._fb; await deleteDoc(doc(window._db,'files',id)); }
  catch(e) { alert('Помилка видалення: ' + e.message); }
}

// ── MATERIALS ──
function listenMats() {
  if(!window._db||!group.id) return;
  const {collection,query,where,onSnapshot}=window._fb;
  const q=query(collection(window._db,'materials'),where('groupId','==',group.id));
  const unsub=onSnapshot(q,snap=>{ cachedMats=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)); renderMats(cachedMats); renderDashboardSummary(); renderDashboardEvents(); },
  err=>{ document.getElementById('mats-list').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Помилка завантаження матеріалів.</p></div>'; });
  unsubs.push(unsub);
}
function filterMats(q) { renderMats(cachedMats,(q||'').toLowerCase()); }
function renderMats(list,q='') {
  const el=document.getElementById('mats-list');
  const items=q?list.filter(m=>(m.name||'').toLowerCase().includes(q)||(m.subject||'').toLowerCase().includes(q)):list;
  if(!items.length){el.innerHTML='<div class="empty"><div class="emo">📝</div><p>Матеріалів ще немає</p></div>';return;}
  el.innerHTML='<div class="file-list">'+items.map(m=>
    '<div class="file-item">'+
    '<div class="file-ext eo">📝</div>'+
    '<div class="file-info"><div class="file-name">'+escHtml(m.name||'')+'</div>'+
    '<div class="file-meta">'+escHtml(m.subject||'')+(m.desc?' • '+escHtml(m.desc):'')+'</div></div>'+
    '<div class="file-actions">'+
      (m.desc&&/^https?:\/\//i.test(m.desc)?'<a href="'+escHtml(m.desc)+'" target="_blank" rel="noopener noreferrer"><button class="btn a">🔗</button></a>':'')+
      '<button class="btn d" onclick="rmMat(this.dataset.id)" data-id="'+escHtml(m.id)+'">🗑</button>'+
    '</div></div>'
  ).join('')+'</div>';
}

var _groupModalMode = 'create';
var _groupEditId = null;

function groupModalAction() {
  if(_groupModalMode === 'edit' && _groupEditId) _doEditGroup(_groupEditId);
  else createGroup();
}

async function _doEditGroup(id) {
  const name = document.getElementById('gn').value.trim();
  const faculty = document.getElementById('gf').value.trim();
  const course = parseInt(document.getElementById('gc').value)||1;
  if(!name) return;
  const now = new Date();
  const acadYear = now.getMonth() >= 7 ? now.getFullYear() : now.getFullYear() - 1;
  const entryYear = course <= 4 ? acadYear - course + 1 : null;
  const manualCourse = course > 4 ? course : null;
  const {doc, updateDoc} = window._fb;
  await updateDoc(doc(window._db,'groups',id), {name, faculty, course, entryYear, manualCourse});
  closeModal('add-group');
  ['gn','gf','gc'].forEach(i=>document.getElementById(i).value='');
}

function showModal(id) {
  if(id==='add-group') {
    _groupModalMode = 'create'; _groupEditId = null;
    document.querySelector('#modal-add-group h3').textContent = '🏫 Створити групу';
    document.getElementById('group-modal-btn').textContent = 'Створити';
  }
  document.getElementById('modal-'+id).classList.add('show');
}
function closeModal(id) { document.getElementById('modal-'+id).classList.remove('show'); }
async function addMat() {
  const name=document.getElementById('mn').value.trim();
  const subject=document.getElementById('ms').value.trim();
  const desc=document.getElementById('md').value.trim();
  if(!name)return;
  const {collection,addDoc}=window._fb;
  await addDoc(collection(window._db,'materials'),{groupId:group.id,groupName:group.name,name,subject,desc,uploader:userData.fullname||'?',createdAt:Date.now()});
  closeModal('add-mat');
  ['mn','ms','md'].forEach(id=>document.getElementById(id).value='');
}
async function rmMat(id) {
  if(!confirm('Видалити матеріал?'))return;
  try { const {doc,deleteDoc}=window._fb; await deleteDoc(doc(window._db,'materials',id)); }
  catch(e) { alert('Помилка видалення: ' + e.message); }
}

// ── CHAT ──
function setupChatRooms() {
  const rooms=[
    {id:'group-'+group.id, label:'👥 '+group.name, sub:'Ваша група'},
    {id:'faculty-'+(group.faculty||'general'), label:'🏛 Факультет', sub:group.faculty||'Загальний'},
    {id:'university', label:'🎓 Університет', sub:'Всі студенти'},
  ];
  const el=document.getElementById('chat-rooms');
  _loadChatDmRooms();
  const baseRooms = rooms.map(function(r){
    return '<div class="chat-room" onclick="openChatRoom(this.dataset.roomid,this.dataset.label)" data-roomid="'+escHtml(r.id)+'" data-label="'+escHtml(r.label)+'">'+
      escHtml(r.label)+'<div class="chat-room-sub">'+escHtml(r.sub)+'</div></div>';
  }).join('');
  const dmRooms = _chatDmRooms.length
    ? '<div class="chat-sidebar-divider"></div><div class="chat-sidebar-caption">Особисті</div>' +
      _chatDmRooms.map(function(r){
        return '<div class="chat-room chat-dm-room" onclick="openChatRoom(this.dataset.roomid,this.dataset.label)" data-roomid="'+escHtml(r.id)+'" data-label="'+escHtml(r.label)+'">'+
          '👤 '+escHtml(r.label)+'<div class="chat-room-sub">'+escHtml(r.sub||'Особисті повідомлення')+'</div></div>';
      }).join('')
    : '';
  el.innerHTML =
    '<div class="chat-sidebar-section">'+
      baseRooms+
      '<div class="chat-sidebar-divider"></div>'+
      '<button class="chat-add-btn" onclick="openChatUserModal()">＋ Додати чат</button>'+
      dmRooms+
    '</div>';
  if(currentChatRoom) {
    document.querySelectorAll('.chat-room').forEach(function(r){
      r.classList.toggle('active', r.dataset.roomid === currentChatRoom);
    });
  }
  _applyDynamicLayouts();
}
function _loadChatDmRooms() {
  try {
    var raw = localStorage.getItem('sh_dm_rooms');
    _chatDmRooms = raw ? JSON.parse(raw) : [];
  } catch(e) { _chatDmRooms = []; }
}
function _saveChatDmRooms() {
  try { localStorage.setItem('sh_dm_rooms', JSON.stringify(_chatDmRooms)); } catch(e) {}
  _saveChatDmRoomsToCloud();
}
async function _saveChatDmRoomsToCloud() {
  if(!window._db || !window._fb || !userData.userid) return;
  try {
    const {doc, setDoc} = window._fb;
    await setDoc(doc(window._db,'users',String(userData.userid)), {
      chatMeta: { dmRooms: _chatDmRooms.slice(0,20), updatedAt: Date.now() }
    }, {merge:true});
  } catch(e) {}
}
function _mergeDmRooms(primary, incoming) {
  var map = {};
  (primary || []).concat(incoming || []).forEach(function(room){
    if(!room || !room.id) return;
    map[room.id] = Object.assign(map[room.id] || {}, room);
  });
  return Object.keys(map).map(function(k){ return map[k]; }).slice(0,20);
}
function _initChatDmRoomsSync() {
  if(!window._db || !window._fb || !userData.userid) return;
  const {doc, onSnapshot} = window._fb;
  onSnapshot(doc(window._db,'users',String(userData.userid)), function(snap){
    if(!snap.exists()) return;
    var data = snap.data() || {};
    var cloudRooms = (data.chatMeta && Array.isArray(data.chatMeta.dmRooms)) ? data.chatMeta.dmRooms : [];
    var merged = _mergeDmRooms(_chatDmRooms, cloudRooms);
    var changed = JSON.stringify(merged) !== JSON.stringify(_chatDmRooms);
    _chatDmRooms = merged;
    try { localStorage.setItem('sh_dm_rooms', JSON.stringify(_chatDmRooms)); } catch(e) {}
    if(changed) {
      setupChatRooms();
      renderDashboardSummary();
    }
  });
}
function _dmRoomId(uidA, uidB) {
  return 'dm-' + [String(uidA), String(uidB)].sort().join('-');
}
function _rememberDmRoom(user) {
  if(!user || !user.id) return;
  var roomId = _dmRoomId(userData.userid, user.id);
  var existing = _chatDmRooms.find(function(r){ return r.id === roomId; });
  if(existing) {
    existing.label = user.name || existing.label;
    existing.sub = user.groupName || existing.sub || 'Особисті повідомлення';
  } else {
    _chatDmRooms.unshift({
      id: roomId,
      label: user.name || 'Користувач',
      sub: user.groupName || 'Особисті повідомлення',
      uid: String(user.id)
    });
  }
  _chatDmRooms = _chatDmRooms.slice(0, 20);
  _saveChatDmRooms();
}
async function openChatUserModal() {
  const modal = document.getElementById('chat-user-modal');
  const list = document.getElementById('chat-user-list');
  if(!modal || !list || !window._db || !window._fb) return;
  modal.style.display = 'flex';
  document.getElementById('chat-user-search').value = '';
  list.innerHTML = '<div class="loading"><div class="spinner"></div>Завантаження...</div>';
  try {
    const {collection, getDocs} = window._fb;
    const snap = await getDocs(collection(window._db, 'users'));
    _chatUsers = snap.docs
      .map(function(d){ return {id:d.id, ...d.data()}; })
      .filter(function(u){ return String(u.id) !== String(userData.userid); })
      .sort(function(a,b){ return (a.name||'').localeCompare(b.name||'', 'uk'); });
    renderChatUserList(_chatUsers);
    setTimeout(function(){
      var inp = document.getElementById('chat-user-search');
      if(inp) inp.focus();
    }, 40);
  } catch(e) {
    list.innerHTML = '<div class="empty"><div class="emo">⚠️</div><p>Не вдалося завантажити користувачів</p></div>';
  }
}
function closeChatUserModal() {
  var modal = document.getElementById('chat-user-modal');
  if(modal) modal.style.display = 'none';
}
function filterChatUserList(q) {
  q = (q || '').toLowerCase().trim();
  renderChatUserList(_chatUsers.filter(function(u){
    return !q || (u.name||'').toLowerCase().includes(q) || (u.groupName||'').toLowerCase().includes(q);
  }));
}
function renderChatUserList(users) {
  const list = document.getElementById('chat-user-list');
  if(!list) return;
  if(!users.length) {
    list.innerHTML = '<div class="empty"><div class="emo">🔎</div><p>Користувачів не знайдено</p></div>';
    return;
  }
  list.innerHTML = users.map(function(u){
    var initial = ((u.name||'?')[0] || '?').toUpperCase();
    var color = ROLE_COLORS[u.role] || '#8888aa';
    return '<div class="chat-user-item" data-uid="'+escHtml(String(u.id))+'" onclick="startDirectChat(this.dataset.uid)">'+
      '<div class="chat-user-avatar" style="background:'+escHtml(color)+'">'+escHtml(initial)+'</div>'+
      '<div class="chat-user-meta">'+
        '<div class="chat-user-name">'+escHtml(u.name||'Користувач')+'</div>'+
        '<div class="chat-user-sub">'+escHtml(u.groupName||'Без групи')+'</div>'+
      '</div>'+
      '<div class="chat-user-action">Написати</div>'+
    '</div>';
  }).join('');
}
function startDirectChat(uid) {
  var user = _chatUsers.find(function(u){ return String(u.id) === String(uid); });
  if(!user) return;
  _rememberDmRoom(user);
  setupChatRooms();
  closeChatUserModal();
  openChatRoom(_dmRoomId(userData.userid, user.id), user.name || 'Особистий чат');
}
function openChatRoom(roomId, label) {
  currentChatRoom=roomId;
  window._lastMsgRoom = roomId;
  window._lastMsgCount = undefined;
  _cancelReply(); // clear any leftover edit/reply state and input
  _listenRoomPresence(roomId);
  var titleEl = document.getElementById('chat-room-title');
  if(titleEl) titleEl.childNodes[0].nodeValue = label;
  document.querySelectorAll('.chat-room').forEach(r=>r.classList.remove('active'));
  const activeRoom=document.querySelector('[data-roomid="'+roomId+'"]');
  if(activeRoom) activeRoom.classList.add('active');
  if(chatUnsub) chatUnsub();
  subscribePinned(roomId);
  const {collection,query,where,onSnapshot,limit}=window._fb;
  const q=query(collection(window._db,'messages'),where('room','==',roomId),limit(50));
  chatUnsub=onSnapshot(q,snap=>{
    const msgs=snap.docs.map(d=>({id:d.id,...d.data()})).sort((a,b)=>(a.ts||0)-(b.ts||0));
    renderMessages(msgs);
  }, err=>{ document.getElementById('chat-msgs').innerHTML='<div class="empty"><div class="emo">⚠️</div><p>Помилка завантаження чату</p></div>'; });
}

function _highlightMentions(text, myName) {
  return text.replace(/@([\wЀ-ӿІіЇїЄєҐґʼ'-]+(?:\s[\wЀ-ӿІіЇїЄєҐґʼ'-]+){0,2})/g, (match, name) => {
    const isMe = myName && myName.toLowerCase().includes(name.toLowerCase());
    return `<span class="mention${isMe?' me':''}">${match}</span>`;
  });
}

var _mentionActive = false, _mentionStart = 0, _mentionQuery = '';
function _getChatMembers() {
  const msgs = document.querySelectorAll('.msg-author');
  const names = new Set();
  msgs.forEach(m => { if(m.textContent.trim()) names.add(m.textContent.trim()); });
  return [...names];
}

function _showMentionPopup(query) {
  let popup = document.getElementById('mention-popup');
  const members = _getChatMembers().filter(n => n.toLowerCase().startsWith(query.toLowerCase()));
  if(!members.length) { _hideMentionPopup(); return; }
  if(!popup) {
    popup = document.createElement('div');
    popup.id = 'mention-popup';
    popup.className = 'mention-popup';
    const wrap = document.querySelector('.chat-input-wrap');
    wrap.style.position = 'relative';
    wrap.appendChild(popup);
  }
  popup.innerHTML = members.map(n =>
    `<div class="mention-item" onclick="_insertMention('${escHtml(n)}')">
      <div class="mav">${escHtml(n[0].toUpperCase())}</div>
      ${escHtml(n)}
    </div>`
  ).join('');
  popup.style.display = 'block';
  _mentionActive = true;
}

function _hideMentionPopup() {
  const p = document.getElementById('mention-popup');
  if(p) p.style.display = 'none';
  _mentionActive = false;
}

function _insertMention(name) {
  const inp = document.getElementById('chat-inp');
  const val = inp.value;
  inp.value = val.slice(0, _mentionStart) + '@' + name + ' ' + val.slice(_mentionStart + _mentionQuery.length + 1);
  inp.focus();
  _hideMentionPopup();
}

const REACTION_EMOJIS = ['👍','❤️','😂','🔥','👏','😮','😢','🎉'];

function _renderReactions(m) {
  var reactions=m.reactions||{};
  var myUid=String(userData.userid);
  var grouped={};
  Object.entries(reactions).forEach(function(p){
    if(!grouped[p[1]]) grouped[p[1]]=[];
    grouped[p[1]].push(p[0]);
  });
  var html='<div class="msg-reactions">';
  var mid=escHtml(m.id||'');
  Object.entries(grouped).forEach(function(p){
    var em=p[0], uids=p[1], mine=uids.includes(myUid);
    html+='<button class="reaction-btn'+(mine?' mine':'')+'" data-mid="'+mid+'" data-em="'+escHtml(em)+'" onclick="toggleReaction(this.dataset.mid,this.dataset.em)" title="'+uids.length+' осіб">'+em+'<span class="rcnt">'+uids.length+'</span></button>';
  });
  html+='</div>';
  return html;
}
async function toggleReaction(msgId, emoji) {
  if(!msgId||!window._fb||!window._db) return;
  const myUid = String(userData.userid);
  const {doc, getDoc, updateDoc} = window._fb;
  const ref = doc(window._db, 'messages', msgId);
  try {
    const snap = await getDoc(ref);
    if(!snap.exists()) return;
    const reactions = snap.data().reactions || {};
    if(reactions[myUid] === emoji) delete reactions[myUid];
    else reactions[myUid] = emoji;
    await updateDoc(ref, {reactions});
  } catch(e) {}
}

var _replyTo = null;
var _editingMsgId = null;

function _setReply(msgId, msgEl) {
  _editingMsgId = null;
  var author = (msgEl.querySelector('.msg-author')||{}).textContent || 'Ви';
  var text = (msgEl.querySelector('.msg-bubble')||{}).textContent || '';
  _replyTo = {id: msgId, author: author.trim(), text: text.slice(0,80)};
  var bar = document.getElementById('reply-bar');
  if(!bar) return;
  bar.style.display = 'flex';
  document.getElementById('reply-bar-author').textContent = _replyTo.author;
  document.getElementById('reply-bar-text').textContent = _replyTo.text;
  document.getElementById('chat-inp').focus();
}

function _cancelReply() {
  _replyTo = null;
  _editingMsgId = null;
  var bar = document.getElementById('reply-bar');
  if(bar) { bar.style.display = 'none'; bar.style.borderLeftColor = ''; }
  var inp = document.getElementById('chat-inp');
  if(inp) { inp.value = ''; inp.style.height = 'auto'; }
}

var _msgTextCache = {};

function _startEditMsg(msgId, msgEl) {
  _replyTo = null;
  _editingMsgId = msgId;
  // Read from JS cache — never from DOM (avoids (ред.), reply quotes, html entities)
  var text = _msgTextCache[msgId] || '';
  var inp = document.getElementById('chat-inp');
  inp.value = text;
  inp.focus();
  var bar = document.getElementById('reply-bar');
  if(bar) {
    bar.style.display = 'flex';
    bar.style.borderLeftColor = 'var(--text2)';
    document.getElementById('reply-bar-author').textContent = '✏️ Редагування';
    document.getElementById('reply-bar-text').textContent = text.slice(0,80);
  }
}

function _ctxReact(e, el) {
  e.preventDefault();
  var mid = el.dataset.lp; if(!mid) return;
  _openMsgMenu(e.clientX, e.clientY, mid, el);
}
function _openMsgMenuFromButton(btn, msgId) {
  var msgEl = btn && btn.closest ? btn.closest('[data-lp]') : null;
  if(!msgEl || !msgId) return;
  var rect = btn.getBoundingClientRect();
  _openMsgMenu(rect.left + rect.width / 2, rect.bottom + 8, msgId, msgEl);
}

var _lpTimer = null;
function _lpStart(e, el) {
  _lpEnd();
  var msgId = el.dataset.lp; if(!msgId) return;
  // Kill any text selection that started
  if(window.getSelection) window.getSelection().removeAllRanges();
  var t = e.touches[0];
  var startX = t.clientX, startY = t.clientY;
  _lpTimer = setTimeout(function(){
    _lpTimer = null;
    if(window.getSelection) window.getSelection().removeAllRanges();
    if(navigator.vibrate) navigator.vibrate(30);
    _openMsgMenu(startX, startY, msgId, el);
  }, 500);
}
function _lpEnd(e) {
  if(_lpTimer){ clearTimeout(_lpTimer); _lpTimer=null; }
}
function _lpMove(e, el) {
  if(!_lpTimer) return;
  var t = e.touches[0];
  if(Math.abs(t.clientX - _lpStartX) > 10 || Math.abs(t.clientY - _lpStartY) > 10) {
    _lpEnd();
  }
}
var _lpStartX = 0, _lpStartY = 0;

// Register touch events with passive:false so preventDefault works
function _attachMsgTouchEvents(container) {
  container.addEventListener('touchstart', function(e) {
    // Don't intercept taps on images — let openLightbox work
    if(e.target.tagName === 'IMG') return;
    var el = e.target.closest('[data-lp]');
    if(!el) return;
    _lpStartX = e.touches[0].clientX;
    _lpStartY = e.touches[0].clientY;
    _lpStart(e, el);
  }, {passive: false});
  container.addEventListener('touchend', function(e) {
    _lpEnd(e);
  }, {passive: true});
  container.addEventListener('touchmove', function(e) {
    var el = e.target.closest('[data-lp]');
    if(el) _lpMove(e, el);
  }, {passive: true});
  container.addEventListener('contextmenu', function(e) {
    if(e.target.tagName === 'IMG') return;
    var el = e.target.closest('[data-lp]');
    if(el) { e.preventDefault(); _ctxReact(e, el); }
  });
  container.addEventListener('selectstart', function(e) {
    if(_lpTimer) e.preventDefault();
  });
}

function _closeMsgMenu() {
  var m = document.getElementById('msg-ctx-menu'); if(m) m.remove();
  var o = document.getElementById('msg-ctx-overlay'); if(o) o.remove();
}

function _openMsgMenu(cx, cy, msgId, msgEl) {
  _closeMsgMenu();
  var isMe = msgEl && msgEl.classList.contains('me');
  var msgText = (msgEl && msgEl.querySelector('.msg-bubble') || {}).textContent || '';

  var overlay = document.createElement('div');
  overlay.id = 'msg-ctx-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:1000;';
  overlay.onclick = _closeMsgMenu;
  document.body.appendChild(overlay);

  var menu = document.createElement('div');
  menu.id = 'msg-ctx-menu';
  menu.className = 'msg-ctx-menu';

  var emoRow = document.createElement('div');
  emoRow.className = 'msg-ctx-emojis';
  REACTION_EMOJIS.forEach(function(em){
    var btn = document.createElement('button');
    btn.className = 'msg-ctx-emoji-btn';
    btn.textContent = em;
    btn.onclick = function(){ _closeMsgMenu(); toggleReaction(msgId, em); };
    emoRow.appendChild(btn);
  });
  menu.appendChild(emoRow);

  var sep = document.createElement('div');
  sep.className = 'msg-ctx-sep';
  menu.appendChild(sep);

  _ctxItem(menu, '↩️', 'Відповісти', function(){ _closeMsgMenu(); _setReply(msgId, msgEl); });
  _ctxItem(menu, '📋', 'Копіювати', function(){ _closeMsgMenu(); _copyMsgText(msgId); });
  if(isMe) _ctxItem(menu, '✏️', 'Редагувати', function(){ _closeMsgMenu(); _startEditMsg(msgId, msgEl); });
  if(typeof canMod==='function' && canMod())
    _ctxItem(menu, '📌', 'Закріпити', function(){ _closeMsgMenu(); var auth=(msgEl.querySelector('.msg-author')||{}).textContent||(isMe?(userData.fullname||'?'):'?'); pinMessage(msgId, msgText.slice(0,80), auth.trim()); });
  if(isMe || (typeof canMod==='function' && canMod()))
    _ctxItem(menu, '🗑', 'Видалити', function(){ _closeMsgMenu(); delMsg(msgId); }, true);

  document.body.appendChild(menu);

  var mw = menu.offsetWidth||210, mh = menu.offsetHeight||200;
  var vw = window.innerWidth, vh = window.innerHeight;
  var x = cx, y = cy;
  if(x + mw > vw - 8) x = vw - mw - 8;
  if(y + mh > vh - 8) y = vh - mh - 8;
  if(y < 8) y = 8;
  menu.style.left = x + 'px';
  menu.style.top  = y + 'px';
}

function _copyMsgText(msgId) {
  var text = _msgTextCache[msgId] || '';
  if(!text) return;
  if(navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(function(){ _showCopyToast(); }).catch(function(){ _copyFallback(text); });
  } else {
    _copyFallback(text);
  }
}

function _copyFallback(text) {
  var ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-999px;left:-999px;opacity:0;';
  document.body.appendChild(ta);
  ta.focus(); ta.select();
  try { document.execCommand('copy'); _showCopyToast(); } catch(e) {}
  document.body.removeChild(ta);
}

function _showCopyToast() {
  var t = document.getElementById('copy-toast');
  if(!t) {
    t = document.createElement('div');
    t.id = 'copy-toast';
    t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%);background:var(--card);border:1px solid var(--border);border-radius:10px;padding:8px 16px;font-size:13px;font-weight:600;color:var(--text);z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.3);pointer-events:none;transition:opacity .3s;';
    document.body.appendChild(t);
  }
  t.textContent = '✅ Скопійовано';
  t.style.opacity = '1';
  clearTimeout(t._timer);
  t._timer = setTimeout(function(){ t.style.opacity = '0'; }, 1500);
}

function _ctxItem(menu, icon, label, fn, danger) {
  var el = document.createElement('div');
  el.className = 'msg-ctx-item' + (danger ? ' msg-ctx-danger' : '');
  el.innerHTML = '<span>'+icon+'</span> '+label;
  el.onclick = fn;
  menu.appendChild(el);
}

var _pinnedUnsub = null;
var _currentPinnedMsg = null;

async function pinMessage(msgId, msgText, author) {
  if(!canMod()) return;
  if(!window._fb||!window._db) return;
  const {doc, setDoc} = window._fb;
  try {
    await setDoc(doc(window._db,'pinned',currentChatRoom), {
      msgId, text: msgText, author, pinnedBy: userData.fullname||'?', ts: Date.now()
    });
  } catch(e) {}
}

async function unpinMessage() {
  if(!canMod()) return;
  if(!window._fb||!window._db) return;
  const {doc, deleteDoc} = window._fb;
  try { await deleteDoc(doc(window._db,'pinned',currentChatRoom)); } catch(e) {}
}

function subscribePinned(roomId) {
  if(_pinnedUnsub) { _pinnedUnsub(); _pinnedUnsub=null; }
  const {doc, onSnapshot} = window._fb;
  _pinnedUnsub = onSnapshot(doc(window._db,'pinned',roomId), snap => {
    const bar = document.getElementById('pinned-bar');
    if(!bar) return;
    if(snap.exists()) {
      const d = snap.data();
      _currentPinnedMsg = d;
      bar.style.display = 'flex';
      bar.querySelector('.pinned-bar-text').textContent = (d.author?d.author+': ':'') + (d.text||'');
    } else {
      _currentPinnedMsg = null;
      bar.style.display = 'none';
    }
  });
}

function renderMessages(msgs) {
  const el=document.getElementById('chat-msgs');
  if(!msgs.length){el.innerHTML='<div class="empty"><div class="emo">💬</div><p>Повідомлень ще немає</p></div>';return;}
  if(window._lastMsgRoom !== currentChatRoom) {
    window._lastMsgRoom = currentChatRoom;
    window._lastMsgCount = msgs.length;
  }
  el.innerHTML=msgs.map(m=>{
    const isMe=m.uid===String(userData.userid);
    const t=m.ts?new Date(m.ts).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'}):'';
    const canDel = canMod() || m.uid===String(userData.userid);
    const fileHtml = m.file
      ? (m.file.type&&m.file.type.startsWith('image/')
          ? '<br><img src="'+m.file.data+'" style="max-width:220px;max-height:220px;border-radius:10px;display:block;margin-top:6px;cursor:pointer;box-shadow:0 2px 12px rgba(0,0,0,.3);transition:transform .15s;" onclick="openLightbox(this.src,\''+escHtml(m.file.name||'photo')+'\')" onmouseover="this.style.transform=\'scale(1.02)\'" onmouseout="this.style.transform=\'scale(1)\'">'
          : '<br><a href="'+m.file.data+'" download="'+escHtml(m.file.name||'file')+'" style="display:inline-flex;align-items:center;gap:5px;padding:5px 9px;background:rgba(255,255,255,.07);border-radius:7px;font-size:11px;color:var(--text);text-decoration:none;margin-top:4px;">\u{1F4C4} '+escHtml(m.file.name||'Файл')+'</a>')
      : '';
    const msgText = m.text ? _highlightMentions(escHtml(m.text), userData.fullname) : '';
    const replyHtml = m.replyTo ? '<div class="msg-reply" onclick="event.stopPropagation();_scrollToMsg(\''+escHtml(m.replyTo.id||'')+'\')"><b>'+escHtml(m.replyTo.author||'')+'</b> '+escHtml((m.replyTo.text||'').slice(0,60))+'</div>' : '';
    const editedMark = m.edited ? ' <span class="msg-edited-mark" style="font-size:9px;opacity:.5;font-style:italic">(ред.)</span>' : '';
    const pinBtn = (canMod()&&m.id) ? '<button class="msg-del" onclick="pinMessage(\''+escHtml(m.id)+'\',\''+escHtml((m.text||'').slice(0,80)).replace(/'/g,'')+'\'  ,\''+escHtml(m.author||'')+'\');" style="background:rgba(240,192,64,.12);border:1px solid rgba(240,192,64,.25);color:var(--accent);border-radius:5px;padding:2px 5px;font-size:9px;cursor:pointer;opacity:0;transition:opacity .2s;flex-shrink:0" title="Закріпити">📌</button>' : '';
    const delBtn = (canDel&&m.id) ? '<button class="msg-del" data-id="'+escHtml(m.id)+'" onclick="delMsg(this.dataset.id)" style="background:rgba(224,80,80,.15);border:1px solid rgba(224,80,80,.3);color:var(--accent2);border-radius:5px;padding:2px 5px;font-size:9px;cursor:pointer;opacity:0;transition:opacity .2s;flex-shrink:0">🗑</button>' : '';
    var _mid=escHtml(m.id||'');
    var _lpA=_mid?' data-lp="'+_mid+'"':'';
    // Cache clean text for editing (strip trailing edit marks in case of old data)
    if(m.id) _msgTextCache[m.id] = (m.text||'').replace(/\s*\(ред\.\)\s*$/, '').trim();
    return '<div class="msg '+(isMe?'me':'other')+'" style="position:relative" '+_lpA+' '+
      'onmouseenter="this.querySelectorAll(\'.msg-del\').forEach(b=>b.style.opacity=1)" '+
      'onmouseleave="this.querySelectorAll(\'.msg-del\').forEach(b=>b.style.opacity=0)">'+
      (!isMe?'<div class="msg-author">'+escHtml(m.author)+'</div>':'')+
      '<div style="display:flex;align-items:flex-end;gap:4px;'+(isMe?'flex-direction:row-reverse':'')+'">' +
        '<div class="msg-bubble">'+replyHtml+msgText+editedMark+fileHtml+'</div>'+
        '<button class="msg-touch-menu" onclick="_openMsgMenuFromButton(this,\''+_mid+'\');event.stopPropagation();" title="Дії">⋯</button>'+
        pinBtn+delBtn+
      '</div>'+
      _renderReactions(m)+
      '<div class="msg-time">'+t+'</div></div>';
  }).join('');
  el.scrollTop=el.scrollHeight;
  // Attach touch events with passive:false (only once per container)
  if(!el._touchEventsAttached) {
    _attachMsgTouchEvents(el);
    el._touchEventsAttached = true;
  }
  if(window._lastMsgCount!==undefined&&window._lastMsgRoom===currentChatRoom&&msgs.length>window._lastMsgCount){
    msgs.slice(window._lastMsgCount).forEach(function(m){
      if(m.uid!==String(userData.userid)&&m.text&&userData.fullname&&
         m.text.toLowerCase().includes('@'+userData.fullname.split(' ')[0].toLowerCase())){
        _pingNotify(m.author,m.text);
      }
    });
  }
  window._lastMsgCount=msgs.length;
}

var _chatPingCount = 0;
function _pingNotify(author,text){
  if(_currentPage!=='chat'){
    _chatPingCount++;
    var b1=document.getElementById('chat-badge');
    var b2=document.getElementById('bnav-chat-badge');
    if(b1){b1.textContent=_chatPingCount;b1.style.display='';}
    if(b2){b2.textContent=_chatPingCount;b2.style.display='';}
  }
  if(Notification.permission==='granted'){
    try{new Notification('🔔 '+(author||'Хтось')+' згадав вас',{body:text.slice(0,80),tag:'mention_'+Date.now()});}catch(e){}
  }
  try{
    var ctx=new(window.AudioContext||window.webkitAudioContext)();
    function beep(freq,start,dur,vol){
      var o=ctx.createOscillator(),g=ctx.createGain();
      o.connect(g);g.connect(ctx.destination);
      o.type='sine';
      o.frequency.setValueAtTime(freq,ctx.currentTime+start);
      g.gain.setValueAtTime(0,ctx.currentTime+start);
      g.gain.linearRampToValueAtTime(vol||0.2,ctx.currentTime+start+0.01);
      g.gain.exponentialRampToValueAtTime(0.001,ctx.currentTime+start+dur);
      o.start(ctx.currentTime+start);
      o.stop(ctx.currentTime+start+dur+0.02);
    }
    beep(1568,0,0.08,0.18);
    beep(2093,0.09,0.12,0.12);
  }catch(e){}
}
function _clearChatBadge(){
  _chatPingCount=0;
  var b1=document.getElementById('chat-badge');
  var b2=document.getElementById('bnav-chat-badge');
  if(b1){b1.style.display='none';}
  if(b2){b2.style.display='none';}
}

function chatKey(e) {
  if(_mentionActive) {
    if(e.key==='Escape') { _hideMentionPopup(); return; }
    if(e.key==='Enter' || e.key==='Tab') {
      const first = document.querySelector('#mention-popup .mention-item');
      if(first) { e.preventDefault(); first.click(); return; }
    }
  }
  if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg();}
}
function chatInputHandler(e) {
  autoResizeChat(e.target);
  const val = e.target.value, pos = e.target.selectionStart;
  const before = val.slice(0, pos);
  const atMatch = before.match(/@([\wЀ-ӿІіЇїЄєҐґ]*)$/);
  if(atMatch) {
    _mentionStart = before.lastIndexOf('@');
    _mentionQuery = atMatch[1];
    _showMentionPopup(_mentionQuery);
  } else {
    _hideMentionPopup();
  }
}
function autoResizeChat(el) { el.style.height='auto'; el.style.height=Math.min(el.scrollHeight,140)+'px'; }

var _chatFile = null;
function handleChatFile(inp) {
  const file = inp.files[0];
  if(!file) return;
  if(file.size > 700*1024) { alert('Файл завеликий. Максимум 700КБ.'); inp.value=''; return; }
  _chatFile = file;
  document.getElementById('chat-file-name').textContent = '\u{1F4CE} ' + file.name;
  document.getElementById('chat-file-preview').style.display = 'flex';
  inp.value = '';
}

function handleChatPaste(e) {
  const items = ((e.clipboardData || e.originalEvent && e.originalEvent.clipboardData) || {}).items || [];
  for(const item of items) {
    if(item.type.startsWith('image/')) {
      e.preventDefault();
      const file = item.getAsFile();
      if(!file) break;
      _chatFile = file;
      document.getElementById('chat-file-name').textContent = '\u{1F4F7} Зображення';
      document.getElementById('chat-file-preview').style.display = 'flex';
      break;
    }
  }
}

function _base64ToBlob(src) {
  try {
    const arr = src.split(','), mime = arr[0].match(/:(.*?);/)[1];
    const bstr = atob(arr[1]);
    const u8 = new Uint8Array(bstr.length);
    for(let i=0;i<bstr.length;i++) u8[i] = bstr.charCodeAt(i);
    return URL.createObjectURL(new Blob([u8], {type:mime}));
  } catch(e) { return src; }
}
function openLightbox(src, filename) {
  const lb=document.getElementById('lightbox');
  const img=document.getElementById('lightbox-img');
  const dl=document.getElementById('lightbox-download');
  const fn=document.getElementById('lightbox-filename');
  if(!lb||!img) return;
  img.src='';
  const blobUrl=src&&src.startsWith('data:')?_base64ToBlob(src):src;
  img.src=blobUrl;
  if(dl){dl.href=blobUrl;dl.download=filename||'image';}
  if(fn) fn.textContent=filename||'';
  lb.style.display='block'; lb.style.overflowY='auto';
  document.body.style.overflow='hidden'; document.body.style.position='fixed'; document.body.style.width='100%';
  document.addEventListener('keydown',_lbKey);
  lb.onclick=function(e){if(e.target===lb||e.target===lb.firstElementChild)closeLightbox();};
  const closeBtn=document.getElementById('lightbox-close');
  if(closeBtn){
    closeBtn.ontouchstart=function(e){e.stopPropagation();e.preventDefault();};
    closeBtn.ontouchend=function(e){e.stopPropagation();e.preventDefault();closeLightbox();};
    closeBtn.onclick=function(e){e.stopPropagation();closeLightbox();};
  }
  let _lbScale=1,_lbDist0=0;
  img.addEventListener('touchstart',function(e){if(e.touches.length===2)_lbDist0=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);},{passive:true});
  img.addEventListener('touchmove',function(e){if(e.touches.length===2){const d=Math.hypot(e.touches[0].clientX-e.touches[1].clientX,e.touches[0].clientY-e.touches[1].clientY);if(_lbDist0){_lbScale=Math.min(Math.max(_lbScale*(d/_lbDist0),.5),4);img.style.transform='scale('+_lbScale+')';_lbDist0=d;}}},{passive:true});
  img.ondblclick=function(){_lbScale=_lbScale>1?1:2;img.style.transform='scale('+_lbScale+')';};
}
function closeLightbox(){
  const lb=document.getElementById('lightbox');const img=document.getElementById('lightbox-img');
  if(!lb)return;
  if(img.src&&img.src.startsWith('blob:'))URL.revokeObjectURL(img.src);
  img.src='';img.style.transform='scale(1)';lb.style.display='none';
  document.removeEventListener('keydown',_lbKey);
  // Delay restoring body scroll to prevent touchend firing on elements underneath
  setTimeout(function(){
    document.body.style.overflow='';document.body.style.position='';document.body.style.width='';
  }, 50);
}
function _lbKey(e){if(e.key==='Escape')closeLightbox();}

function clearChatFile() { _chatFile=null; document.getElementById('chat-file-preview').style.display='none'; }

function _scrollToMsg(msgId) {
  if(!msgId) return;
  var el = document.querySelector('[data-lp="'+msgId+'"]');
  if(!el) return;
  el.scrollIntoView({behavior:'smooth', block:'center'});
  el.style.transition = 'background .3s';
  el.style.background = 'rgba(240,192,64,.15)';
  setTimeout(function(){ el.style.background = ''; }, 1500);
}

// ── Online presence ──
var _presenceInterval = null;

function _startPresence() {
  if(!window._db || !window._fb || !userData) return;
  function beat() {
    try {
      const {doc, setDoc} = window._fb;
      setDoc(doc(window._db, 'presence', String(userData.userid)), {
        uid: String(userData.userid),
        name: userData.fullname || '?',
        lastSeen: Date.now(),
        room: currentChatRoom || null
      }, {merge: true});
    } catch(e) {}
  }
  beat();
  if(_presenceInterval) clearInterval(_presenceInterval);
  _presenceInterval = setInterval(beat, 30000);
}

var _presenceUnsub = null;
function _listenRoomPresence(roomId) {
  if(_presenceUnsub) { _presenceUnsub(); _presenceUnsub = null; }
  var cnt = document.getElementById('chat-online-count');
  if(!roomId) { if(cnt) cnt.style.display='none'; return; }
  const {collection, onSnapshot} = window._fb;
  _presenceUnsub = onSnapshot(collection(window._db, 'presence'), function(snap) {
    var online = snap.docs.filter(function(d){
      var p = d.data(); return p.lastSeen > Date.now() - 90000;
    });
    if(cnt) {
      cnt.textContent = online.length + ' онлайн';
      cnt.style.display = online.length ? '' : 'none';
    }
    var nameMap = {};
    online.forEach(function(d){ nameMap[d.data().name] = true; });
    document.querySelectorAll('.msg-author').forEach(function(el){
      var name = el.dataset.name || el.textContent.replace('🟢','').trim();
      el.dataset.name = name;
      var dot = el.querySelector('.online-dot');
      if(nameMap[name] && !dot){
        var d = document.createElement('span');
        d.className = 'online-dot'; el.appendChild(d);
      } else if(!nameMap[name] && dot){ dot.remove(); }
    });
  });
}

window.addEventListener('resize', function() {
  _applySidebarWidth();
  _applyDynamicLayouts();
  _applyAdminDesktopLayout();
  _applyDeadlinesWidth();
});

async function sendMsg() {
  if(!currentChatRoom)return;
  const inp=document.getElementById('chat-inp');
  const text=inp.value.trim();
  if(!text&&!_chatFile)return;

  if(_editingMsgId) {
    const {doc,updateDoc}=window._fb;
    try { await updateDoc(doc(window._db,'messages',_editingMsgId),{text,edited:true}); } catch(e){}
    _cancelReply();
    return;
  }

  inp.value=''; inp.style.height='40px';
  const {collection,addDoc}=window._fb;
  let fileData=null;
  if(_chatFile) {
    fileData=await new Promise((res,rej)=>{
      const r=new FileReader();
      r.onload=ev=>res({name:_chatFile.name||'file',type:_chatFile.type||'',data:ev.target.result});
      r.onerror=rej; r.readAsDataURL(_chatFile);
    });
    clearChatFile();
  }
  const payload = {
    room:currentChatRoom, text:text||'',
    author:userData.fullname||'?',
    uid:String(userData.userid),
    groupId:group.id,
    ts:Date.now(),
    ...(fileData?{file:fileData}:{}),
    ...(_replyTo?{replyTo:_replyTo}:{})
  };
  await addDoc(collection(window._db,'messages'), payload);
  _cancelReply();
}

async function delMsg(id) {
  if(!canMod()&&!confirm('Видалити своє повідомлення?'))return;
  try { const {doc,deleteDoc}=window._fb; await deleteDoc(doc(window._db,'messages',id)); }
  catch(e){ alert('Помилка: '+e.message); }
}

// ── ADMIN ──
function listenAdminData() {
  if(!window._db)return;
  const {collection,query,onSnapshot,orderBy}=window._fb;
  onSnapshot(query(collection(window._db,'groups'),orderBy('name')),snap=>{
    const groups=snap.docs.map(d=>({id:d.id,...d.data()}));
    _adminGroups = groups;
    renderAdminGroups(groups);
    renderAdminStats();
  },err=>{ document.getElementById('admin-groups-list').innerHTML='<div class="empty"><p>Помилка</p></div>'; });
  onSnapshot(collection(window._db,'users'),snap=>{
    const users=snap.docs.map(d=>({id:d.id,...d.data()}));
    _allAdminUsers=users;
    const q=(document.getElementById('users-search')||{value:''}).value;
    filterAdminUsers(q);
    renderAdminStats();
  });
}
function renderAdminStats() {
  const el = document.getElementById('admin-stats');
  if(!el) return;
  const groupsCount = _adminGroups.length;
  const usersCount = _allAdminUsers.length;
  const filesCount = Array.isArray(cachedFiles) ? cachedFiles.length : 0;
  el.innerHTML =
    '<div class="admin-stat">'+
      '<div class="admin-stat-label">👥 <span>Користувачів</span></div>'+
      '<div class="admin-stat-value">'+usersCount+'</div>'+
    '</div>'+
    '<div class="admin-stat">'+
      '<div class="admin-stat-label">🏫 <span>Груп</span></div>'+
      '<div class="admin-stat-value">'+groupsCount+'</div>'+
    '</div>'+
    '<div class="admin-stat">'+
      '<div class="admin-stat-label">📁 <span>Файлів</span></div>'+
      '<div class="admin-stat-value">'+filesCount+'</div>'+
    '</div>';
}
function renderAdminGroups(groups) {
  const el=document.getElementById('admin-groups-list');
  if(!groups.length){el.innerHTML='<div class="empty"><p>Груп ще немає</p></div>';return;}
  el.innerHTML=groups.map(g=>
    '<div class="group-item">'+
    '<div><div class="gname">'+escHtml(g.name)+'</div><div class="gcnt">'+escHtml(g.faculty||'—')+' • Курс '+escHtml(String(getGroupCourse(g)))+'</div></div>'+
    '<div style="display:flex;gap:3px;flex-shrink:0;">'+
    '<button class="btn" onclick="editGroup(this.dataset.id,this.dataset.name,this.dataset.faculty,this.dataset.course)" data-id="'+escHtml(g.id)+'" data-name="'+escHtml(g.name)+'" data-faculty="'+escHtml(g.faculty||'')+'" data-course="'+escHtml(String(g.course||'1'))+'">✏️</button>'+
    '<button class="btn d" onclick="delGroup(this.dataset.id)" data-id="'+escHtml(g.id)+'">🗑</button>'+
    '</div></div>'
  ).join('');
}
function filterAdminUsers(q){ const filtered=q?_allAdminUsers.filter(u=>(u.name||'').toLowerCase().includes((q||'').toLowerCase())):_allAdminUsers; renderAdminUsers(filtered); }
function renderAdminUsers(users) {
  const el=document.getElementById('admin-users-list');
  if(!users.length){el.innerHTML='<div class="empty"><p>Користувачів ще немає</p></div>';return;}
  el.innerHTML=users.map(u=>
    '<div class="user-row">'+
    '<div class="uav" style="background:'+escHtml(ROLE_COLORS[u.role]||'#8888aa')+'">'+escHtml((u.name||'?')[0].toUpperCase())+'</div>'+
    '<div style="flex:1;min-width:0;"><div class="uname" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+escHtml(u.name||'?')+'</div>'+
    '<div style="font-size:9px;color:var(--text2);">'+escHtml(u.groupName||'')+'</div></div>'+
    (canAdmin()?'<select class="role-sel" data-uid="'+escHtml(u.id)+'" onchange="setRole(this.dataset.uid,this.value)">'+
      Object.keys(ROLES).map(r=>'<option value="'+escHtml(r)+'"'+(u.role===r?' selected':'')+'>'+escHtml(ROLES[r])+'</option>').join('')+
    '</select>':'')+
    '</div>'
  ).join('');
}
async function setRole(uid,role){ const {doc,updateDoc}=window._fb; await updateDoc(doc(window._db,'users',uid),{role}); }
async function createGroup() {
  const name=document.getElementById('gn').value.trim();
  const faculty=document.getElementById('gf').value.trim();
  const course=parseInt(document.getElementById('gc').value)||1;
  if(!name)return;
  const {collection,addDoc}=window._fb;
  const now=new Date();
  const acadYear=now.getMonth()>=7?now.getFullYear():now.getFullYear()-1;
  const entryYear=course<=4?acadYear-course+1:null;
  const manualCourse=course>4?course:null;
  await addDoc(collection(window._db,'groups'),{name,faculty,course,entryYear,manualCourse,createdAt:Date.now()});
  closeModal('add-group');
  ['gn','gf','gc'].forEach(id=>document.getElementById(id).value='');
}
function editGroup(id,name,faculty,course){
  _groupModalMode='edit'; _groupEditId=id;
  document.getElementById('gn').value=name; document.getElementById('gf').value=faculty; document.getElementById('gc').value=course;
  document.querySelector('#modal-add-group h3').textContent='✏️ Редагувати групу';
  document.getElementById('group-modal-btn').textContent='Зберегти';
  document.getElementById('modal-add-group').classList.add('show');
}
async function delGroup(id){ if(!confirm('Видалити групу?'))return; const {doc,deleteDoc}=window._fb; await deleteDoc(doc(window._db,'groups',id)); }

// ── NAV ──
var PAGE_TITLES={dashboard:'Головна',deadlines:'Дедлайни',courses:'Курси',grades:'Оцінки',files:'Файли',materials:'Матеріали',chat:'Чати',admin:'Адмін-панель',calendar:'Календар',notes:'Нотатки',assistant:'Асистент',notifications:'Сповіщення'};
const PAGE_ORDER = ['dashboard','deadlines','courses','grades','calendar','assistant','files','materials','notes','chat','notifications','admin'];
let _currentPage = 'dashboard';

function go(name) {
  const prevName = _currentPage;
  if(prevName === name) return;
  const nextPg = document.getElementById('page-' + name);
  if(!nextPg) return;
  const prevIdx = PAGE_ORDER.indexOf(prevName);
  const nextIdx = PAGE_ORDER.indexOf(name);
  const forward = nextIdx === -1 || prevIdx === -1 || nextIdx > prevIdx;
  const enterCls = forward ? 'pg-enter-right' : 'pg-enter-left';
  document.querySelectorAll('.page').forEach(p => {
    p.classList.remove('active','pg-enter-right','pg-enter-left');
  });
  nextPg.classList.add('active');
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      nextPg.classList.add(enterCls);
      nextPg.addEventListener('animationend', () => nextPg.classList.remove(enterCls), {once:true});
    });
  });
  _currentPage = name;
  // Show back arrow instead of hamburger when in chat (mobile)
  const backBtn = document.getElementById('topbar-back');
  const hamburger = document.getElementById('topbar-hamburger');
  const inChat = name === 'chat';
  if(backBtn) backBtn.style.display = inChat ? '' : 'none';
  if(hamburger) hamburger.style.display = inChat ? 'none' : '';
  const labels={dashboard:'Голов',deadlines:'Дедл',courses:'Курс',grades:'Оцін',files:'Файл',materials:'Матер',chat:'Чат',admin:'Адмін',calendar:'Календ',notes:'Нотат',assistant:'Асист',notifications:'Сповіщ'};
  document.querySelectorAll('.nav-item').forEach(n=>n.classList.toggle('active',n.textContent.trim().startsWith(labels[name]||'_')));
  document.getElementById('topbar-title').textContent=PAGE_TITLES[name]||name;
  if(name==='calendar') renderCalendar();
  if(name==='chat') _clearChatBadge();
  if(name==='assistant'||name==='notes') _loadKaTeX();
  if(name==='notes') loadNotes();
  if(name==='grades') loadGrades();
  if(name==='notifications') markAllRead();
  _applyDynamicLayouts();
  closeSidebar();
}
function setBnav(name){
  document.querySelectorAll('.bnav-item').forEach(b=>b.classList.remove('active'));
  const el=document.getElementById('bn-'+name);
  if(el) el.classList.add('active');
}

function topbarBack() {
  go('dashboard'); setBnav('dashboard');
}

// Hide bottom nav when keyboard opens (mobile)
(function() {
  var bottomNav = null;
  function getNav() { return bottomNav || (bottomNav = document.getElementById('bottom-nav')); }

  if(window.visualViewport) {
    window.visualViewport.addEventListener('resize', function() {
      var nav = getNav(); if(!nav) return;
      var keyboardOpen = window.visualViewport.height < window.innerHeight - 100;
      nav.style.display = keyboardOpen ? 'none' : '';
      if(keyboardOpen && _currentPage === 'chat') {
        setTimeout(function(){ var m=document.getElementById('chat-msgs'); if(m) m.scrollTop=m.scrollHeight; }, 100);
      }
    });
  }
})();

// Swipe right to go back (from chat to dashboard)
(function() {
  var _swipeStartX = 0, _swipeStartY = 0;
  document.addEventListener('touchstart', function(e) {
    _swipeStartX = e.touches[0].clientX;
    _swipeStartY = e.touches[0].clientY;
  }, {passive: true});
  document.addEventListener('touchend', function(e) {
    if(_currentPage !== 'chat') return;
    var dx = e.changedTouches[0].clientX - _swipeStartX;
    var dy = Math.abs(e.changedTouches[0].clientY - _swipeStartY);
    // Swipe right from left edge (like iOS back gesture)
    if(_swipeStartX < 40 && dx > 60 && dy < 80) {
      go('dashboard'); setBnav('dashboard');
    }
  }, {passive: true});
})();

function openSidebar(){document.getElementById('sidebar').classList.add('open');document.getElementById('sov').classList.add('show');}
function closeSidebar(){document.getElementById('sidebar').classList.remove('open');document.getElementById('sov').classList.remove('show');}

const THEMES = {
  dark:      { icon:'🌙', label:'Dark' },
  light:     { icon:'☀️', label:'Light' },
  midnight:  { icon:'🔮', label:'Midnight' },
  solarized: { icon:'🌅', label:'Solarized' },
  forest:    { icon:'🌿', label:'Forest' },
  custom:    { icon:'🎨', label:'Своя' },
};

function setTheme(t) {
  if(!THEMES[t]) t = 'dark';
  if(t === 'custom') { _applyCustomThemeVars(); }
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem('sh_theme', t);
  updateThemeIcon(t);
  document.querySelectorAll('.theme-swatch').forEach(el => {
    el.classList.toggle('active', el.dataset.theme === t);
  });
}

function toggleTheme() {
  const keys = Object.keys(THEMES);
  const cur = document.documentElement.getAttribute('data-theme') || 'dark';
  const next = keys[(keys.indexOf(cur) + 1) % keys.length];
  setTheme(next);
}

function updateThemeIcon(t) {
  const icon = THEMES[t]?.icon || '🌙';
  const b1 = document.getElementById('theme-btn');
  const b2 = document.getElementById('theme-btn-top');
  if(b1) b1.textContent = icon;
  if(b2) b2.textContent = icon;
}


// ── CUSTOM THEME ──
function _hexToRgbCt(hex) {
  if(!hex||hex.length<7) return {r:0,g:0,b:0};
  return {r:parseInt(hex.slice(1,3),16),g:parseInt(hex.slice(3,5),16),b:parseInt(hex.slice(5,7),16)};
}
function _isDarkCt(hex) {
  var c=_hexToRgbCt(hex);
  return (c.r*0.299+c.g*0.587+c.b*0.114)<140;
}
function _mixHex(hex,target,amt) {
  var a=_hexToRgbCt(hex),b=_hexToRgbCt(target);
  return '#'+['r','g','b'].map(function(k){return Math.round(a[k]+(b[k]-a[k])*amt).toString(16).padStart(2,'0');}).join('');
}
function _isDark(hex){return _isDarkCt(hex);}
function _lighten(hex,a){return _mixHex(hex,'#ffffff',a);}
function _darken(hex,a){return _mixHex(hex,'#000000',a);}
function _hexToRgb(hex){return _hexToRgbCt(hex);}

function _updateCtPreview() {
  var bg=(document.getElementById('ct-bg')||{value:'#0a0a18'}).value;
  var ac=(document.getElementById('ct-ac')||{value:'#f0c040'}).value;
  var dark=_isDarkCt(bg);
  var bg3=dark?_mixHex(bg,'#ffffff',.09):_mixHex(bg,'#000000',.09);
  var text=dark?'#eeeef5':'#14142a';
  var p=document.getElementById('ct-preview');
  if(!p) return;
  p.style.background=bg3; p.style.color=text;
  var t=document.getElementById('ct-prev-title'); if(t) t.style.color=text;
  var s=document.getElementById('ct-prev-sub'); if(s) s.style.color=text;
  var btn=document.getElementById('ct-prev-btn');
  if(btn){btn.style.background=ac;btn.style.color=_isDarkCt(ac)?'#fff':'#000';}
  var tag=document.getElementById('ct-prev-tag');
  if(tag){tag.style.borderColor=ac+'99';tag.style.color=ac;tag.style.background=ac+'22';}
  var sw=document.getElementById('custom-swatch');
  if(sw) sw.style.background='linear-gradient(135deg,'+bg+','+ac+'66)';
}
function ctColorChange() {
  var bg=document.getElementById('ct-bg').value;
  var ac=document.getElementById('ct-ac').value;
  var bh=document.getElementById('ct-bg-hex'); if(bh) bh.value=bg;
  var ah=document.getElementById('ct-ac-hex'); if(ah) ah.value=ac;
  _updateCtPreview();
}
function ctHexChange(which) {
  var val=document.getElementById('ct-'+which+'-hex').value;
  if(/^#[0-9a-fA-F]{6}$/.test(val)) {
    document.getElementById('ct-'+which).value=val;
    _updateCtPreview();
  }
}
function ctPreset(bg,ac) {
  document.getElementById('ct-bg').value=bg;
  var bh=document.getElementById('ct-bg-hex'); if(bh) bh.value=bg;
  document.getElementById('ct-ac').value=ac;
  var ah=document.getElementById('ct-ac-hex'); if(ah) ah.value=ac;
  _updateCtPreview();
}
function applyCtPreset(bg,ac){ctPreset(bg,ac);}
function openCustomTheme() {
  var bg=localStorage.getItem('sh_ct_bg')||'#0a0a18';
  var ac=localStorage.getItem('sh_ct_ac')||'#f0c040';
  document.getElementById('ct-bg').value=bg;
  var bh=document.getElementById('ct-bg-hex'); if(bh) bh.value=bg;
  document.getElementById('ct-ac').value=ac;
  var ah=document.getElementById('ct-ac-hex'); if(ah) ah.value=ac;
  document.getElementById('modal-custom-theme').style.display='flex';
  _updateCtPreview();
}
function closeCustomTheme() {
  document.getElementById('modal-custom-theme').style.display='none';
}
function saveCustomTheme() {
  var bg=document.getElementById('ct-bg').value;
  var ac=document.getElementById('ct-ac').value;
  localStorage.setItem('sh_ct_bg',bg);
  localStorage.setItem('sh_ct_ac',ac);
  _applyCustomThemeVars(bg,ac);
  setTheme('custom');
  closeCustomTheme();
}
function _applyCustomThemeVars(bg,ac) {
  var storedBg=localStorage.getItem('sh_ct_bg')||'#0a0a18';
  var storedAc=localStorage.getItem('sh_ct_ac')||'#f0c040';
  bg=bg||storedBg; ac=ac||storedAc;
  var dark=_isDarkCt(bg);
  var root=document.documentElement;
  root.style.setProperty('--ct-bg',bg);
  root.style.setProperty('--ct-bg2',dark?_mixHex(bg,'#ffffff',.04):_mixHex(bg,'#000000',.04));
  root.style.setProperty('--ct-bg3',dark?_mixHex(bg,'#ffffff',.09):_mixHex(bg,'#000000',.09));
  root.style.setProperty('--ct-border',dark?_mixHex(bg,'#ffffff',.16):_mixHex(bg,'#000000',.16));
  root.style.setProperty('--ct-card',dark?_mixHex(bg,'#ffffff',.02):_mixHex(bg,'#ffffff',.06));
  root.style.setProperty('--ct-text',dark?'#eeeef5':'#14142a');
  root.style.setProperty('--ct-text2',dark?'#6666a0':'#5858a0');
  root.style.setProperty('--ct-ac',ac);
  root.style.setProperty('--ct-ac2',_mixHex(ac,'#000000',.2));
}
(function(){
  var st2=localStorage.getItem('sh_theme');
  if(st2==='custom') _applyCustomThemeVars();
  var sw=document.getElementById('custom-swatch');
  if(sw){
    var bg=localStorage.getItem('sh_ct_bg')||'#0a0a18';
    var ac=localStorage.getItem('sh_ct_ac')||'#f0c040';
    sw.style.background='linear-gradient(135deg,'+bg+','+ac+'66)';
  }
})();

const st = localStorage.getItem('sh_theme');
if(st) { document.documentElement.setAttribute('data-theme', st); updateThemeIcon(st); }
_applyUiFontScale();
document.addEventListener('DOMContentLoaded', () => {
  const cur = localStorage.getItem('sh_theme') || 'dark';
  document.querySelectorAll('.theme-swatch').forEach(el => el.classList.toggle('active', el.dataset.theme === cur));
});

// ═══ CALENDAR ═══
var calDate = new Date();
var currentYear = calDate.getFullYear();
var currentMonth = calDate.getMonth();
var CAL_DAYS = ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];
var CAL_MONTHS = ['Січень','Лютий','Березень','Квітень','Травень','Червень','Липень','Серпень','Вересень','Жовтень','Листопад','Грудень'];

setInterval(() => {
  const now = new Date();
  if (now.getDate() !== calDate.getDate() || now.getMonth() !== calDate.getMonth()) {
    if (currentYear === calDate.getFullYear() && currentMonth === calDate.getMonth()) {
      calDate = now;
      currentYear = now.getFullYear();
      currentMonth = now.getMonth();
      renderCalendar();
    }
  }
}, 60000);

setInterval(() => { renderCalendar(); }, 5 * 60 * 1000);

function renderCalendar() {
  const year=calDate.getFullYear(), month=calDate.getMonth();
  document.getElementById('cal-title').textContent=CAL_MONTHS[month]+' '+year;
  const firstDay=new Date(year,month,1);
  const lastDay=new Date(year,month+1,0);
  const startDow=(firstDay.getDay()+6)%7;
  const today=new Date(); today.setHours(0,0,0,0);
  const nowTs=Date.now()/1000;
  const dlDeleted=typeof _dlDeleted!=='undefined'?_dlDeleted:[];
  const urgH=typeof _dlUrgentH!=='undefined'?_dlUrgentH:48;
  const warnD=typeof _dlWarnD!=='undefined'?_dlWarnD:7;
  const MAX_VISIBLE=4;

  function cellHtml(dateObj, otherMonth) {
    const d2=new Date(dateObj); d2.setHours(0,0,0,0);
    const isToday=d2.getTime()===today.getTime();
    const dateStr=d2.getFullYear()+'-'+String(d2.getMonth()+1).padStart(2,'0')+'-'+String(d2.getDate()).padStart(2,'0');
    const dayStart=d2.getTime()/1000, dayEnd=dayStart+86400;
    // Використовуємо ефективний due (override або оригінальний)
    const dls=allDl.filter(dl=>{
      if(dlDeleted.includes(String(dl.id))) return false;
      if(dl.submitted==='submitted') return false;
      const eff = (typeof _dlOverrides!=='undefined'&&_dlOverrides[String(dl.id)]&&_dlOverrides[String(dl.id)].due)
        ? _dlOverrides[String(dl.id)].due : dl.due;
      if(!eff) return false;
      return eff>=dayStart&&eff<dayEnd&&eff>=nowTs;
    }).map(dl=>{
      const eff = (typeof _dlOverrides!=='undefined'&&_dlOverrides[String(dl.id)]&&_dlOverrides[String(dl.id)].due)
        ? _dlOverrides[String(dl.id)].due : dl.due;
      return {...dl, due: eff};
    });
    const nts=getCalNotes(dateStr);
    const hasEvents=dls.length>0||nts.length>0;

    const allItems=[];
    nts.forEach(function(un){
      const tpfx=un.time?un.time+' ':'';
      const txt=(tpfx+un.text).length>18?(tpfx+un.text).slice(0,18)+'…':(tpfx+un.text);
      allItems.push({type:'note',html:'<div class="cal-event cal-ev-note" data-date="'+dateStr+'" data-nid="'+escHtml(un.id)+'" onclick="event.stopPropagation();openCalNoteModal(this.dataset.date,event,this.dataset.nid)" title="'+escHtml(un.text)+'">✏️ '+escHtml(txt)+'</div>'});
    });
    dls.forEach(function(dl){
      const diff=dl.due-nowTs;
      const cls=diff<urgH*3600?'cal-ev-urgent':diff<warnD*86400?'cal-ev-soon':'cal-ev-ok';
      const name=dl.name.length>18?dl.name.slice(0,18)+'…':dl.name;
      const urlData=dl.url&&dl.url!=='#'?' data-url="'+escHtml(dl.url)+'"':'';
      allItems.push({type:'dl',html:'<div class="cal-event '+cls+'"'+urlData+' onclick="event.stopPropagation();if(this.dataset.url)window.open(this.dataset.url,\'_blank\')" title="'+escHtml(dl.name)+'">'+escHtml(name)+'</div>'});
    });

    let h='<div class="cal-cell'+(otherMonth?' other-month':'')+(isToday?' today':'')+(hasEvents?' has-events':'')+'" data-date="'+dateStr+'" onclick="openCalDayPopup(this.dataset.date)">';
    h+='<div class="cal-day-num">'+d2.getDate()+'<span class="cal-add-btn" onclick="event.stopPropagation();openCalNoteModal(\''+dateStr+'\',event)" title="Додати нотатку">+</span></div>';
    allItems.slice(0,MAX_VISIBLE).forEach(function(it){ h+=it.html; });
    if(allItems.length>MAX_VISIBLE){
      const hidden=allItems.length-MAX_VISIBLE;
      h+='<div class="cal-more" onclick="event.stopPropagation();openCalDayPopup(\''+dateStr+'\')">+'+hidden+' ще</div>';
    }
    h+='</div>';
    return h;
  }

  let html='<div class="cal-grid">';
  CAL_DAYS.forEach(function(d){html+='<div class="cal-header-cell">'+d+'</div>';});
  for(let i=0;i<startDow;i++) html+=cellHtml(new Date(year,month,i-startDow+1),true);
  for(let d=1;d<=lastDay.getDate();d++) html+=cellHtml(new Date(year,month,d),false);
  const rem=(startDow+lastDay.getDate())%7;
  if(rem>0) for(let i=1;i<=7-rem;i++) html+=cellHtml(new Date(year,month+1,i),true);
  html+='</div>';
  document.getElementById('cal-grid').innerHTML=html;
}

function _closeCalPopup(){
  var p=document.getElementById('cal-popup');
  if(p)p.remove();
  var o=document.querySelector('.cal-popup-overlay');
  if(o)o.remove();
}
function openCalDayPopup(dateStr) {
  _closeCalPopup();
  const nowTs=Date.now()/1000;
  const dlDeleted=typeof _dlDeleted!=='undefined'?_dlDeleted:[];
  const urgH=typeof _dlUrgentH!=='undefined'?_dlUrgentH:48;
  const warnD=typeof _dlWarnD!=='undefined'?_dlWarnD:7;
  const d2=new Date(dateStr); d2.setHours(0,0,0,0);
  const dayStart=d2.getTime()/1000, dayEnd=dayStart+86400;
  const dls=allDl.filter(dl=>{
    if(dlDeleted.includes(String(dl.id))) return false;
    if(dl.submitted==='submitted') return false;
    const eff = (typeof _dlOverrides!=='undefined'&&_dlOverrides[String(dl.id)]&&_dlOverrides[String(dl.id)].due)
      ? _dlOverrides[String(dl.id)].due : dl.due;
    if(!eff) return false;
    return eff>=dayStart&&eff<dayEnd&&eff>=nowTs;
  }).map(dl=>{
    const eff = (typeof _dlOverrides!=='undefined'&&_dlOverrides[String(dl.id)]&&_dlOverrides[String(dl.id)].due)
      ? _dlOverrides[String(dl.id)].due : dl.due;
    return {...dl, due: eff};
  });
  const nts=getCalNotes(dateStr);
  if(!dls.length&&!nts.length) {
    openCalNoteModal(dateStr, {stopPropagation:function(){}});
    return;
  }

  const cell=document.querySelector('[data-date="'+dateStr+'"]');
  const overlay=document.createElement('div');
  overlay.className='cal-popup-overlay';
  overlay.onclick=_closeCalPopup;
  document.body.appendChild(overlay);

  const popup=document.createElement('div');
  popup.className='cal-popup';
  popup.id='cal-popup';

  const DAY_NAMES=['\u041d\u0434','\u041f\u043d','\u0412\u0442','\u0421\u0440','\u0427\u0442','\u041f\u0442','\u0421\u0431'];
  const title=document.createElement('div');
  title.className='cal-popup-title';
  title.innerHTML='<span>'+dateStr.split('-').reverse().slice(0,2).join('.')+'</span>'
    +'<span style="color:var(--text2);font-weight:400">'+DAY_NAMES[d2.getDay()]+'</span>'
    +'<button onclick="_closeCalPopup()" style="margin-left:auto;background:none;border:none;color:var(--text2);cursor:pointer;font-size:14px;padding:0 2px;">✕</button>';
  popup.appendChild(title);

  nts.forEach(function(un){
    const row=document.createElement('div');
    row.className='cal-popup-row cal-popup-note';
    row.innerHTML='<span class="cal-dot cal-dot-note" style="flex-shrink:0"></span>'
      +'<span class="cal-popup-row-text">'+(un.time?'<b>'+un.time+'</b> ':'')+escHtml(un.text)+'</span>'
      +'<button onclick="_closeCalPopup();openCalNoteModal(\''+dateStr+'\',{stopPropagation:function(){}},\''+un.id+'\')" class="cal-popup-edit">\u270f\ufe0f</button>';
    popup.appendChild(row);
  });

  dls.forEach(function(dl){
    const diff=dl.due-nowTs;
    const color=diff<urgH*3600?'var(--accent2)':diff<warnD*86400?'var(--accent)':'var(--success)';
    const time=new Date(dl.due*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
    const row=document.createElement('div');
    row.className='cal-popup-row';
    row.innerHTML='<span class="cal-dot" style="background:'+color+';flex-shrink:0"></span>'
      +'<span class="cal-popup-row-text"><b>'+time+'</b> '+escHtml(dl.name)+'</span>'
      +(dl.url&&dl.url!=='#'?'<button onclick="window.open(\''+escHtml(dl.url)+'\',\'_blank\')" class="cal-popup-edit">\u2197\ufe0f</button>':'');
    popup.appendChild(row);
  });

  const addBtn=document.createElement('div');
  addBtn.className='cal-popup-add';
  addBtn.innerHTML='+ \u0414\u043e\u0434\u0430\u0442\u0438 \u043d\u043e\u0442\u0430\u0442\u043a\u0443';
  addBtn.onclick=function(){_closeCalPopup();openCalNoteModal(dateStr,{stopPropagation:function(){}});};
  popup.appendChild(addBtn);

  document.body.appendChild(popup);

  const rect=cell?cell.getBoundingClientRect():{left:window.innerWidth/2,bottom:window.innerHeight/2};
  popup.style.cssText='position:fixed;z-index:901;';
  document.body.appendChild(popup);
  const pw=popup.offsetWidth, ph=popup.offsetHeight;
  const vw=window.innerWidth, vh=window.innerHeight;
  let left=rect.left, top=(rect.bottom||rect.top)+4;
  if(left+pw>vw-8) left=vw-pw-8;
  if(left<8) left=8;
  if(top+ph>vh-8) top=(rect.top||0)-ph-4;
  if(top<8) top=8;
  popup.style.left=left+'px';
  popup.style.top=top+'px';
}

function calPrev(){
  calDate.setMonth(calDate.getMonth()-1);
  currentYear=calDate.getFullYear(); currentMonth=calDate.getMonth();
  renderCalendar();
}
function calNext(){
  calDate.setMonth(calDate.getMonth()+1);
  currentYear=calDate.getFullYear(); currentMonth=calDate.getMonth();
  renderCalendar();
}
function calToday(){
  calDate=new Date();
  currentYear=calDate.getFullYear(); currentMonth=calDate.getMonth();
  renderCalendar();
}

// ═══ NOTES ═══
var notes=[], currentNoteId=null;

// ✅ IMPROVEMENT 7: notes cache flag — only load from localStorage once unless data changes
var _notesLoaded = false;

function loadNotes(force){
  // Only re-parse localStorage when forced or on first load
  if(!_notesLoaded || force) {
    const raw=localStorage.getItem('sh_notes_'+String(userData.userid||'local'));
    notes=raw?JSON.parse(raw):[];
    _notesLoaded = true;
  }
  renderNotesList(notes);
  renderDashboardEvents();
  renderWidgetNotes();
  const sel=document.getElementById('note-course-sel');
  sel.innerHTML='<option value="">Без курсу</option>';
  courses.forEach(c=>sel.innerHTML+='<option value="'+escHtml(c.id)+'">'+escHtml(c.shortname||c.fullname)+'</option>');
}

function saveNotesToLS(){
  localStorage.setItem('sh_notes_'+String(userData.userid||'local'),JSON.stringify(notes));
  // ✅ Invalidate cache after save so next loadNotes() re-reads
  _notesLoaded = false;
}

function renderNotesList(list){
  const el=document.getElementById('notes-container');
  if(!list.length){el.innerHTML='<div class="empty" style="width:100%"><div class="emo">✍️</div><p>Нотаток ще немає. Створіть першу!</p></div>';return;}
  el.innerHTML=list.map(n=>
    '<div class="note-card" onclick="openNote(this.dataset.id)" data-id="'+escHtml(n.id)+'">'+
    '<button class="btn note-card-del" onclick="event.stopPropagation();deleteNote(this.closest(\'[data-id]\').dataset.id)" style="font-size:10px;padding:3px 6px;">🗑</button>'+
    '<div class="note-card-title">'+escHtml(n.title||'Без назви')+'</div>'+
    '<div class="note-card-preview">'+escHtml((n.content||'').slice(0,200))+'</div>'+
    '<div class="note-card-meta"><span>'+escHtml(n.course||'')+'</span><span>'+new Date(n.updated||n.created).toLocaleDateString('uk-UA')+'</span></div>'+
    '</div>'
  ).join('');
}

function searchNotes(q){
  const lq=(q||'').toLowerCase();
  renderNotesList(lq?notes.filter(n=>(n.title||'').toLowerCase().includes(lq)||(n.content||'').toLowerCase().includes(lq)):notes);
}

function showNewNote(){
  currentNoteId=null;
  document.getElementById('note-title').value='';
  document.getElementById('note-md').value='';
  document.getElementById('note-preview').innerHTML='<p style="color:var(--text2);font-size:12px;">Попередній перегляд...</p>';
  document.getElementById('note-editor-overlay').classList.add('show');
}

function openNote(id){
  const n=notes.find(x=>x.id===id);
  if(!n) return;
  currentNoteId=id;
  document.getElementById('note-title').value=n.title||'';
  document.getElementById('note-md').value=n.content||'';
  document.getElementById('note-course-sel').value=n.courseId||'';
  updateNotePreview();
  document.getElementById('note-editor-overlay').classList.add('show');
}

function closeNoteEditor(){document.getElementById('note-editor-overlay').classList.remove('show');}

function saveNote(){
  const title=document.getElementById('note-title').value.trim()||'Без назви';
  const content=document.getElementById('note-md').value;
  const courseId=document.getElementById('note-course-sel').value;
  const courseSel=document.getElementById('note-course-sel');
  const courseText=courseSel.options[courseSel.selectedIndex]?.text||'';
  if(currentNoteId){
    const n=notes.find(x=>x.id===currentNoteId);
    if(n){n.title=title;n.content=content;n.courseId=courseId;n.course=courseText;n.updated=Date.now();}
  } else {
    notes.unshift({id:Date.now().toString(36)+Math.random().toString(36).slice(2),title,content,courseId,course:courseText,created:Date.now(),updated:Date.now()});
  }
  saveNotesToLS();
  renderNotesList(notes);
  closeNoteEditor();
}

function deleteNote(id){
  if(!confirm('Видалити нотатку?'))return;
  notes=notes.filter(n=>n.id!==id);
  saveNotesToLS();
  renderNotesList(notes);
}

function parseMarkdown(md){
  let s=md.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  s=s.replace(/^### (.+)$/gm,'<h3>$1</h3>');
  s=s.replace(/^## (.+)$/gm,'<h2>$1</h2>');
  s=s.replace(/^# (.+)$/gm,'<h1>$1</h1>');
  s=s.replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
  s=s.replace(/\*(.+?)\*/g,'<em>$1</em>');
  s=s.replace(/`([^`]+)`/g,'<code>$1</code>');
  s=s.replace(/^> (.+)$/gm,'<blockquote>$1</blockquote>');
  s=s.replace(/^- (.+)$/gm,'<li>$1</li>');
  s=s.replace(/\n\n/g,'</p><p>');
  s=s.replace(/^(?!<[hupbl])(.+)$/gm,'<p>$1</p>');
  return s;
}

function updateNotePreview(){
  const md=document.getElementById('note-md').value;
  document.getElementById('note-preview').innerHTML=md?parseMarkdown(md):'<p style="color:var(--text2)">Попередній перегляд...</p>';
}

// ═══ AI ASSISTANT ═══
var aiHistory=[];
var aiImageBase64=null, aiImageMime='image/jpeg';

function setAIImage(base64,mime){
  aiImageBase64=base64; aiImageMime=mime||'image/jpeg';
  document.getElementById('ai-img-thumb').src='data:'+aiImageMime+';base64,'+base64;
  document.getElementById('ai-img-preview').style.display='block';
}
function handleAIImg(inp){
  const file=inp.files[0]; if(!file)return;
  const reader=new FileReader();
  reader.onload=e=>setAIImage(e.target.result.split(',')[1],file.type);
  reader.readAsDataURL(file); inp.value='';
}
function handleAIPaste(e){
  const items=(e.clipboardData||e.originalEvent.clipboardData).items;
  for(const item of items){
    if(item.type.startsWith('image/')){
      e.preventDefault();
      const file=item.getAsFile();
      const reader=new FileReader();
      reader.onload=ev=>setAIImage(ev.target.result.split(',')[1],file.type);
      reader.readAsDataURL(file); break;
    }
  }
}
function clearAIImg(){aiImageBase64=null;document.getElementById('ai-img-preview').style.display='none';}
function aiKey(e){if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendAI();}}

var _AI_PROXY = 'https://groq-proxy.dvdkunec.workers.dev';
function _getAIToken() {
  if(_AI_PROXY) return 'proxy';
  return localStorage.getItem('sh_ai_key') || '';
}
function _getAIEndpoint() {
  return _AI_PROXY || 'https://api.groq.com/openai/v1/chat/completions';
}
async function sendAI(){
  const inp=document.getElementById('ai-inp');
  const text=inp.value.trim();
  const hasImage=!!aiImageBase64;
  if(!text&&!hasImage)return;
  inp.value='';
  appendAIMsg('me',text||'📷 Фото',hasImage?('data:'+aiImageMime+';base64,'+aiImageBase64):null);
  let userContent;
  if(hasImage){
    userContent=[{type:'text',text:text||'Що зображено?'},{type:'image_url',image_url:{url:'data:'+aiImageMime+';base64,'+aiImageBase64}}];
  } else { userContent=text; }
  aiHistory.push({role:'user',content:userContent});
  clearAIImg();
  const thinkingDiv=document.createElement('div');
  thinkingDiv.className='msg other';
  thinkingDiv.innerHTML='<div class="msg-bubble"><div class="ai-thinking"><span></span><span></span><span></span></div></div>';
  document.getElementById('ai-msgs').appendChild(thinkingDiv);
  document.getElementById('ai-msgs').scrollTop=99999;
  document.getElementById('ai-send').disabled=true;
  try {
    const contextParts=[];
    if(typeof courses!=='undefined'&&courses.length) contextParts.push('Курси студента: '+courses.slice(0,10).map(c=>c.fullname||c.shortname).join(', '));
    if(typeof allDl!=='undefined'){
      const upcomingDl=allDl.filter(d=>!d.past).slice(0,5);
      if(upcomingDl.length) contextParts.push('Найближчі дедлайни: '+upcomingDl.map(d=>d.name+' ('+fmtDate(d.due)+')').join(', '));
    }
    const systemPrompt=`Ти навчальний асистент для студентів університету УкрДУЗТ.\nПРАВИЛА:\n- Відповідай ЗАВЖДИ українською мовою\n- Давай ТОЧНІ та ПОВНІ відповіді\n- Якщо на фото задача — розв'яжи ПОВНІСТЮ покроково\n- Використовуй markdown: **жирний**, ## заголовки, - списки, \`код\`\n- При математичних розрахунках показуй кожен крок\n- В кінці ЗАВЖДИ давай чітку фінальну відповідь\n${contextParts.length?'\nКонтекст: '+contextParts.join('. '):''}`;
    const model=hasImage?'meta-llama/llama-4-maverick-17b-128e-instruct':'llama-3.3-70b-versatile';
    const historyForAPI=aiHistory.slice(-12).map((m,i,arr)=>{
      if(i<arr.length-1&&Array.isArray(m.content)){
        const textOnly=m.content.filter(p=>p.type==='text').map(p=>p.text).join(' ');
        return{role:m.role,content:textOnly||'[зображення]'};
      }
      return m;
    });
    const messages=[{role:'system',content:systemPrompt},...historyForAPI];
    let resp=await fetch(_getAIEndpoint(),{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':'Bearer '+_getAIToken()},
      body:JSON.stringify({model,max_tokens:4096,messages})
    });
    let data=await resp.json();
    // If maverick unavailable — fallback to scout
    if(data.error && hasImage){
      resp=await fetch(_getAIEndpoint(),{
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':'Bearer '+_getAIToken()},
        body:JSON.stringify({model:'meta-llama/llama-4-scout-17b-16e-instruct',max_tokens:4096,messages})
      });
      data=await resp.json();
    }
    if(data.error){thinkingDiv.remove();appendAIMsg('other','⚠️ Помилка: '+(data.error.message||JSON.stringify(data.error)));document.getElementById('ai-send').disabled=false;return;}
    const reply=data.choices?.[0]?.message?.content||'Вибачте, не вдалося отримати відповідь.';
    aiHistory.push({role:'assistant',content:reply});
    thinkingDiv.remove();
    _loadKaTeX().then(()=>appendAIMsg('other',reply));
  } catch(e){thinkingDiv.remove();appendAIMsg('other','⚠️ Помилка з\'єднання: '+e.message);}
  document.getElementById('ai-send').disabled=false;
}

function renderMarkdown(text){
  const mathBlocks=[];
  let t=text;
  t=t.replace(/\\\[([\s\S]*?)\\\]/g,(_,m)=>{mathBlocks.push({type:'block',tex:m});return`%%MATH_BLOCK_${mathBlocks.length-1}%%`;});
  t=t.replace(/\$\$([\s\S]*?)\$\$/g,(_,m)=>{mathBlocks.push({type:'block',tex:m});return`%%MATH_BLOCK_${mathBlocks.length-1}%%`;});
  t=t.replace(/\\\(([\s\S]*?)\\\)/g,(_,m)=>{mathBlocks.push({type:'inline',tex:m});return`%%MATH_INLINE_${mathBlocks.length-1}%%`;});
  t=t.replace(/\$([^\$\n]+)\$/g,(_,m)=>{mathBlocks.push({type:'inline',tex:m});return`%%MATH_INLINE_${mathBlocks.length-1}%%`;});
  t=t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  t=t.replace(/```(\w*)\n?([\s\S]*?)```/g,(_,lang,code)=>'<pre style="background:var(--bg);border:1px solid var(--border);border-radius:8px;padding:12px;overflow-x:auto;margin:8px 0;font-family:\'JetBrains Mono\',monospace;font-size:12px;line-height:1.5;">'+(lang?'<div style="font-size:9px;color:var(--accent);margin-bottom:6px;text-transform:uppercase;letter-spacing:1px;">'+lang+'</div>':'')+code+'</pre>');
  t=t.replace(/`([^`\n]+)`/g,'<code style="background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:1px 6px;font-family:\'JetBrains Mono\',monospace;font-size:12px;">$1</code>');
  t=t.replace(/^### (.+)$/gm,'<div style="font-size:14px;font-weight:700;margin:10px 0 4px;color:var(--accent);">$1</div>');
  t=t.replace(/^## (.+)$/gm,'<div style="font-size:16px;font-weight:800;margin:12px 0 5px;border-bottom:1px solid var(--border);padding-bottom:4px;">$1</div>');
  t=t.replace(/^# (.+)$/gm,'<div style="font-size:18px;font-weight:800;margin:14px 0 6px;">$1</div>');
  t=t.replace(/\*\*(.+?)\*\*/g,'<strong style="font-weight:700;">$1</strong>');
  t=t.replace(/\*([^*\n]+)\*/g,'<em>$1</em>');
  t=t.replace(/^---+$/gm,'<hr style="border:none;border-top:1px solid var(--border);margin:10px 0;">');
  t=t.replace(/^[\-\*] (.+)$/gm,'<li style="margin:4px 0;">$1</li>');
  t=t.replace(/^\d+\. (.+)$/gm,'<li style="margin:4px 0;">$1</li>');
  t=t.replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g,m=>'<ul style="margin:8px 0;padding-left:22px;">'+m+'</ul>');
  t=t.replace(/\n\n+/g,'</p><p style="margin:8px 0;">');
  t=t.replace(/\n/g,'<br>');
  t='<p style="margin:0;">'+t+'</p>';
  t=t.replace(/%%MATH_BLOCK_(\d+)%%/g,(_,i)=>{
    try{return'<div style="overflow-x:auto;margin:10px 0;padding:8px 0;text-align:center;">'+window.katex.renderToString(mathBlocks[i].tex,{displayMode:true,throwOnError:false})+'</div>';}
    catch(e){return'<code>'+mathBlocks[i].tex+'</code>';}
  });
  t=t.replace(/%%MATH_INLINE_(\d+)%%/g,(_,i)=>{
    try{return window.katex.renderToString(mathBlocks[i].tex,{displayMode:false,throwOnError:false});}
    catch(e){return'<code>'+mathBlocks[i].tex+'</code>';}
  });
  return t;
}

function appendAIMsg(side,text,imgSrc){
  const el=document.getElementById('ai-msgs');
  const div=document.createElement('div');
  div.className='msg '+side;
  const isAI=side==='other';
  const imgHtml=imgSrc?'<img src="'+imgSrc+'" style="max-width:100%;width:auto;max-height:260px;border-radius:8px;display:block;margin-bottom:8px;border:1px solid var(--border);">':'';
  const content=isAI?renderMarkdown(text):'<p style="margin:0;">'+escHtml(text).replace(/\n/g,'<br>')+'</p>';
  div.innerHTML='<div class="msg-bubble ai-bubble" style="max-width:88%;font-size:14px;line-height:1.65;">'+imgHtml+content+'</div>';
  el.appendChild(div);
  el.scrollTop=99999;
}

// ═══ NOTIFICATIONS ═══
var notifList=[];
function _notifStorageKey(){ return 'sh_notifs_'+String(userData.userid||'local'); }
function _saveNotificationsLocal(){ localStorage.setItem(_notifStorageKey(),JSON.stringify(notifList)); }
async function _saveNotificationsCloud(){
  if(!window._db||!window._fb||!userData.userid) return;
  try{
    const {doc,setDoc}=window._fb;
    await setDoc(doc(window._db,'users',String(userData.userid)),{
      notifications:{items:notifList.slice(0,50),updatedAt:Date.now()}
    },{merge:true});
  }catch(e){}
}
function _initNotificationsSync(){
  if(!window._db||!window._fb||!userData.userid) return;
  const {doc,onSnapshot}=window._fb;
  onSnapshot(doc(window._db,'users',String(userData.userid)),function(snap){
    if(!snap.exists()) return;
    var data=snap.data()||{};
    var items=data.notifications&&Array.isArray(data.notifications.items)?data.notifications.items:null;
    if(!items) return;
    if(JSON.stringify(items)===JSON.stringify(notifList)) return;
    notifList=items;
    _saveNotificationsLocal();
    updateBellCount();
    renderNotifs();
  });
}
function loadNotifications(){
  const raw=localStorage.getItem(_notifStorageKey());
  notifList=raw?JSON.parse(raw):[];
  renderNotifs();
}
function addNotif(type,title,body){
  const n={id:Date.now().toString(36),type,title,body,ts:Date.now(),read:false};
  notifList.unshift(n); notifList=notifList.slice(0,50);
  _saveNotificationsLocal();
  _saveNotificationsCloud();
  updateBellCount(); renderNotifs();
  if(Notification.permission==='granted') new Notification('Student Hub — '+title,{body,icon:'🎓'});
}
function updateBellCount(){
  const unread=notifList.filter(n=>!n.read).length;
  const badge=document.getElementById('bell-count');
  if(!badge)return;
  if(unread>0){badge.textContent=unread;badge.style.display='';}else{badge.style.display='none';}
}
function markAllRead(){
  notifList.forEach(n=>n.read=true);
  _saveNotificationsLocal();
  _saveNotificationsCloud();
  updateBellCount(); renderNotifs();
}
function renderNotifs(){
  const el=document.getElementById('notif-list');
  if(!el)return;
  if(!notifList.length){el.innerHTML='<div class="empty"><div class="emo">🔔</div><p>Немає сповіщень</p></div>';return;}
  el.innerHTML=notifList.map(n=>{
    const ico=n.type==='deadline'?'⏰':n.type==='file'?'📁':n.type==='chat'?'💬':'🔔';
    const t=new Date(n.ts).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'})+' '+new Date(n.ts).toLocaleDateString('uk-UA');
    return'<div class="notif-item'+(n.read?'':' unread')+'" onclick="markNotifRead(this.dataset.id)" data-id="'+escHtml(n.id)+'">'+
      '<div class="notif-ico">'+ico+'</div>'+
      '<div class="notif-body"><div class="notif-title">'+escHtml(n.title)+'</div><div class="notif-time">'+escHtml(n.body)+'<br>'+t+'</div></div>'+
      '</div>';
  }).join('');
}
function markNotifRead(id){
  const n=notifList.find(x=>x.id===id);
  if(n){n.read=true;_saveNotificationsLocal();_saveNotificationsCloud();updateBellCount();renderNotifs();}
}
async function requestNotifPerms(){
  if(!('Notification' in window)){alert('Браузер не підтримує сповіщення');return;}
  const p=await Notification.requestPermission();
  if(p==='granted'){alert('Сповіщення увімкнено! ✅');addNotif('system','Сповіщення увімкнено','Ви будете отримувати нагадування про дедлайни');}
  else{alert('Доступ до сповіщень відхилено');}
}
function scheduleDeadlineNotifs(){
  const now=Date.now()/1000;
  const dlDel=typeof _dlDeleted!=='undefined'?_dlDeleted:[];
  allDl.filter(d=>d.due>now&&!dlDel.includes(String(d.id))).forEach(d=>{
    const diff=d.due-now;
    if(diff>0&&diff<=48*3600){
      const key='notif_sent_'+d.id+'_48';
      if(!localStorage.getItem(key)){
        const hours=Math.round(diff/3600);
        const msg=hours<=1?'Менше години!':'Через '+hours+' год';
        addNotif('deadline','⏰ '+d.name,msg+' — '+d.course);
        localStorage.setItem(key,'1');
        if(Notification.permission==='granted'){try{new Notification('⏰ '+d.name,{body:msg+'\n'+d.course,tag:'dl_'+d.id,requireInteraction:hours<=2});}catch(e){}}
      }
    }
    if(diff>0&&diff<=24*3600){
      const key2='notif_sent_'+d.id+'_24';
      if(!localStorage.getItem(key2)){
        const h2=Math.round(diff/3600);
        addNotif('deadline','🔴 '+d.name,'Залишилось '+h2+'год! — '+d.course);
        localStorage.setItem(key2,'1');
        if(Notification.permission==='granted'){try{new Notification('🔴 Термін! '+d.name,{body:'Залишилось '+h2+' год!',tag:'dl_urgent_'+d.id,requireInteraction:true});}catch(e){}}
      }
    }
  });
}
var prevFileCount=0;
function checkFileNotifs(files){
  if(prevFileCount>0&&files.length>prevFileCount){
    const newFiles=files.slice(0,files.length-prevFileCount);
    newFiles.forEach(f=>addNotif('file','Новий файл у групі',f.name+' — '+(f.uploader||'?')));
  }
  prevFileCount=files.length;
}

// FILES SEARCH/PREVIEW
function renderFilesWithSearch(files,query=''){
  const filtered=query?files.filter(f=>(f.name||'').toLowerCase().includes(query.toLowerCase())):files;
  const el=document.getElementById('files-list');
  if(!filtered.length){el.innerHTML='<div class="empty"><div class="emo">📂</div><p>'+(query?'Файлів не знайдено':'Файлів ще немає')+'</p></div>';return;}
  el.innerHTML='<div class="file-list">'+filtered.map(f=>{
    const ext=(f.name||'').split('.').pop().toLowerCase();
    const ec=ext==='pdf'?'ep':['doc','docx'].includes(ext)?'ed':['xls','xlsx'].includes(ext)?'ex':'eo';
    const sz=f.size>1048576?(f.size/1048576).toFixed(1)+' МБ':Math.round(f.size/1024)+' КБ';
    const isImg=['jpg','jpeg','png','gif','webp'].includes(ext);
    const previewBtn=isImg&&f.dataUrl?'<button class="btn" onclick="previewFile(this.dataset.id)" data-id="'+escHtml(f.id)+'">👁</button>':'';
    return'<div class="file-item">'+
      (isImg&&f.dataUrl?'<img src="'+f.dataUrl+'" style="width:32px;height:32px;object-fit:cover;border-radius:7px;flex-shrink:0;cursor:pointer;" onclick="previewFile(this.dataset.id)" data-id="'+escHtml(f.id)+'">':'<div class="file-ext '+ec+'">'+escHtml(ext.toUpperCase())+'</div>')+
      '<div class="file-info"><div class="file-name">'+escHtml(f.name)+'</div><div class="file-meta">'+escHtml(f.uploader||'?')+' • '+new Date(f.createdAt).toLocaleDateString('uk-UA')+' • '+escHtml(sz)+'</div></div>'+
      '<div class="file-actions">'+previewBtn+(f.dataUrl?'<button class="btn a" onclick="dlFile(this.dataset.id)" data-id="'+escHtml(f.id)+'">⬇</button>':'')+'<button class="btn d" onclick="rmFile(this.dataset.id)" data-id="'+escHtml(f.id)+'">🗑</button></div>'+
      '</div>';
  }).join('')+'</div>';
}

function previewFile(id){
  const f=cachedFiles.find(x=>x.id===id);
  if(!f||!f.dataUrl)return;
  document.getElementById('preview-img').src=f.dataUrl;
  document.getElementById('preview-modal').classList.add('show');
}

var filesSearchQuery='';

// ── LOGOUT ──
function doLogout(){
  unsubs.forEach(u=>u());
  if(chatUnsub)chatUnsub();
  if(_userSettingsUnsub)_userSettingsUnsub();
  if(_presenceInterval)clearInterval(_presenceInterval);
  if(_presenceUnsub)_presenceUnsub();
  if(_pinnedUnsub)_pinnedUnsub();
  unsubs=[];token='';userData={};allDl=[];courses=[];group={};userRole='student';cachedFiles=[];cachedMats=[];
  _notesLoaded = false;
  _dlOverrides = {}; _dlDeleted = []; _calNotes = {};
  // Прибираємо банер при виході
  const banner = document.getElementById('offline-banner');
  if(banner) banner.remove();
  localStorage.removeItem('sh_token');localStorage.removeItem('sh_gid');
  document.getElementById('screen-app').classList.remove('active');
  document.getElementById('screen-login').classList.add('active');
}

// ── AUTO LOGIN ──
const sv=localStorage.getItem('sh_token'),sgid=localStorage.getItem('sh_gid');
if(sv&&sgid){
  token=sv;
  const tryAutoLogin=async()=>{
    if(!window._fb||!window._db){setTimeout(tryAutoLogin,300);return;}
    const {doc,getDoc}=window._fb;
    const cachedGroup=localStorage.getItem('sh_cache_group');
    if(cachedGroup){try{const cg=JSON.parse(cachedGroup);if(cg.id===sgid)group=cg;}catch(e){}}
    try{
      const ctrl=new AbortController();
      const tid=setTimeout(()=>ctrl.abort(),5000);
      const testR=await fetch(MOODLE+'/webservice/rest/server.php?wstoken='+sv+'&wsfunction=core_webservice_get_site_info&moodlewsrestformat=json',{signal:ctrl.signal});
      clearTimeout(tid);
      let testD;
      try { testD = await testR.json(); } catch(e) { testD = {errorcode:'parseerror'}; }
      if(testD && testD.errorcode) {
        // Токен протух — спробуємо тихо оновити його з кешованих кредів
        const creds = localStorage.getItem('sh_creds');
        if(creds) {
          try {
            const decoded = decodeURIComponent(escape(atob(creds)));
            const colonIdx = decoded.indexOf(':');
            const username = decoded.slice(0, colonIdx);
            const password = decoded.slice(colonIdx + 1);
            const rr = await fetch(MOODLE+'/login/token.php', {
              method:'POST',
              headers:{'Content-Type':'application/x-www-form-urlencoded'},
              body: new URLSearchParams({username, password, service:'moodle_mobile_app'})
            });
            const rd = await rr.json();
            if(rd && rd.token) {
              token = rd.token;
              localStorage.setItem('sh_token', token);
              const snap=await getDoc(doc(window._db,'groups',sgid));
              if(snap.exists()){group={id:sgid,...snap.data()};}
              await initApp();
              return;
            }
          } catch(e2) {}
        }
        // Не вдалось оновити — заходимо офлайн якщо є кеш
        if(!cachedGroup){localStorage.removeItem('sh_token');localStorage.removeItem('sh_gid');}
        else{await _offlineLogin(sgid);}
        return;
      }
      const snap=await getDoc(doc(window._db,'groups',sgid));
      if(snap.exists()){group={id:sgid,...snap.data()};await initApp();}
      else if(group.id){await initApp();}
      else{localStorage.removeItem('sh_token');localStorage.removeItem('sh_gid');}
    }catch(e){
      if(group.id||cachedGroup)await _offlineLogin(sgid);
    }
  };
  setTimeout(tryAutoLogin,500);
}

async function _offlineLogin(sgid){
  const cachedGroup=localStorage.getItem('sh_cache_group');
  if(!cachedGroup)return;
  try{
    group=JSON.parse(cachedGroup);
    if(window._fb&&window._db){
      try{const {doc,getDoc}=window._fb;const snap=await getDoc(doc(window._db,'groups',sgid));if(snap.exists())group={id:sgid,...snap.data()};}catch(e){}
    }
    await initApp();
    _showOfflineBanner('Moodle недоступний — показуємо збережені дані');
  }catch(e){}
}

// ═══ GLOBAL SEARCH (Ctrl+K) ═══
(function(){
  function buildIndex() {
    const idx = [];
    (courses||[]).forEach(c=>{
      idx.push({type:'course',icon:'📚',name:c.fullname||c.shortname,sub:c.shortname||'',url:c.viewurl||null,action:()=>{go('courses');setTimeout(()=>{const q=document.getElementById('c-q');if(q){q.value=c.shortname||c.fullname;filterCourses();}},200);}});
    });
    (allDl||[]).forEach(d=>{
      if(d.past) return;
      const due = d.due ? new Date(d.due*1000).toLocaleDateString('uk-UA',{day:'numeric',month:'short'}) : '';
      idx.push({type:'deadline',icon:'⏰',name:d.name,sub:due+(d.course?' · '+d.course:''),url:d.url&&d.url!=='#'?d.url:null,action:()=>{if(d.url&&d.url!=='#')window.open(d.url,'_blank');else go('deadlines');}});
    });
    (notes||[]).forEach(n=>{
      idx.push({type:'note',icon:'✍️',name:n.title||'Без назви',sub:(n.content||'').slice(0,60),url:null,action:()=>{go('notes');setTimeout(()=>openNote(n.id),200);}});
    });
    (cachedFiles||[]).forEach(f=>{
      idx.push({type:'file',icon:'📁',name:f.name,sub:f.uploaderName||'',url:f.url||null,action:()=>{if(f.url)window.open(f.url,'_blank');else go('files');}});
    });
    (cachedMats||[]).forEach(m=>{
      idx.push({type:'material',icon:'📝',name:m.name,sub:m.subject||m.desc||'',url:m.link||null,action:()=>{if(m.link)window.open(m.link,'_blank');else go('materials');}});
    });
    [
      {name:'Головна',icon:'🏠',action:()=>go('dashboard')},
      {name:'Дедлайни',icon:'⏰',action:()=>go('deadlines')},
      {name:'Курси',icon:'📚',action:()=>go('courses')},
      {name:'Календар',icon:'📅',action:()=>go('calendar')},
      {name:'Асистент',icon:'🤖',action:()=>go('assistant')},
      {name:'Файли',icon:'📁',action:()=>go('files')},
      {name:'Матеріали',icon:'📝',action:()=>go('materials')},
      {name:'Нотатки',icon:'✍️',action:()=>go('notes')},
      {name:'Чат',icon:'💬',action:()=>go('chat')},
    ].forEach(p=>idx.push({type:'page',icon:p.icon,name:p.name,sub:'Сторінка',url:null,action:p.action}));
    return idx;
  }

  const TYPE_LABELS = {course:'Курс',deadline:'Дедлайн',note:'Нотатка',file:'Файл',material:'Матеріал',page:'Сторінка'};
  const TYPE_ORDER  = ['page','deadline','course','note','file','material'];

  function openSearch(){
    let ov = document.getElementById('gs-overlay');
    if(!ov){ buildSearchUI(); ov=document.getElementById('gs-overlay'); }
    ov.style.display='flex';
    setTimeout(()=>{ ov.classList.add('gs-show'); document.getElementById('gs-inp').focus(); },10);
    renderResults('');
  }
  function closeSearch(){
    const ov=document.getElementById('gs-overlay');
    if(!ov)return;
    ov.classList.remove('gs-show');
    setTimeout(()=>{ ov.style.display='none'; },200);
  }

  let _gsActive=-1;
  // ✅ Debounced search rendering for global search
  const _debouncedGsRender = debounce(function(val){ renderResults(val); }, 120);

  function renderResults(q){
    const box=document.getElementById('gs-results');
    const idx=buildIndex();
    const term=q.trim().toLowerCase();
    let items = term
      ? idx.filter(it=>(it.name||'').toLowerCase().includes(term)||(it.sub||'').toLowerCase().includes(term))
      : idx.filter(it=>it.type==='page');
    items.sort((a,b)=>TYPE_ORDER.indexOf(a.type)-TYPE_ORDER.indexOf(b.type));
    items=items.slice(0,12);
    _gsActive=-1;
    if(!items.length){
      box.innerHTML='<div style="text-align:center;padding:32px 16px;color:var(--text2);font-size:14px;">Нічого не знайдено 🔍</div>';
      return;
    }
    let html='';
    let lastType='';
    items.forEach((it,i)=>{
      if(it.type!==lastType){
        html+=`<div style="font-size:10px;font-weight:700;color:var(--text2);letter-spacing:.6px;text-transform:uppercase;padding:10px 14px 4px;">${TYPE_LABELS[it.type]||it.type}</div>`;
        lastType=it.type;
      }
      html+=`<div class="gs-item" data-idx="${i}" onclick="_gsSelect(${i})" onmouseover="_gsHover(${i})">
        <span class="gs-ico">${it.icon}</span>
        <div class="gs-text">
          <div class="gs-name">${escHtml(it.name)}</div>
          ${it.sub?`<div class="gs-sub">${escHtml(it.sub)}</div>`:''}
        </div>
        <span class="gs-tag">${TYPE_LABELS[it.type]||''}</span>
      </div>`;
    });
    box.innerHTML=html;
    window._gsItems=items;
  }

  window._gsSelect=function(i){
    const items=window._gsItems||[];
    if(items[i]){items[i].action();closeSearch();}
  };
  window._gsHover=function(i){ _gsActive=i; _gsHighlight(); };

  function _gsHighlight(){
    document.querySelectorAll('.gs-item').forEach((el,i)=>{
      el.classList.toggle('gs-active',i===_gsActive);
    });
  }

  function buildSearchUI(){
    const ov=document.createElement('div');
    ov.id='gs-overlay';
    ov.style.cssText='display:none;position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:9500;align-items:flex-start;justify-content:center;padding:10vh 16px 16px;backdrop-filter:blur(6px);transition:opacity .2s;opacity:0;';
    ov.innerHTML=`
      <div id="gs-box" style="width:100%;max-width:580px;background:var(--card);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,.5);transform:translateY(-12px);transition:transform .2s;">
        <div style="display:flex;align-items:center;gap:10px;padding:14px 16px;border-bottom:1px solid var(--border);">
          <span style="font-size:18px;flex-shrink:0;">🔍</span>
          <input id="gs-inp" placeholder="Пошук по всьому сайту..." autocomplete="off" spellcheck="false"
            style="flex:1;background:none;border:none;outline:none;color:var(--text);font-size:16px;font-family:'Inter',sans-serif;">
          <kbd style="background:var(--bg3);border:1px solid var(--border);border-radius:6px;padding:2px 8px;font-size:11px;color:var(--text2);font-family:'JetBrains Mono',monospace;flex-shrink:0;">ESC</kbd>
        </div>
        <div id="gs-results" style="max-height:420px;overflow-y:auto;padding:4px 0 8px;"></div>
        <div style="padding:8px 14px;border-top:1px solid var(--border);display:flex;gap:12px;align-items:center;">
          <span style="font-size:11px;color:var(--text2);">↑↓ навігація</span>
          <span style="font-size:11px;color:var(--text2);">↵ відкрити</span>
          <span style="font-size:11px;color:var(--text2);margin-left:auto;">Ctrl+K</span>
        </div>
      </div>`;
    ov.addEventListener('click',e=>{if(e.target===ov)closeSearch();});
    // ✅ Use debounced render for search input
    ov.querySelector('#gs-inp').addEventListener('input',e=>_debouncedGsRender(e.target.value));
    ov.querySelector('#gs-inp').addEventListener('keydown',e=>{
      const items=window._gsItems||[];
      if(e.key==='ArrowDown'){e.preventDefault();_gsActive=Math.min(_gsActive+1,items.length-1);_gsHighlight();}
      else if(e.key==='ArrowUp'){e.preventDefault();_gsActive=Math.max(_gsActive-1,0);_gsHighlight();}
      else if(e.key==='Enter'){e.preventDefault();if(_gsActive>=0)_gsSelect(_gsActive);else if(items.length)_gsSelect(0);}
      else if(e.key==='Escape'){closeSearch();}
    });
    document.body.appendChild(ov);
    requestAnimationFrame(()=>{ ov.style.opacity='1'; });
  }

  document.addEventListener('keydown',e=>{
    if((e.ctrlKey||e.metaKey)&&e.key==='k'){e.preventDefault();openSearch();}
  });

  window.openGlobalSearch=openSearch;

  const style=document.createElement('style');
  style.textContent=`
    #gs-overlay.gs-show { opacity:1!important; }
    #gs-overlay.gs-show #gs-box { transform:translateY(0)!important; }
    .gs-item { display:flex;align-items:center;gap:10px;padding:9px 14px;cursor:pointer;border-radius:8px;margin:0 6px;transition:background .1s; }
    .gs-item:hover,.gs-item.gs-active { background:var(--bg3); }
    .gs-ico { font-size:18px;flex-shrink:0;width:26px;text-align:center; }
    .gs-text { flex:1;min-width:0; }
    .gs-name { font-size:14px;font-weight:500;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis; }
    .gs-sub { font-size:11px;color:var(--text2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px; }
    .gs-tag { font-size:10px;color:var(--text2);background:var(--bg3);border:1px solid var(--border);border-radius:4px;padding:2px 6px;flex-shrink:0; }
  `;
  document.head.appendChild(style);
})();

// ── Scroll to pinned message in chat ──
function scrollToPinned() {
  if(!_currentPinnedMsg||!_currentPinnedMsg.msgId) return;
  const el = document.querySelector('[data-lp="'+_currentPinnedMsg.msgId+'"]');
  if(el) { el.scrollIntoView({behavior:'smooth',block:'center'}); el.style.background='rgba(240,192,64,.18)'; setTimeout(()=>el.style.background='',1200); }
}

// ═══ DASHBOARD WIDGETS ═══
function renderDashWidgets() {
  renderDashboardSummary();
  renderDashboardMiniCalendar();
  renderDashboardEvents();
  renderWidgetToday();
  renderWidgetWeek();
  renderWidgetNotes();
  renderWidgetFiles();
}

function renderDashboardSummary() {
  if(!_grLoaded) _grLocalLoad();
  var urgentHome = document.getElementById('s-urgent-home');
  if(urgentHome) {
    var urgentSrc = document.getElementById('s-urgent');
    urgentHome.textContent = urgentSrc ? urgentSrc.textContent : '—';
  }
  var gradeCount = document.getElementById('dash-grade-count');
  if(gradeCount) gradeCount.textContent = Array.isArray(_grSubjects) ? _grSubjects.length : '—';
  var matsCount = document.getElementById('dash-mats-count');
  if(matsCount) matsCount.textContent = Array.isArray(cachedMats) ? cachedMats.length : '—';
  var chatCount = document.getElementById('dash-chat-count');
  if(chatCount) {
    var roomCount = 3 + (Array.isArray(_chatDmRooms) ? _chatDmRooms.length : 0);
    chatCount.textContent = roomCount;
  }
}

function renderDashboardMiniCalendar() {
  var el = document.getElementById('dash-mini-cal');
  if(!el) return;
  var base = new Date();
  var year = base.getFullYear(), month = base.getMonth();
  var firstDay = new Date(year, month, 1);
  var lastDay = new Date(year, month + 1, 0);
  var startDow = (firstDay.getDay() + 6) % 7;
  var today = new Date(); today.setHours(0,0,0,0);
  var dlDeleted = typeof _dlDeleted !== 'undefined' ? _dlDeleted : [];
  var weekdays = ['Пн','Вт','Ср','Чт','Пт','Сб','Нд'];
  var html = '<div class="dash-mini-head"><div class="dash-mini-title">' + firstDay.toLocaleDateString('uk-UA',{month:'long',year:'numeric'}) + '</div></div><div class="dash-mini-grid">';
  weekdays.forEach(function(d){ html += '<div class="dash-mini-weekday">' + d + '</div>'; });
  function dotsForDate(dateObj) {
    var d2 = new Date(dateObj); d2.setHours(0,0,0,0);
    var dayStart = d2.getTime() / 1000, dayEnd = dayStart + 86400;
    var dueCount = allDl.filter(function(dl){
      if(dlDeleted.includes(String(dl.id)) || dl.submitted === 'submitted') return false;
      var eff = (typeof getEffectiveDue === 'function') ? getEffectiveDue(dl) : dl.due;
      return eff && eff >= dayStart && eff < dayEnd;
    }).length;
    var noteCount = getCalNotes(d2.getFullYear() + '-' + String(d2.getMonth()+1).padStart(2,'0') + '-' + String(d2.getDate()).padStart(2,'0')).length;
    var dots = '';
    if(dueCount) dots += '<span class="dash-mini-dot" style="background:var(--accent)"></span>';
    if(noteCount) dots += '<span class="dash-mini-dot" style="background:var(--success)"></span>';
    return dots;
  }
  for(var i=0;i<startDow;i++) {
    var prevDate = new Date(year, month, i - startDow + 1);
    html += '<div class="dash-mini-day other"><div class="dash-mini-num">' + prevDate.getDate() + '</div><div class="dash-mini-dots">' + dotsForDate(prevDate) + '</div></div>';
  }
  for(var d=1; d<=lastDay.getDate(); d++) {
    var current = new Date(year, month, d); current.setHours(0,0,0,0);
    var cls = current.getTime() === today.getTime() ? ' today' : '';
    html += '<div class="dash-mini-day' + cls + '"><div class="dash-mini-num">' + d + '</div><div class="dash-mini-dots">' + dotsForDate(current) + '</div></div>';
  }
  var rem = (startDow + lastDay.getDate()) % 7;
  if(rem > 0) {
    for(var n=1; n<=7-rem; n++) {
      var nextDate = new Date(year, month + 1, n);
      html += '<div class="dash-mini-day other"><div class="dash-mini-num">' + nextDate.getDate() + '</div><div class="dash-mini-dots">' + dotsForDate(nextDate) + '</div></div>';
    }
  }
  html += '</div>';
  el.innerHTML = html;
}

function renderDashboardEvents() {
  var el = document.getElementById('dash-events');
  if(!el) return;
  var items = [];
  (cachedMats || []).slice().sort(function(a,b){ return (b.createdAt||0) - (a.createdAt||0); }).slice(0,2).forEach(function(m){
    items.push({ icon:'📝', title:m.title || m.name || 'Матеріал', sub:'Матеріали', time:m.createdAt || 0 });
  });
  (notes || []).slice().sort(function(a,b){ return (b.updatedAt||b.createdAt||0) - (a.updatedAt||a.createdAt||0); }).slice(0,2).forEach(function(n){
    items.push({ icon:'✏️', title:n.title || 'Нотатка', sub:'Нотатки', time:n.updatedAt || n.createdAt || 0 });
  });
  (cachedFiles || []).slice().sort(function(a,b){ return (b.createdAt||0) - (a.createdAt||0); }).slice(0,2).forEach(function(f){
    items.push({ icon:'📁', title:f.name || 'Файл', sub:'Файли', time:f.createdAt || 0 });
  });
  items.sort(function(a,b){ return (b.time||0) - (a.time||0); });
  if(!items.length) {
    el.innerHTML = '<div class="empty"><div class="emo">✨</div><p>Поки що без нових подій</p></div>';
    return;
  }
  el.innerHTML = '<div class="dash-events-list">' + items.slice(0,5).map(function(item){
    var stamp = item.time ? new Date(item.time).toLocaleDateString('uk-UA',{day:'numeric',month:'short'}) : 'зараз';
    return '<div class="dash-event-item"><div class="dash-event-icon">' + item.icon + '</div><div class="dash-event-copy"><div class="dash-event-title">' + escHtml(item.title) + '</div><div class="dash-event-sub"><span>' + escHtml(item.sub) + '</span><span>•</span><span>' + escHtml(stamp) + '</span></div></div></div>';
  }).join('') + '</div>';
}

function renderWidgetToday() {
  var el=document.getElementById('w-today'); if(!el) return;
  var now=Date.now()/1000;
  var todayStart=new Date(); todayStart.setHours(0,0,0,0);
  var todayEnd=new Date(); todayEnd.setHours(23,59,59,999);
  var dlDel=typeof _dlDeleted!=='undefined'?_dlDeleted:[];
  var urgH=typeof _dlUrgentH!=='undefined'?_dlUrgentH:48;
  var items=allDl.filter(function(d){
    if(dlDel.includes(String(d.id))) return false;
    var eff=(typeof _dlOverrides!=='undefined'&&_dlOverrides[String(d.id)]&&_dlOverrides[String(d.id)].due)?_dlOverrides[String(d.id)].due:d.due;
    if(!eff) return false;
    return eff>=now&&eff>=todayStart.getTime()/1000&&eff<=todayEnd.getTime()/1000;
  }).map(function(d){
    var eff=(typeof _dlOverrides!=='undefined'&&_dlOverrides[String(d.id)]&&_dlOverrides[String(d.id)].due)?_dlOverrides[String(d.id)].due:d.due;
    return {...d,due:eff};
  });
  if(!items.length){el.innerHTML='<div class="widget-empty">🎉 Сьогодні дедлайнів немає</div>';return;}
  el.innerHTML=items.slice(0,4).map(function(d){
    var t=new Date(d.due*1000).toLocaleTimeString('uk-UA',{hour:'2-digit',minute:'2-digit'});
    var diff=d.due-now;
    var color=diff<urgH*3600?'var(--accent2)':'var(--warning)';
    var onclick=d.url&&d.url!=='#'?"window.open('"+escHtml(d.url)+"','_blank')":"go('deadlines')";
    return '<div class="widget-item" onclick="'+onclick+'" title="'+escHtml(d.name)+'"><span class="widget-item-dot" style="background:'+color+'"></span><span class="widget-item-name">'+escHtml(d.name)+'</span><span class="widget-item-meta">'+t+'</span></div>';
  }).join('');
}
function renderWidgetWeek() {
  var el=document.getElementById('w-week'); if(!el) return;
  var now=Date.now()/1000;
  var tomorrowStart=new Date(); tomorrowStart.setHours(0,0,0,0); tomorrowStart.setDate(tomorrowStart.getDate()+1);
  var weekEnd=tomorrowStart.getTime()/1000+6*86400;
  var dlDel=typeof _dlDeleted!=='undefined'?_dlDeleted:[];
  var urgH=typeof _dlUrgentH!=='undefined'?_dlUrgentH:48;
  var warnD=typeof _dlWarnD!=='undefined'?_dlWarnD:7;
  var items=allDl.filter(function(d){
    if(dlDel.includes(String(d.id))) return false;
    var eff=(typeof _dlOverrides!=='undefined'&&_dlOverrides[String(d.id)]&&_dlOverrides[String(d.id)].due)?_dlOverrides[String(d.id)].due:d.due;
    if(!eff) return false;
    return eff>=tomorrowStart.getTime()/1000&&eff<=weekEnd;
  }).map(function(d){
    var eff=(typeof _dlOverrides!=='undefined'&&_dlOverrides[String(d.id)]&&_dlOverrides[String(d.id)].due)?_dlOverrides[String(d.id)].due:d.due;
    return {...d,due:eff};
  }).slice(0,4);
  if(!items.length){el.innerHTML='<div class="widget-empty">📭 Дедлайнів на тижні немає</div>';return;}
  el.innerHTML=items.map(function(d){
    var diff=d.due-now;
    var color=diff<urgH*3600?'var(--accent2)':diff<warnD*86400?'var(--accent)':'var(--success)';
    var label=diff<172800?'Завтра':new Date(d.due*1000).toLocaleDateString('uk-UA',{day:'numeric',month:'short'});
    var onclick=d.url&&d.url!=='#'?"window.open('"+escHtml(d.url)+"','_blank')":"go('deadlines')";
    return '<div class="widget-item" onclick="'+onclick+'" title="'+escHtml(d.name)+'"><span class="widget-item-dot" style="background:'+color+'"></span><span class="widget-item-name">'+escHtml(d.name)+'</span><span class="widget-item-meta">'+label+'</span></div>';
  }).join('');
}
function renderWidgetNotes() {
  const el = document.getElementById('w-notes');
  if(!el) return;
  const recent = (notes||[]).slice().sort((a,b)=>(b.updatedAt||b.createdAt||0)-(a.updatedAt||a.createdAt||0)).slice(0,4);
  if(!recent.length) { el.innerHTML='<div class="widget-empty">✍️ Нотаток ще немає</div>'; return; }
  el.innerHTML = recent.map(n => {
    const d = new Date(n.updatedAt||n.createdAt||0).toLocaleDateString('uk-UA',{day:'numeric',month:'short'});
    return `<div class="widget-item" onclick="go('notes');setTimeout(()=>openNote('${escHtml(n.id)}'),250)" title="${escHtml(n.title||'Без назви')}">
      <span class="widget-item-dot" style="background:var(--accent)"></span>
      <span class="widget-item-name">${escHtml(n.title||'Без назви')}</span>
      <span class="widget-item-meta">${d}</span>
    </div>`;
  }).join('');
}

function renderWidgetFiles() {
  const el = document.getElementById('w-files');
  if(!el) return;
  const recent = (cachedFiles||[]).slice().sort((a,b)=>(b.createdAt||0)-(a.createdAt||0)).slice(0,4);
  if(!recent.length) { el.innerHTML='<div class="widget-empty">📁 Файлів ще немає</div>'; return; }
  el.innerHTML = recent.map(f => {
    const ext = (f.name||'').split('.').pop().toUpperCase().slice(0,4);
    const extColors = {PDF:'#e05050',DOC:'#4080e0',XLS:'#38d07a',PPT:'#f0a030',ZIP:'#a070e0',PNG:'#60c0f0',JPG:'#60c0f0',MP4:'#f06060'};
    const color = extColors[ext] || 'var(--text2)';
    return `<div class="widget-item" onclick="go('files')" title="${escHtml(f.name)}">
      <span class="widget-item-dot" style="background:${color}"></span>
      <span class="widget-item-name">${escHtml(f.name)}</span>
      <span class="widget-item-meta" style="color:${color};font-weight:700;">${ext}</span>
    </div>`;
  }).join('');
}

// ═══ EXPORT ═══
function exportJSON() {
  const data = {
    exportedAt: new Date().toISOString(),
    user: { name: userData.fullname, group: group.name },
    deadlines: allDl.map(d => ({
      name: d.name, course: d.course,
      due: d.due ? new Date(d.due*1000).toISOString() : null,
      url: d.url
    })),
    notes: (notes||[]).map(n => ({
      title: n.title, content: n.content,
      course: n.course,
      createdAt: n.createdAt ? new Date(n.createdAt).toISOString() : null,
      updatedAt: n.updatedAt ? new Date(n.updatedAt).toISOString() : null
    })),
    files: (cachedFiles||[]).map(f => ({
      name: f.name, size: f.size,
      uploader: f.uploader || f.uploaderName,
      createdAt: f.createdAt ? new Date(f.createdAt).toISOString() : null
    })),
    materials: (cachedMats||[]).map(m => ({
      name: m.name, subject: m.subject, link: m.link || m.desc
    })),
    courses: (courses||[]).map(c => ({
      name: c.fullname || c.shortname,
      url: c.viewurl
    }))
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], {type:'application/json'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'studenthub-export-' + new Date().toISOString().slice(0,10) + '.json';
  a.click(); URL.revokeObjectURL(url);
}

function exportNotesMD() {
  if(!(notes||[]).length) { alert('Нотаток ще немає'); return; }
  const sorted = [...notes].sort((a,b)=>(b.updatedAt||0)-(a.updatedAt||0));
  const md = sorted.map(n => {
    const date = n.updatedAt ? new Date(n.updatedAt).toLocaleDateString('uk-UA') : '';
    return `# ${n.title||'Без назви'}\n_${n.course||''}${n.course&&date?' · ':''}${date}_\n\n${n.content||''}\n\n---\n`;
  }).join('\n');
  const header = `# StudentHub — Нотатки\n_Експорт: ${new Date().toLocaleDateString('uk-UA')} · ${userData.fullname||''}_\n\n---\n\n`;
  const blob = new Blob([header + md], {type:'text/markdown;charset=utf-8'});
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'notes-' + new Date().toISOString().slice(0,10) + '.md';
  a.click(); URL.revokeObjectURL(url);
}

// ══════════════════════════════════════════════
// ── DEADLINE OVERRIDES (ручні дедлайни з Moodle)
// ══════════════════════════════════════════════
// _dlOverrides: { [dlId]: { due: unixTimestamp } }
// Зберігається разом з userSettings у Firebase

var _dlOverrides = {};
var _dlEditCurrentId = null;

// Завантаження overrides вбудовано в startUserSettingsSync —
// просто розширюємо існуючий механізм читання/запису.

// Патч startUserSettingsSync щоб читати overrides
var _origStartUserSettingsSync = startUserSettingsSync;
startUserSettingsSync = function() {
  return new Promise(resolve => {
    if(!window._db || !userData.userid) { resolve(); return; }
    const { onSnapshot } = window._fb;
    if(_userSettingsUnsub) _userSettingsUnsub();
    let firstLoad = true;
    _userSettingsUnsub = onSnapshot(_userSettingsDoc(), snap => {
      const data = snap.exists() ? snap.data() : {};
      _dlUrgentH = data.dlUrgentH ?? 48;
      _dlWarnD   = data.dlWarnD   ?? 7;
      _dlDeleted = Array.isArray(data.dlDeleted) ? data.dlDeleted : [];
      _calNotes  = (data.calNotes && typeof data.calNotes==='object') ? data.calNotes : {};
      _dlOverrides = (data.dlOverrides && typeof data.dlOverrides==='object') ? data.dlOverrides : {};
      _settingsLoaded = true;
      const uh = document.getElementById('dl-urgent-hours');
      const wd = document.getElementById('dl-warn-days');
      if(uh) uh.value = _dlUrgentH;
      if(wd) wd.value = _dlWarnD;
      if(allDl.length > 0) {
        scheduleRender();
        _renderCalNotesInDeadlines();
      }
      if(firstLoad) { firstLoad = false; resolve(); }
    }, err => { console.warn('userSettings sync error:', err.code); resolve(); });
  });
};

// Патч _saveUserSettings щоб включати overrides
var _origSaveUserSettings = _saveUserSettings;
_saveUserSettings = async function() {
  if(!window._db || !userData.userid) return;
  clearTimeout(_saveSettingsTimer);
  _saveSettingsTimer = setTimeout(async () => {
    const payload = {
      dlUrgentH: _dlUrgentH, dlWarnD: _dlWarnD,
      dlDeleted: _dlDeleted, calNotes: _calNotes,
      dlOverrides: _dlOverrides
    };
    // Завжди зберігаємо в localStorage — щоб при наступному завантаженні
    // перший рендер вже мав актуальні overrides (до відповіді Firebase)
    try { localStorage.setItem('ush_'+userData.userid, JSON.stringify(payload)); } catch(e2) {}
    // І в Firebase
    const { setDoc } = window._fb;
    try {
      await setDoc(_userSettingsDoc(), {
        ...payload,
        updatedAt: Date.now(), userId: String(userData.userid)
      });
    } catch(e) {}
  }, 800);
};

// Повертає реальний due для дедлайну (override або оригінал)
function getEffectiveDue(d) {
  const ov = _dlOverrides[String(d.id)];
  if(ov && ov.due) return ov.due;
  return d.due;
}

// ── Патч renderDl щоб показувати кнопку ✏️ і override-badge ──
var _origRenderDl = renderDl;
renderDl = function(list, el) {
  if(!list.length){el.innerHTML='<div class="empty"><div class="emo">🎉</div><p>Дедлайнів не знайдено</p></div>';return;}
  const now = Date.now()/1000;
  el.innerHTML='<div class="dl-list">'+list.map(d=>{
    const sid = String(d.id);
    const ov = _dlOverrides[sid];
    const effectiveDue = ov && ov.due ? ov.due : d.due;
    // Бессрочне: effectiveDue = 0 або відсутній — НЕ вважається минулим
    const isNoDl = !effectiveDue || effectiveDue === 0;
    const isPast = !isNoDl && effectiveDue <= now;
    const diff = isNoDl ? Infinity : (effectiveDue - now);

    // Колір крапки
    let dotClass;
    if(isNoDl) dotClass = 'dot-o'; // сіро-зелений для бессрочних
    else if(isPast) dotClass = 'dot-u';
    else if(diff < _dlUrgentH*3600) dotClass = 'dot-u';
    else if(diff < _dlWarnD*86400) dotClass = 'dot-s';
    else dotClass = 'dot-o';

    // Клас дати
    let dateCls = '';
    if(!isNoDl && isPast) dateCls = 'u';
    else if(!isNoDl && diff < _dlUrgentH*3600) dateCls = 'u';
    else if(!isNoDl && diff < _dlWarnD*86400) dateCls = 's';

    const hasUrl = d.url && d.url !== '#';
    let tag = '';
    if(d.submitted==='submitted') tag='<span class="tag g">✅ Здано</span>';
    else if(d.submitted==='draft') tag='<span class="tag y">📝 Чернетка</span>';
    else if(isNoDl) tag='<span class="tag" style="background:var(--bg3);color:var(--text2);">∞ Безстроково</span>';
    else if(isPast) tag='<span class="tag r">Минув</span>';
    else if(diff < _dlUrgentH*3600) tag='<span class="tag r">🔴 Термін!</span>';
    else if(diff < 86400*2) {
      const dueD=new Date(effectiveDue*1000); const todD=new Date();
      const isTomorrow=dueD.getDate()===todD.getDate()+1&&dueD.getMonth()===todD.getMonth()&&dueD.getFullYear()===todD.getFullYear();
      if(isTomorrow) tag='<span class="tag y">Завтра</span>';
    }

    // Override-badge
    const ovBadge = ov && ov.due
      ? '<span title="Дедлайн встановлено вручну" style="font-size:9px;background:rgba(240,192,64,.18);color:var(--accent);border:1px solid rgba(240,192,64,.35);border-radius:4px;padding:1px 5px;margin-left:4px;vertical-align:middle;">✏️ свій</span>'
      : '';

    const dateDisplay = ov && ov.due
      ? fmtDate(ov.due)
      : (d.due ? fmtDate(d.due) : '<span style="color:var(--text2);font-style:italic;font-size:11px;">без дедлайну</span>');

    return '<div class="dl-item'+(hasUrl?' click':'')+'"'+
      (hasUrl?' onclick="window.open(this.dataset.url)" data-url="'+escHtml(d.url)+'"':'')+(isPast?' style="opacity:.6"':'')+'>'+
      '<div class="dl-dot '+dotClass+'"></div>'+
      '<div class="dl-info"><div class="dl-name">'+escHtml(d.name)+ovBadge+(hasUrl?' <span style="opacity:.35;font-size:9px">↗</span>':'')+'</div>'+
      '<div class="dl-course">'+escHtml(d.course)+'</div></div>'+
      '<div class="dl-right">'+
        '<div class="dl-date '+dateCls+'">'+dateDisplay+'</div>'+
        tag+
        '<div style="display:flex;gap:3px;margin-top:3px;justify-content:flex-end;">'+
          '<button onclick="event.stopPropagation();openDlEditModal(this.dataset.dlid)" data-dlid="'+escHtml(sid)+'" title="Встановити/змінити дедлайн" style="background:none;border:none;color:var(--accent);font-size:13px;cursor:pointer;opacity:.55;padding:2px 4px;border-radius:4px;transition:opacity .15s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.55">✏️</button>'+
          '<button onclick="event.stopPropagation();deleteDl(this.dataset.dlid,event)" data-dlid="'+escHtml(sid)+'" title="Приховати" style="background:none;border:none;color:var(--text2);font-size:12px;cursor:pointer;opacity:.4;padding:2px 4px;border-radius:4px;transition:opacity .15s;" onmouseover="this.style.opacity=1" onmouseout="this.style.opacity=.4">✕</button>'+
        '</div>'+
      '</div></div>';
  }).join('')+'</div>';
};

// ── applyDlFilter — враховуємо overrides при фільтрації ──
var _origApplyDlFilter = applyDlFilter;
applyDlFilter = function() {
  const q=(document.getElementById('dl-q')||{value:''}).value.toLowerCase();
  const f=(document.getElementById('dl-f')||{value:'active'}).value;
  const now = Date.now()/1000;

  let list = allDl.filter(d => !_dlDeleted.includes(String(d.id)));
  list = list.filter(d => !q || d.name.toLowerCase().includes(q) || d.course.toLowerCase().includes(q));

  // Для фільтрації використовуємо ефективний due (з override або оригінальний)
  if(f==='active') {
    list = list.filter(d => {
      if(d.submitted === 'submitted') return false;
      // Безстрокові — тільки якщо є override з датою в майбутньому
      if(d._noDeadline) {
        const ov = _dlOverrides[String(d.id)];
        return ov && ov.due && ov.due > now;
      }
      // Звичайні — якщо ефективний дедлайн в майбутньому
      const eff = getEffectiveDue(d);
      return eff && eff > now;
    });
  } else if(f==='urgent') {
    list = list.filter(d => {
      const eff = getEffectiveDue(d);
      return eff > now && (eff - now) < _dlUrgentH*3600;
    });
  } else if(f==='past') {
    list = list.filter(d => {
      const eff = getEffectiveDue(d);
      return eff && eff <= now;
    });
  }

  // Замінюємо due на ефективний для рендерингу
  list = list.map(d => {
    const ov = _dlOverrides[String(d.id)];
    const eff = (ov && ov.due) ? ov.due : d.due;
    return { ...d, due: eff || d.due, past: eff ? eff <= now : false, _origDue: d.due };
  });

  renderDl(list, document.getElementById('dl-list'));
  _renderCalNotesInDeadlines();
};

// ── Модальне вікно редагування дедлайну ──
function openDlEditModal(dlId) {
  const d = allDl.find(x => String(x.id) === String(dlId));
  if(!d) return;
  _dlEditCurrentId = String(dlId);

  document.getElementById('dl-edit-name').textContent = d.name + (d.course ? ' · ' + d.course : '');

  const ov = _dlOverrides[_dlEditCurrentId];

  // Якщо є override — показуємо його значення
  const ts = (ov && ov.due) ? ov.due : null;
  if(ts) {
    const dt = new Date(ts * 1000);
    document.getElementById('dl-edit-date').value = dt.toISOString().slice(0,10);
    const hh = String(dt.getHours()).padStart(2,'0');
    const mm = String(dt.getMinutes()).padStart(2,'0');
    document.getElementById('dl-edit-time').value = hh + ':' + mm;
  } else if(d.due) {
    const dt = new Date(d.due * 1000);
    document.getElementById('dl-edit-date').value = dt.toISOString().slice(0,10);
    const hh = String(dt.getHours()).padStart(2,'0');
    const mm = String(dt.getMinutes()).padStart(2,'0');
    document.getElementById('dl-edit-time').value = hh + ':' + mm;
  } else {
    // Бессрочне — пропонуємо сьогодні
    const today = new Date();
    document.getElementById('dl-edit-date').value = today.toISOString().slice(0,10);
    document.getElementById('dl-edit-time').value = '23:59';
  }

  // Показуємо оригінальний дедлайн якщо він є
  const origEl = document.getElementById('dl-edit-original');
  const origVal = document.getElementById('dl-edit-orig-val');
  if(d.due) {
    origEl.style.display = 'block';
    origVal.textContent = fmtDate(d.due);
  } else {
    origEl.style.display = 'none';
  }

  // Показуємо кнопку "Скинути" тільки якщо є override
  document.getElementById('dl-edit-reset-btn').style.display = (ov && ov.due) ? '' : 'none';

  const modal = document.getElementById('modal-dl-edit');
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('dl-edit-date').focus(), 80);
}

function closeDlEditModal() {
  document.getElementById('modal-dl-edit').style.display = 'none';
  _dlEditCurrentId = null;
}

function saveDlOverride() {
  if(!_dlEditCurrentId) return;
  const dateVal = document.getElementById('dl-edit-date').value;
  const timeVal = document.getElementById('dl-edit-time').value || '23:59';
  if(!dateVal) { alert('Оберіть дату'); return; }
  const dt = new Date(dateVal + 'T' + timeVal + ':00');
  if(isNaN(dt.getTime())) { alert('Невірна дата'); return; }
  const ts = Math.floor(dt.getTime() / 1000);
  _dlOverrides[_dlEditCurrentId] = { due: ts };
  closeDlEditModal();
  scheduleRender();
  _saveUserSettings();
}

function resetDlOverride() {
  if(!_dlEditCurrentId) return;
  delete _dlOverrides[_dlEditCurrentId];
  closeDlEditModal();
  scheduleRender();
  _saveUserSettings();
}

// Закрити по кліку на фон
document.getElementById('modal-dl-edit').addEventListener('click', function(e) {
  if(e.target === this) closeDlEditModal();
});
document.addEventListener('keydown', e => {
  if(e.key === 'Escape' && document.getElementById('modal-dl-edit').style.display !== 'none') closeDlEditModal();
});

// ── Бессрочні завдання з Moodle ──
// Зберігаємо завдання без дедлайну (due=0) в allDl окремим масивом
var _noDlItems = [];

// Патч loadDeadlines щоб включати завдання без дедлайну
var _origLoadDeadlines = loadDeadlines;
loadDeadlines = async function() {
  // Спочатку запускаємо оригінальний loadDeadlines
  await _origLoadDeadlines.call(this);
  // Потім підтягуємо бессрочні окремим запитом
  await _loadNoDlAssignments();
};

async function _loadNoDlAssignments() {
  if(!token || !courses.length) return;
  try {
    const chunkSize = 20;
    const chunks = [];
    for(let i=0; i<courses.length; i+=chunkSize) chunks.push(courses.slice(i,i+chunkSize));

    const [assignResults, quizResults] = await Promise.all([
      Promise.all(chunks.map(chunk => {
        const courseids = chunk.map((c,i)=>`courseids[${i}]=${c.id}`).join('&');
        return fetch(MOODLE+'/webservice/rest/server.php?wstoken='+token+'&wsfunction=mod_assign_get_assignments&moodlewsrestformat=json&'+courseids)
          .then(r => _parseMoodleResponse(r)).catch(()=>null);
      })),
      Promise.all(chunks.map(chunk => {
        const courseids = chunk.map((c,i)=>`courseids[${i}]=${c.id}`).join('&');
        return fetch(MOODLE+'/webservice/rest/server.php?wstoken='+token+'&wsfunction=mod_quiz_get_quizzes_by_courses&moodlewsrestformat=json&'+courseids)
          .then(r => _parseMoodleResponse(r)).catch(()=>null);
      }))
    ]);

    const existingIds = new Set(allDl.map(d => String(d.id)));
    const noDl = [];

    assignResults.forEach(d => {
      if(!d || !d.courses) return;
      d.courses.forEach(course => {
        (course.assignments||[]).forEach(a => {
          if((a.duedate || 0) === 0) {
            const sid = 'nodl_' + a.id;
            if(!existingIds.has(sid)) {
              noDl.push({
                id: sid, _origAssignId: a.id,
                name: a.name || 'Завдання',
                _normName: (a.name||'').toLowerCase().trim(),
                course: course.fullname || course.shortname || '—',
                due: 0, past: false,
                url: 'https://do.kart.edu.ua/mod/assign/view.php?id=' + a.cmid,
                assignid: a.id, submitted: null, _noDeadline: true, _type: 'assign'
              });
            }
          }
        });
      });
    });

    quizResults.forEach(d => {
      if(!d || !d.quizzes) return;
      d.quizzes.forEach(q => {
        if((q.timeclose || 0) === 0) {
          const sid = 'nodl_quiz_' + q.id;
          if(!existingIds.has(sid)) {
            const courseObj = courses.find(c => c.id === q.course);
            const courseName = courseObj ? (courseObj.fullname || courseObj.shortname) : '—';
            noDl.push({
              id: sid, name: q.name || 'Тест',
              _normName: (q.name||'').toLowerCase().trim(),
              course: courseName, due: 0, past: false,
              url: 'https://do.kart.edu.ua/mod/quiz/view.php?id=' + q.coursemodule,
              submitted: null, _noDeadline: true, _type: 'quiz'
            });
          }
        }
      });
    });

    _noDlItems = noDl;
    const existingIds2 = new Set(allDl.map(d => String(d.id)));
    noDl.forEach(item => {
      if(!existingIds2.has(String(item.id))) { allDl.push(item); existingIds2.add(String(item.id)); }
    });
    scheduleRender();
  } catch(e) { console.warn('_loadNoDlAssignments error:', e); }
}

// ── Модальне вікно перегляду бессрочних ──
var _noDlSelectedCourse = 'all';

function showNoDlModal() {
  const modal = document.getElementById('modal-no-dl');
  modal.style.display = 'flex';
  document.getElementById('no-dl-search').value = '';
  _noDlSelectedCourse = 'all';
  document.getElementById('no-dl-list').innerHTML = '<div class="loading"><div class="spinner"></div>Завантаження...</div>';
  _rebuildNoDlCourseFilter();
  if(token && courses.length) {
    _loadNoDlAssignments().then(() => { _rebuildNoDlCourseFilter(); renderNoDlList(); });
  } else {
    renderNoDlList();
  }
  setTimeout(() => { const s = document.getElementById('no-dl-search'); if(s) s.focus(); }, 80);
}

function _rebuildNoDlCourseFilter() {
  const sel = document.getElementById('no-dl-course-select');
  if(!sel) return;
  const courseNames = (courses||[])
    .map(c => c.fullname || c.shortname || '')
    .filter(Boolean)
    .sort((a,b) => a.localeCompare(b,'uk'));
  if(_noDlSelectedCourse !== 'all' && !courseNames.includes(_noDlSelectedCourse)) _noDlSelectedCourse = 'all';
  sel.innerHTML = '<option value="all">Усі курси</option>' +
    courseNames.map(c => `<option value="${escHtml(c)}"${_noDlSelectedCourse===c?' selected':''}>${escHtml(c)}</option>`).join('');
  sel.value = _noDlSelectedCourse;
}

function _toggleNoDlDropdown() {}
function _setNoDlCourse(course) { _noDlSelectedCourse = course; renderNoDlList(); }
function closeNoDlModal() { document.getElementById('modal-no-dl').style.display = 'none'; }

function renderNoDlList() {
  const q = (document.getElementById('no-dl-search').value || '').toLowerCase();
  const selectedCourse = _noDlSelectedCourse || 'all';
  const el = document.getElementById('no-dl-list');

  // Бессрочні — або _noDeadline з allDl, або ті що мають override
  let items = allDl.filter(d => !_dlDeleted.includes(String(d.id)) && (d._noDeadline || !d.due));
  if(q) items = items.filter(d => d.name.toLowerCase().includes(q) || d.course.toLowerCase().includes(q));
  if(selectedCourse && selectedCourse !== 'all') items = items.filter(d => d.course === selectedCourse);

  if(!items.length) {
    el.innerHTML = '<div class="empty"><div class="emo">🎉</div><p>Бессрочних завдань не знайдено.<br><span style="font-size:12px;color:var(--text2);">Усі завдання з Moodle мають дедлайни.</span></p></div>';
    return;
  }

  el.innerHTML = items.map(d => {
    const sid = String(d.id);
    const ov = _dlOverrides[sid];
    const hasOv = ov && ov.due;
    const badge = hasOv
      ? '<span style="font-size:9px;background:rgba(56,208,122,.15);color:var(--success);border:1px solid rgba(56,208,122,.3);border-radius:4px;padding:1px 6px;">✅ '+fmtDate(ov.due)+'</span>'
      : '<span style="font-size:9px;background:var(--bg3);color:var(--text2);border:1px solid var(--border);border-radius:4px;padding:1px 6px;">без дедлайну</span>';
    const typeIcon = d._type === 'quiz' ? '📋 ' : '📝 ';
    return '<div style="display:flex;align-items:center;gap:10px;padding:10px 8px;border-bottom:1px solid var(--border);cursor:pointer;" onclick="window.open(\''+escHtml(d.url||'#')+'\',\'_blank\')">' +
      '<div style="width:8px;height:8px;border-radius:50%;background:'+(hasOv?'var(--success)':'var(--text2)')+';flex-shrink:0;"></div>'+
      '<div style="flex:1;min-width:0;">' +
        '<div style="font-size:13px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+typeIcon+escHtml(d.name)+'</div>'+
        '<div style="font-size:11px;color:var(--text2);margin-top:2px;">'+escHtml(d.course)+'</div>'+
        '<div style="margin-top:5px;">'+badge+'</div>'+
      '</div>'+
      '<button onclick="event.stopPropagation();closeNoDlModal();openDlEditModal(\''+escHtml(sid)+'\');" title="Встановити дедлайн" style="flex-shrink:0;background:var(--accent);border:none;border-radius:8px;padding:8px 12px;color:#0a0a0f;font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;">✏️ Дедлайн</button>'+
    '</div>';
  }).join('');
}

document.getElementById('modal-no-dl').addEventListener('click', function(e) {
  if(e.target === this) closeNoDlModal();
});
