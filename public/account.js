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

export function createAccountUI({ api, show, onSignedIn, onShowLessons }) {
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
        <button type="button" class="ghost lessons">Lessons</button>
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

  return { showSetup, showPicker, askAdminPassword, renderUsers };
}
