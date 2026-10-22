// Organizer page for the Bunchly Organizer Hub. Plain JavaScript, no build step.
// Talks to the Supabase project in supabase/; row level security decides what each organizer may do.
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';

const $ = (id) => document.getElementById(id);

let config;
try {
  config = (await import('./config.js')).default;
} catch {
  config = null;
}
if (!config?.supabaseUrl || !config?.supabaseKey) {
  showBanner('This page isn\'t set up yet: copy config.example.js to config.js and fill in your Supabase project.');
  throw new Error('missing config.js');
}

const db = createClient(config.supabaseUrl, config.supabaseKey);
let organizer = null;

function showBanner(text, isError = true) {
  const banner = $('banner');
  banner.textContent = text;
  banner.classList.toggle('error', isError);
  banner.hidden = !text;
}

function show(section) {
  for (const id of ['signed-out', 'create', 'dashboard']) $(id).hidden = id !== section;
  $('sign-out').hidden = section === 'signed-out';
}

const displayCode = (code) => `${code.slice(0, 4)}-${code.slice(4)}`;
const followURL = (code) => new URL(`follow.html?code=${code}`, location.href).toString();

// MARK: Signing in

$('sign-in-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const email = $('email').value.trim();
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: location.href.split('#')[0] },
  });
  if (error) return showBanner(`Couldn't send the link: ${error.message}`);
  showBanner(`Check ${email} for a sign-in link. You can close this tab.`, false);
});

$('sign-out').addEventListener('click', async () => {
  await db.auth.signOut();
  organizer = null;
  show('signed-out');
});

db.auth.onAuthStateChange((_event, session) => {
  // Runs once on load too. Defer so Supabase finishes its own work first.
  setTimeout(() => (session ? loadOrganizer() : show('signed-out')), 0);
});

// MARK: The organizer

async function loadOrganizer() {
  const { data, error } = await db.from('organizers').select('*').order('created_at').limit(1);
  if (error) return showBanner(`Couldn't load your page: ${error.message}`);
  organizer = data[0] ?? null;
  if (!organizer) return show('create');
  renderOrganizer();
  show('dashboard');
  await loadPosts();
}

$('create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const { data, error } = await db.from('organizers').insert({
    name: $('org-name').value.trim(),
    kind: $('org-kind').value,
    city: $('org-city').value.trim(),
    website: $('org-website').value.trim(),
    phone: $('org-phone').value.trim(),
    time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
  }).select().single();
  if (error) return showBanner(`Couldn't create your page: ${error.message}`);
  showBanner('');
  organizer = data;
  renderOrganizer();
  show('dashboard');
  await loadPosts();
});

function renderOrganizer() {
  $('org-title').textContent = organizer.name;
  const status = $('org-status');
  status.textContent = organizer.verified
    ? '✓ Checked by Bunchly. Families see that you\'re real.'
    : 'Not checked yet. Families see a warning until Bunchly calls the number on your website.';
  status.classList.toggle('ok', organizer.verified);

  $('code').textContent = displayCode(organizer.follow_code);
  const link = followURL(organizer.follow_code);
  $('follow-link').href = link;

  const qr = qrcode(0, 'M');
  qr.addData(link);
  qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
}

$('copy-link').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(followURL(organizer.follow_code));
    showBanner('Link copied.', false);
  } catch {
    showBanner('Couldn\'t copy. Select the link and copy it yourself.');
  }
});

$('rotate').addEventListener('click', async () => {
  if (!confirm('Make a new code? The old code, link and QR code stop working, and families who already follow you will need the new one.')) return;
  const { data, error } = await db.rpc('rotate_follow_code', { org: organizer.id });
  if (error) return showBanner(`Couldn't make a new code: ${error.message}`);
  organizer.follow_code = data;
  renderOrganizer();
  showBanner('New code made. Print the new QR code.', false);
});

// MARK: Posts

const kindLabels = { event: 'Event', closure: 'Closed', bring: 'Bring this' };

function selectedKind() {
  return document.querySelector('input[name="kind"]:checked').value;
}

function updateForm() {
  $('times').hidden = $('post-all-day').checked;
  $('location-field').hidden = selectedKind() !== 'event';
}
document.querySelectorAll('input[name="kind"]').forEach((input) => input.addEventListener('change', updateForm));
$('post-all-day').addEventListener('change', updateForm);
$('post-date').valueAsDate = new Date();

// Times are local to this browser, which is where the organizer is (organizers.time_zone).
const localISO = (date, time) => new Date(`${date}T${time}`).toISOString();

$('post-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const kind = selectedKind();
  const allDay = $('post-all-day').checked;
  const date = $('post-date').value;
  const endDate = $('post-end-date').value || null;
  const startsAt = localISO(date, allDay ? '00:00' : $('post-start').value);
  let endsAt = null;
  if (allDay && endDate && endDate > date) endsAt = localISO(endDate, '00:00');
  if (!allDay) endsAt = localISO(endDate || date, $('post-end').value);
  if (endsAt && endsAt < startsAt) return showBanner('The end is before the start.');

  const { error } = await db.from('posts').insert({
    organizer_id: organizer.id,
    kind,
    title: $('post-title').value.trim(),
    details: $('post-details').value.trim(),
    starts_at: startsAt,
    ends_at: endsAt,
    all_day: allDay,
    location: kind === 'event' ? $('post-location').value.trim() : '',
  });
  if (error) return showBanner(`Couldn't post: ${error.message}`);
  showBanner('Posted. Families see it next time Bunchly checks, within 15 minutes.', false);
  $('post-title').value = '';
  $('post-details').value = '';
  $('post-location').value = '';
  $('post-end-date').value = '';
  await loadPosts();
});

async function loadPosts() {
  const since = new Date(Date.now() - 86_400_000).toISOString();
  const { data, error } = await db.from('posts').select('*')
    .eq('organizer_id', organizer.id).gte('starts_at', since).order('starts_at');
  if (error) return showBanner(`Couldn't load posts: ${error.message}`);
  const list = $('posts');
  list.replaceChildren(...data.map(renderPost));
  $('no-posts').hidden = data.length > 0;
}

function renderPost(post) {
  const item = document.createElement('li');
  const start = new Date(post.starts_at);
  const when = post.all_day
    ? start.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
    : start.toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  const text = document.createElement('div');
  const kind = document.createElement('span');
  kind.className = `kind ${post.kind}`;
  kind.textContent = kindLabels[post.kind];
  const title = document.createElement('strong');
  title.textContent = post.title;
  const meta = document.createElement('div');
  meta.className = 'muted';
  meta.textContent = [when, post.location].filter(Boolean).join(' · ');
  text.append(kind, ' ', title, meta);

  const remove = document.createElement('button');
  remove.className = 'link danger';
  remove.textContent = 'Remove';
  remove.addEventListener('click', async () => {
    if (!confirm(`Remove "${post.title}"? It disappears from families' calendars and reminders.`)) return;
    const { error } = await db.from('posts').delete().eq('id', post.id);
    if (error) return showBanner(`Couldn't remove it: ${error.message}`);
    await loadPosts();
  });

  item.append(text, remove);
  return item;
}

updateForm();
