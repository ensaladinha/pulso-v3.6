// Punto de entrada: sesión, router y eventos globales. La lógica vive en los otros módulos.
import { $, $$, ago, stale, toast } from './util.js';
import { P, clearGuest, hasUnsaved, loadGuest, loadProfile, recoverPending, retrySave, save, session, setProfile, stopSync } from './state.js';
import { showAuth } from './auth.js';
import { bindCards } from './cards.js';
import { V, skeleton, errorState } from './views.js';
import { setPlaying, stopAll } from './player.js';

const TITLES = { home: 'Inicio', music: 'Música', games: 'Videojuegos', media: 'Series y películas', profile: 'Mi perfil', search: 'Búsqueda' };
const safeDecode = s => { try { return decodeURIComponent(s); } catch { return s; } }; // un hash mal formado no debe romper la app

let token = 0; // cada navegación tiene el suyo: si llega una respuesta vieja, se descarta
export async function render() {
  stale.at = 0; // se vuelve a calcular con las respuestas de esta pantalla
  const mine = ++token, ctx = { alive: () => mine === token };
  const [sec, ...rest] = (location.hash.slice(2) || 'home').split('/');
  const name = V[sec] ? sec : 'home', view = $('#view');
  document.body.dataset.sec = name;
  document.title = `${TITLES[name]} · Pulso`;
  $$('#nav a').forEach(a => { const on = a.dataset.s === name; a.classList.toggle('on', on); on ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'); });
  view.setAttribute('aria-busy', 'true'); view.innerHTML = skeleton(name);
  try { await V[name](safeDecode(rest.join('/')), ctx); }
  catch (e) { console.error(e); if (ctx.alive()) view.innerHTML = errorState(); }
  if (!ctx.alive()) return;
  view.setAttribute('aria-busy', 'false');
  setPlaying();
  // Datos guardados por el service worker (sin conexión): se dice de cuándo son, en vez de mostrarlos como si fueran de ahora.
  if (stale.at) view.insertAdjacentHTML('afterbegin', `<p class="notice" role="status">Sin conexión: estás viendo datos guardados ${ago(stale.at)}.</p>`);
}

const syncHeader = () => { $('#login').hidden = !!session.user; $('.pf').hidden = !session.user; };
const closeAuth = () => { $('#auth').hidden = true; $('#auth').innerHTML = ''; document.body.classList.remove('locked'); syncHeader(); render(); };
const askLogin = (mode = 'menu', opts = {}) => showAuth(enter, mode, { onCancel: closeAuth, ...opts });
async function enter(user, isNew, profile) {
  // Quien se registra conserva lo que ya eligió como invitado (gustos, favoritos): se guarda en su cuenta nueva.
  const guestData = isNew && (P.onboardingDone || Object.keys(P.tags).length) ? { ...P, rev: 0 } : null;
  session.user = user;
  // acceso y /auth/me ya traen el perfil; solo si falta se pide aparte
  let server = profile;
  if (!isNew && server === undefined) try { const r = await fetch('/api/profile'); if (r.ok) server = (await r.json()).profile; } catch {}
  loadProfile(server ?? null);
  clearGuest(); // el perfil de invitado de este navegador ya no corresponde: o se migró a la cuenta nueva o se descarta
  if (guestData) { setProfile(guestData); save(); }
  else if (!isNew) { // cambios que no llegaron a guardarse (sin conexión o sesión vencida): se recuperan y se fusionan con lo del servidor
    const back = recoverPending(user.email, server ?? null);
    if (back) { setProfile(back); save(); toast('Recuperamos los cambios que no se habían guardado.'); }
  }
  $('#auth').hidden = true; $('#auth').innerHTML = ''; document.body.classList.remove('locked'); syncHeader();
  if (location.hash !== '#/') location.hash = '#/'; else render();
}
async function logout() {
  await fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
  stopAll(); stopSync(); session.user = null; setProfile(null); syncHeader(); showSyncWarning(null);
  if (location.hash !== '#/') location.hash = '#/'; else render(); // se vuelve a la portada pública, no a un muro
}
// Entrada: sin cuenta se ve la portada pública igual; solo guardar favoritos o gustos pide cuenta.
async function boot() {
  const m = /^#\/reset\/([a-f0-9]{64})$/.exec(location.hash);
  if (m) { history.replaceState(null, '', location.pathname); return showAuth(enter, 'reset', { token: m[1], onCancel: closeAuth }); } // el token sale de la barra de direcciones enseguida
  try { const r = await fetch('/api/auth/me'); if (r.ok) { const d = await r.json(); return enter(d.user, false, d.profile); } } catch {}
  loadGuest(); // sin cuenta: se recuperan los gustos que esta persona ya había elegido en este navegador
  syncHeader(); render();
}

// ---------- eventos globales ----------
addEventListener('hashchange', render);
addEventListener('pulso:render', render);
addEventListener('pulso:logout', logout);
addEventListener('pulso:login', () => askLogin());
addEventListener('pulso:signed-out', () => { stopSync(); session.user = null; setProfile(null); syncHeader(); showSyncWarning(null); location.hash = '#/'; render(); }); // cuenta borrada o sesiones cerradas
// Dos dispositivos guardaron a la vez: se combinaron (no se descartó nada) y se redibuja con el resultado.
addEventListener('pulso:conflict', () => { toast('Tu perfil se actualizó en otro dispositivo: combinamos los cambios de los dos.'); render(); });
// Guardado del perfil: se avisa de forma visible y persistente (un aviso que desaparece en 3 s se pasa por alto) y se reintenta solo.
const SAVE_ERRORS = {
  offline: 'No pudimos guardar tus cambios porque no hay conexión. Lo seguimos intentando; no cierres esta pestaña todavía.',
  server: 'El servidor no respondió y tus cambios todavía no se guardaron. Lo seguimos intentando.',
  'too-big': 'Tu perfil es demasiado grande para guardarse. Quitá algunos favoritos y probá de nuevo.',
  conflict: 'No pudimos guardar tus cambios por un choque con otro dispositivo. Lo vamos a reintentar.',
  rejected: 'No pudimos guardar tus cambios. Probá recargar la página.'
};
function showSyncWarning(text) { const w = $('#syncwarn'); if (!w) return; w.textContent = text || ''; w.hidden = !text; }
addEventListener('pulso:save-error', e => showSyncWarning(SAVE_ERRORS[e.detail?.kind] || SAVE_ERRORS.rejected));
addEventListener('pulso:save-ok', () => { showSyncWarning(null); toast('Cambios guardados.'); });
// La sesión de 30 días venció: los cambios se respaldan en este navegador y se recuperan al acceder de nuevo con la misma cuenta.
addEventListener('pulso:session-expired', () => {
  session.user = null; syncHeader(); showSyncWarning(null);
  toast('Tu sesión venció. Accedé de nuevo para guardar tus cambios.', { label: 'Acceder', run: () => askLogin('in') });
});
addEventListener('online', retrySave);
addEventListener('beforeunload', e => { if (hasUnsaved()) { e.preventDefault(); e.returnValue = ''; } }); // hay cambios que todavía no llegaron al servidor
$('#login').onclick = () => askLogin();
addEventListener('offline', () => toast('Sin conexión: algunas cosas no van a cargar.'));
addEventListener('online', () => toast('Conexión recuperada.'));
document.addEventListener('click', e => { if (e.target.closest('[data-retry]')) { e.preventDefault(); render(); } });
// Imágenes que no cargan: se quitan y queda el ícono de fondo (no se puede usar onerror en línea por la CSP)
document.addEventListener('error', e => { if (e.target.tagName === 'IMG' && e.target.hasAttribute('data-hide')) e.target.remove(); }, true);
// Tras navegar, el foco va al contenido (lectores de pantalla y teclado).
// Excepción: si la persona sigue escribiendo en el buscador (el cambio de hash lo provocó el propio buscador), el foco se queda ahí.
addEventListener('hashchange', () => { if (document.activeElement !== $('#gs')) $('#view').focus({ preventScroll: true }); });
// "Actualizado hace X" se refresca solo, con la hora real en que el servidor armó la portada
setInterval(() => { const u = $('#upd'); if (u) u.textContent = ago(+u.dataset.t); }, 30000);
bindCards();

let searchTimer;
const goSearch = () => { clearTimeout(searchTimer); const q = $('#gs').value.trim(); location.hash = q ? '#/search/' + encodeURIComponent(q) : '#/'; };
$('#gs').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(goSearch, 500); });
$('#gs').addEventListener('keydown', e => e.key === 'Enter' && goSearch());
boot();
if ('serviceWorker' in navigator && location.protocol !== 'file:') addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
