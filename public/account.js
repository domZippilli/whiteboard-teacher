// Accounts UI: first-run setup, "who's learning?" picker, PIN/password entry, admin password
// prompt, and the admin Users page. The server enforces all of it; this is just the front door.

export const AVATARS = ['🦉', '🦖', '🐙', '🦊', '🐼', '🐢', '🦄', '🐝', '🚀', '🌟', '🐸', '🐯', '🦋', '🐳', '🌵', '🎸', '🐶', '🐱', '🐧', '🦁'];
export const BANDS = { under8: 'Under 8', '8-12': '8–12', '13-17': '13–17', adult: 'Adult' };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Fill an avatar picker (a row of emoji buttons) and return a getter for the choice.
function avatarPicker(el, current) {
  let chosen = current || AVATARS[0];
  el.replaceChildren();
  for (const a of AVATARS) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a;
    b.classList.toggle('on', a === chosen);
    b.onclick = () => {
      chosen = a;
      el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b));
    };
    el.appendChild(b);
  }
  return () => chosen;
}

export function createAccountUI({ api, show, onSignedIn, onShowLessons, onPreviewVoice }) {
  // ----- first run -----
  function showSetup() {
    show('setup');
    const getAvatar = avatarPicker($('#setupAvatars'), '🦉');
    $('#setupErr').textContent = '';
    $('#setupForm').onsubmit = async e => {
      e.preventDefault();
      const pw = $('#setupPw').value, pw2 = $('#setupPw2').value;
      if (pw !== pw2) return ($('#setupErr').textContent = "Passwords don't match");
      try {
        await api('setup', { name: $('#setupName').value, avatar: getAvatar(), password: pw });
        onSignedIn();
      } catch (err) { $('#setupErr').textContent = err.message; }
    };
  }

  // ----- profile picker -----
  async function showPicker() {
    show('picker');
    const list = $('#profiles');
    list.replaceChildren();
    const profiles = await api('profiles');
    for (const p of profiles) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'profile';
      b.innerHTML = `<span class="avatar">${esc(p.avatar)}</span><span class="name">${esc(p.name)}</span>${p.locked ? '<span class="lock">🔒</span>' : ''}`;
      b.onclick = () => (p.locked ? askSecret(p) : signIn(p, ''));
      list.appendChild(b);
    }
  }

  async function signIn(p, secret) {
    await api('login', { id: p.id, secret });
    onSignedIn();
  }

  // PIN (learners) or password (admin) for a profile.
  function askSecret(p) {
    const dlg = $('#pinDlg');
    const admin = p.role === 'admin';
    $('#pinWho').innerHTML = `<span class="avatar">${esc(p.avatar)}</span> ${esc(p.name)}`;
    const input = $('#pinInput');
    input.value = '';
    input.placeholder = admin ? 'Password' : 'PIN';
    input.inputMode = admin ? 'text' : 'numeric';
    input.autocomplete = admin ? 'current-password' : 'off';
    $('#pinErr').textContent = '';
    $('#pinForm').onsubmit = async e => {
      e.preventDefault();
      try { await signIn(p, input.value); dlg.close(); }
      catch (err) { $('#pinErr').textContent = err.message; input.select(); }
    };
    $('#pinCancel').onclick = () => dlg.close();
    dlg.showModal();
    input.focus();
  }

  // Admin password again after the admin window lapsed. Resolves true if re-entered.
  function askAdminPassword() {
    return new Promise(resolve => {
      const dlg = $('#elevateDlg');
      $('#elevateInput').value = '';
      $('#elevateErr').textContent = '';
      $('#elevateForm').onsubmit = async e => {
        e.preventDefault();
        try {
          await api('elevate', { password: $('#elevateInput').value });
          dlg.close();
          resolve(true);
        } catch (err) { $('#elevateErr').textContent = err.message; }
      };
      $('#elevateCancel').onclick = () => { dlg.close(); resolve(false); };
      dlg.showModal();
      $('#elevateInput').focus();
    });
  }

  // ----- admin: users -----
  async function renderUsers() {
    const box = $('#adminUsers');
    const users = await api('admin/users');
    box.innerHTML = `<div class="admin-head"><h2>People</h2><button type="button" id="addUser">+ Add learner</button></div>`;
    const list = document.createElement('div');
    list.className = 'user-list';
    for (const u of users) {
      const row = document.createElement('div');
      row.className = 'user-row';
      row.innerHTML = `<span class="avatar">${esc(u.avatar)}</span>
        <span class="who"><b>${esc(u.name)}</b><small>${u.role === 'admin' ? 'Admin' : 'Learner'} · ${BANDS[u.ageBand] || ''}${u.locked ? ' · 🔒' : ''}</small></span>
        <button type="button" class="ghost lessons">History</button>
        <button type="button" class="ghost edit">Edit</button>`;
      row.querySelector('.edit').onclick = () => editUser(u);
      row.querySelector('.lessons').onclick = () => onShowLessons?.(u);
      list.appendChild(row);
    }
    box.appendChild(list);
    $('#addUser').onclick = () => editUser(null);
  }

  function editUser(u) {
    const dlg = $('#userDlg');
    const isNew = !u;
    u ||= { role: 'learner', ageBand: '8-12', avatar: AVATARS[1], settings: {} };
    $('#userDlgTitle').textContent = isNew ? 'Add learner' : `Edit ${u.name}`;
    $('#uName').value = u.name || '';
    const getAvatar = avatarPicker($('#uAvatars'), u.avatar);
    $('#uRole').value = u.role;
    $('#uBand').value = u.ageBand;
    $('#uTeacher').value = u.settings?.teacher || '';
    $('#uNotes').value = u.notes || '';
    $('#uSecret').value = '';
    $('#uNoPin').checked = !isNew && !u.locked;
    $('#uErr').textContent = '';
    const syncSecretUi = () => {
      const admin = $('#uRole').value === 'admin';
      $('#uSecretLabel').firstChild.textContent = admin ? 'Password ' : 'PIN (4–8 digits) ';
      $('#uSecret').inputMode = admin ? 'text' : 'numeric';
      $('#uSecret').placeholder = isNew ? (admin ? 'Required' : 'Optional') : 'Leave blank to keep';
      $('#uNoPinRow').classList.toggle('hidden', admin);
    };
    $('#uRole').onchange = syncSecretUi;
    syncSecretUi();
    $('#uDelete').classList.toggle('hidden', isNew);
    $('#uDelete').onclick = async () => {
      if (!confirm(`Delete ${u.name}? Their lessons stay on disk but won't be listed.`)) return;
      try { await api('admin/users?id=' + encodeURIComponent(u.id), null, 'DELETE'); dlg.close(); renderUsers(); }
      catch (err) { $('#uErr').textContent = err.message; }
    };
    $('#uCancel').onclick = () => dlg.close();
    $('#userForm').onsubmit = async e => {
      e.preventDefault();
      const body = {
        name: $('#uName').value, avatar: getAvatar(), role: $('#uRole').value, ageBand: $('#uBand').value,
        notes: $('#uNotes').value, settings: { teacher: $('#uTeacher').value.trim() || undefined },
      };
      const secret = $('#uSecret').value;
      if (secret) body.secret = secret;
      else if ($('#uNoPin').checked && body.role !== 'admin') body.secret = null;
      try {
        if (isNew) await api('admin/users', body);
        else await api('admin/users', { id: u.id, ...body }, 'PUT');
        dlg.close();
        renderUsers();
      } catch (err) { $('#uErr').textContent = err.message; }
    };
    dlg.showModal();
  }

  // ----- admin: backends -----
  // Which service does each job (ordered: first working one is used), and each service's settings.
  const JOB_INFO = {
    lessons: ['Lessons', 'Writes lessons, answers questions, makes quizzes'],
    utility: ['Screening & profiles', 'Checks topics against the content rules; updates learning profiles'],
    voice: ['Voice', 'Speaks the lessons (falls back down the list)'],
    listening: ['Listening', 'Turns spoken questions into text (none = no mic buttons)'],
  };
  async function renderBackends({ onSaved } = {}) {
    const box = $('#adminBackends');
    const view = await api('admin/backends');
    const state = { backends: structuredClone(view.backends), jobs: structuredClone(view.jobs) };
    const secrets = {}; // id.key → typed value (untouched secrets are kept)
    const typeLabel = t => view.types[t]?.label || t;
    const draw = () => {
      box.innerHTML = `<div class="admin-head"><h2>Backends</h2></div>
        <p class="hint">${view.fromEnv ? 'Using the settings from <code>.env</code>. Saving here switches to these settings (stored in <code>data/config.json</code>).' : 'Stored in <code>data/config.json</code>. Changes apply as soon as you save.'}</p>
        <div class="jobs"></div>
        <h3 class="sub">Services</h3>
        <div class="services"></div>
        <div class="row"><select class="new-type"><option value="">+ New service…</option>${Object.entries(view.types).map(([t, m]) => `<option value="${t}">${esc(m.label)}</option>`).join('')}</select></div>
        <div class="row save-row"><button type="button" class="save">Save</button><span class="hint msg"></span></div>`;
      const badge = id => {
        const st = view.backends[id]?.status;
        if (!view.backends[id]) return '<span class="badge new">not saved</span>';
        return st?.ok ? '<span class="badge ok">ok</span>' : `<span class="badge bad" title="${esc(st?.error || '')}">unavailable</span>`;
      };
      // Jobs
      const jobsEl = box.querySelector('.jobs');
      for (const [job, [label, help]] of Object.entries(JOB_INFO)) {
        const ids = state.jobs[job] || (state.jobs[job] = []);
        const el = document.createElement('div');
        el.className = 'job';
        el.innerHTML = `<div class="job-head"><b>${label}</b><span class="hint">${help}</span></div><div class="chain"></div>`;
        const chain = el.querySelector('.chain');
        ids.forEach((id, i) => {
          const chip = document.createElement('span');
          chip.className = 'chip';
          chip.innerHTML = `<span class="n">${i + 1}</span> ${esc(id)} ${badge(id)}
            <button type="button" title="Earlier" ${i ? '' : 'disabled'}>↑</button><button type="button" title="Later" ${i < ids.length - 1 ? '' : 'disabled'}>↓</button><button type="button" title="Remove from ${label}">✕</button>`;
          const [up, down, rm] = chip.querySelectorAll('button');
          up.onclick = () => { [ids[i - 1], ids[i]] = [ids[i], ids[i - 1]]; draw(); };
          down.onclick = () => { [ids[i + 1], ids[i]] = [ids[i], ids[i + 1]]; draw(); };
          rm.onclick = () => { ids.splice(i, 1); draw(); };
          chain.appendChild(chip);
        });
        const candidates = Object.entries(state.backends).filter(([id, b]) => view.types[b.type]?.kind === view.jobKinds[job] && !ids.includes(id));
        if (candidates.length) {
          const sel = document.createElement('select');
          sel.innerHTML = `<option value="">+ add</option>${candidates.map(([id]) => `<option>${esc(id)}</option>`).join('')}`;
          sel.onchange = () => { ids.push(sel.value); draw(); };
          chain.appendChild(sel);
        }
        if (!ids.length) chain.insertAdjacentHTML('beforeend', `<span class="hint">${job === 'voice' ? 'none: the device’s own voice' : job === 'listening' ? 'none: no mic' : 'none'}</span>`);
        jobsEl.appendChild(el);
      }
      // Services
      const svc = box.querySelector('.services');
      for (const [id, b] of Object.entries(state.backends)) {
        const meta = view.types[b.type];
        const card = document.createElement('div');
        card.className = 'service';
        card.innerHTML = `<div class="svc-head"><b>${esc(id)}</b> <span class="hint">${esc(typeLabel(b.type))}</span> ${badge(id)}</div>
          <p class="hint">${esc(meta?.help || '')}</p><div class="fields"></div>
          <div class="row"><button type="button" class="ghost test">Test</button><button type="button" class="ghost danger rm">Remove</button><span class="hint result"></span></div>`;
        const fields = card.querySelector('.fields');
        for (const f of meta?.fields || []) {
          const lab = document.createElement('label');
          lab.innerHTML = `<span>${esc(f.label)}</span>`;
          let input;
          if (f.kind === 'select') {
            input = document.createElement('select');
            input.innerHTML = f.options.map(o => `<option>${esc(o)}</option>`).join('');
            input.value = b[f.key] ?? f.default;
          } else {
            input = document.createElement('input');
            input.type = f.kind === 'number' ? 'number' : f.kind === 'secret' ? 'password' : 'text';
            if (f.kind === 'secret') {
              const m = b[f.key] || {};
              input.placeholder = m.set ? `${m.hint}${m.source === 'typed' ? '' : ` (from ${m.ref})`}: leave blank to keep` : 'Key, $ENV_VAR or op://vault/item/field';
              input.value = secrets[`${id}.${f.key}`] || '';
              input.autocomplete = 'off';
              input.oninput = () => { secrets[`${id}.${f.key}`] = input.value; };
            } else {
              input.value = b[f.key] ?? '';
              input.placeholder = f.default ?? '';
            }
          }
          if (f.kind !== 'secret') input.oninput = input.onchange = () => { b[f.key] = input.value; };
          lab.appendChild(input);
          if (f.hint) lab.insertAdjacentHTML('beforeend', `<small class="hint">${esc(f.hint)}</small>`);
          fields.appendChild(lab);
        }
        const result = card.querySelector('.result');
        card.querySelector('.test').onclick = async () => {
          if (!view.backends[id]) return (result.textContent = 'Save first, then test.');
          result.textContent = 'Testing…';
          try {
            const r = await api('admin/backend-test', { id });
            if (!r.ok) return (result.textContent = `✗ ${r.error}`);
            result.textContent = `✓ ${r.message || (r.browser ? 'Runs in the browser: playing a sample here' : 'Spoke a sample')} (${(r.ms / 1000).toFixed(1)} s)`;
            if (r.audio) new Audio(r.audio).play();
            if (r.browser) onPreviewVoice?.(`${id}:${r.browser.voice}`, 'your teacher');
          } catch (err) { result.textContent = `✗ ${err.message}`; }
        };
        card.querySelector('.rm').onclick = () => {
          if (!confirm(`Remove ${id}?`)) return;
          delete state.backends[id];
          for (const j of Object.keys(state.jobs)) state.jobs[j] = state.jobs[j].filter(x => x !== id);
          draw();
        };
        svc.appendChild(card);
      }
      box.querySelector('.new-type').onchange = e => {
        const t = e.target.value;
        if (!t) return;
        let id = t, n = 2;
        while (state.backends[id]) id = `${t}-${n++}`;
        id = (prompt('Name for this service (lowercase, digits, dashes):', id) || '').trim();
        if (!id) return draw();
        if (state.backends[id]) { alert('That name is taken'); return draw(); }
        state.backends[id] = { type: t };
        draw();
      };
      box.querySelector('.save').onclick = async () => {
        const msg = box.querySelector('.msg');
        const body = { jobs: state.jobs, backends: {} };
        for (const [id, b] of Object.entries(state.backends)) {
          const out = { type: b.type };
          for (const f of view.types[b.type]?.fields || []) {
            out[f.key] = f.kind === 'secret' ? (secrets[`${id}.${f.key}`] ? secrets[`${id}.${f.key}`] : { keep: true }) : b[f.key];
          }
          body.backends[id] = out;
        }
        try {
          await api('admin/backends', body, 'PUT');
          msg.textContent = 'Saved.';
          onSaved?.();
          renderBackends({ onSaved });
        } catch (err) { msg.textContent = err.message; }
      };
    };
    draw();
  }

  // ----- admin: voices -----
  // For each voice backend: what it offers, which voices learners may pick, their names, the default.
  async function renderVoices() {
    const box = $('#adminVoices');
    const catalog = await api('admin/voices');
    box.innerHTML = `<div class="admin-head"><h2>Voices</h2></div>
      <p class="hint">Choose the voices learners can pick, and give them friendly names. ▶ plays a sample.</p>`;
    if (!catalog.length) { box.innerHTML += '<p class="hint">No voice service is set up, so the device\'s own voice is used.</p>'; return; }
    for (const c of catalog) {
      const card = document.createElement('div');
      card.className = 'voice-card';
      card.innerHTML = `<h3>${esc(c.describe)}</h3>
        <div class="voice-table"></div>
        <div class="row add-voice"><input placeholder="Add a voice by ID"><input placeholder="Name"><button type="button" class="ghost">Add</button></div>
        <div class="row"><button type="button" class="save">Save</button><span class="hint msg"></span></div>`;
      const table = card.querySelector('.voice-table');
      // Enabled voices first (in catalog order), then everything else the backend offers.
      const rows = [
        ...c.enabled.map(v => ({ ...c.available.find(a => a.id === v.id), ...v, on: true })),
        ...c.available.filter(a => !c.enabled.some(v => v.id === a.id)).map(a => ({ ...a, on: false })),
      ];
      const radio = `default-${c.backend}`;
      const addRow = v => {
        const r = document.createElement('div');
        r.className = 'voice-row';
        r.innerHTML = `<input type="checkbox" class="on" title="Learners can pick this voice">
          <input class="nm" placeholder="Name">
          <span class="desc"></span>
          <label class="def"><input type="radio" name="${radio}"> default</label>
          <button type="button" class="ghost play" title="Play a sample">▶</button>`;
        r.dataset.id = v.id;
        r.querySelector('.on').checked = v.on;
        // Suggest the first name ("Roger - Laid-Back, Casual" → "Roger") for voices not yet enabled.
        r.querySelector('.nm').value = v.on ? v.name : String(v.name || v.id).split(' - ')[0];
        r.querySelector('.desc').textContent = v.description || v.id;
        r.querySelector('.def input').checked = v.id === c.default;
        r.querySelector('.play').onclick = () => onPreviewVoice?.(`${c.backend}:${v.id}`, r.querySelector('.nm').value);
        r.querySelector('.nm').oninput = () => { r.querySelector('.on').checked = true; };
        table.appendChild(r);
      };
      rows.forEach(addRow);
      const [idIn, nameIn, addBtn] = card.querySelectorAll('.add-voice input, .add-voice button');
      addBtn.onclick = () => {
        if (!idIn.value.trim()) return;
        addRow({ id: idIn.value.trim(), name: nameIn.value.trim() || idIn.value.trim(), on: true });
        idIn.value = nameIn.value = '';
      };
      card.querySelector('.save').onclick = async () => {
        const enabled = [...table.querySelectorAll('.voice-row')].filter(r => r.querySelector('.on').checked)
          .map(r => ({ id: r.dataset.id, name: r.querySelector('.nm').value.trim() }));
        const def = [...table.querySelectorAll('.voice-row')].find(r => r.querySelector('.def input').checked)?.dataset.id;
        try {
          await api('admin/voices', { backend: c.backend, enabled, default: def }, 'PUT');
          card.querySelector('.msg').textContent = 'Saved.';
        } catch (err) { card.querySelector('.msg').textContent = err.message; }
      };
      box.appendChild(card);
    }
  }

  // ----- admin: content rules -----
  async function renderPolicies() {
    const box = $('#adminPolicies');
    const policies = await api('admin/policies');
    const names = { master: 'Everyone (master)', ...BANDS };
    box.innerHTML = `<div class="admin-head"><h2>Content rules</h2></div>
      <p class="hint">Plain English. Every learner gets the master rules plus their age band's, plus the notes on their profile.
      Topics and questions are checked against them before anything is written, and lessons follow them. Lines starting with # are notes to yourself.</p>
      <div class="tabs" id="policyTabs"></div>
      <textarea id="policyText" rows="14" spellcheck="true"></textarea>
      <div class="row"><button type="button" id="policySave">Save</button><span id="policyMsg" class="hint"></span></div>`;
    let current = 'master';
    const tabs = $('#policyTabs');
    const select = name => {
      current = name;
      tabs.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.name === name));
      $('#policyText').value = policies[name] || '';
      $('#policyMsg').textContent = '';
    };
    for (const [name, label] of Object.entries(names)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.dataset.name = name;
      b.textContent = label;
      b.onclick = () => select(name);
      tabs.appendChild(b);
    }
    $('#policyText').oninput = () => { policies[current] = $('#policyText').value; $('#policyMsg').textContent = 'Unsaved changes'; };
    $('#policySave').onclick = async () => {
      try {
        await api('admin/policies', { name: current, text: policies[current] }, 'PUT');
        $('#policyMsg').textContent = 'Saved. Applies from the next question.';
      } catch (err) { $('#policyMsg').textContent = err.message; }
    };
    select('master');
  }

  // ----- admin: a learner's history -----
  // Tabs: lessons (rendered by the app's library), questions asked, quiz scores, feedback, turned down.
  async function renderHistory(u, { renderLessons, extraTabs = {} }) {
    const box = $('#adminHistory');
    const h = await api('admin/history?user=' + encodeURIComponent(u.id));
    const refusals = await api('admin/refusals?user=' + encodeURIComponent(u.id));
    const quizAvg = h.quizzes.length ? Math.round(100 * h.quizzes.reduce((a, q) => a + q.score / q.total, 0) / h.quizzes.length) : null;
    const liked = h.feedback.filter(f => f.liked === true).length, disliked = h.feedback.filter(f => f.liked === false).length;
    box.innerHTML = `<div class="admin-head"><h2>${esc(u.avatar)} ${esc(u.name)}</h2><button type="button" class="ghost" id="historyClose">Close</button></div>
      <p class="hint">${h.lessons.length} lesson${h.lessons.length === 1 ? '' : 's'} ·
        ${h.lessons.reduce((a, l) => a + (+l.minutes || 0), 0)} min ·
        ${h.questions.length} question${h.questions.length === 1 ? '' : 's'} asked ·
        ${quizAvg === null ? 'no quizzes yet' : `quizzes ${quizAvg}% on average`} ·
        👍 ${liked} 👎 ${disliked}</p>
      <div class="tabs" id="historyTabs"></div>
      <div id="historyBody" class="history-body"></div>`;
    $('#historyClose').onclick = () => box.replaceChildren();
    const when = at => (at ? new Date(at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '');
    const rows = (items, fmt) => {
      const el = $('#historyBody');
      el.replaceChildren();
      if (!items.length) return (el.innerHTML = '<p class="hint">Nothing yet.</p>');
      for (const it of items) {
        const row = document.createElement('div');
        row.className = 'refusal-row';
        const [main, sub] = fmt(it);
        row.innerHTML = '<div class="main"></div><div class="said"></div>';
        row.querySelector('.main').textContent = main;
        row.querySelector('.said').textContent = sub;
        el.appendChild(row);
      }
    };
    const tabs = {
      Lessons: () => renderLessons($('#historyBody')),
      Questions: () => rows(h.questions, q => [`"${q.question}"`, `${q.lesson} · ${when(q.at)}`]),
      Quizzes: () => rows(h.quizzes, q => [`${q.score}/${q.total}${q.score === q.total ? ' ★' : ''}  ${q.lesson}`, when(q.at)]),
      Feedback: () => rows(h.feedback, f => [`${f.liked === true ? '👍' : f.liked === false ? '👎' : '·'} ${f.text || '(no comment)'}`, `${f.lesson} · ${when(f.at)}`]),
      [`Turned down (${refusals.length})`]: () => rows(refusals, r => [
        `"${r.text.replace(/^Lesson: ".*?"\. Question: /, '').replace(/^"|"$/g, '')}"`,
        `${r.message || ''} · ${when(r.at)}`]),
      'Learning profile': () => renderProfile(u, $('#historyBody')),
      ...extraTabs,
    };
    const tabsEl = $('#historyTabs');
    for (const [label, render] of Object.entries(tabs)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.onclick = () => { tabsEl.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); render(); };
      tabsEl.appendChild(b);
    }
    tabsEl.firstChild.click();
    box.scrollIntoView({ behavior: 'smooth' });
  }

  // The learner's learning profile: maintained by Claude after lessons, editable here.
  async function renderProfile(u, el) {
    const p = await api('admin/profile?user=' + encodeURIComponent(u.id));
    el.innerHTML = `<p class="hint">How ${esc(u.name)} learns best, kept up to date by the teacher after each lesson and used when
      writing their lessons. Edit anything. Put your own notes under <b>${esc(p.adminHeading)}</b>: that section is never changed by the teacher.
      ${p.updatedAt ? `Last updated ${new Date(p.updatedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.` : 'Nothing yet: it fills in after their first finished lesson.'}</p>
      <textarea id="profileText" rows="16" spellcheck="true"></textarea>
      <div class="row"><button type="button" id="profileSave">Save</button><span id="profileMsg" class="hint"></span></div>`;
    const ta = el.querySelector('#profileText');
    ta.value = p.text || `${p.adminHeading}\n`;
    ta.oninput = () => (el.querySelector('#profileMsg').textContent = 'Unsaved changes');
    el.querySelector('#profileSave').onclick = async () => {
      try {
        await api('admin/profile', { user: u.id, text: ta.value }, 'PUT');
        el.querySelector('#profileMsg').textContent = 'Saved.';
      } catch (err) { el.querySelector('#profileMsg').textContent = err.message; }
    };
  }

  // A learner's refusals, shown under their lessons.
  async function renderRefusals(u, el) {
    const list = await api('admin/refusals?user=' + encodeURIComponent(u.id));
    el.innerHTML = `<h3>Turned down (${list.length})</h3>`;
    if (!list.length) { el.innerHTML += '<p class="hint">Nothing so far.</p>'; return; }
    for (const r of list.slice(0, 50)) {
      const row = document.createElement('div');
      row.className = 'refusal-row';
      row.innerHTML = `<div><b></b> <small></small></div><div class="said"></div>`;
      row.querySelector('b').textContent = `"${r.text.replace(/^Lesson: ".*?"\. Question: /, '').replace(/^"|"$/g, '')}"`;
      row.querySelector('small').textContent = `${r.kind.includes('question') ? 'question' : 'topic'} · ${new Date(r.at).toLocaleString()}`;
      row.querySelector('.said').textContent = r.message || '';
      el.appendChild(row);
    }
  }

  return { showSetup, showPicker, askAdminPassword, renderUsers, renderPolicies, renderRefusals, renderHistory, renderVoices, renderBackends };
}
