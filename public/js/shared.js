// Código compartido entre el servidor y el navegador: nombres de gustos y cómo se convierten en etiquetas.
//
// Las etiquetas llevan prefijo por dominio para que "terror" de juegos no se mezcle con "terror" de series:
//   música  -> genre:pop        artist:coldplay
//   juegos  -> gamegenre:terror platform:pc
//   series  -> mediagenre:terror

// Normaliza el nombre de un artista: minúsculas, sin tildes, sin espacios dobles.
export const normName = s => String(s ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

// Etiquetas de artista de una canción.
// Un nombre se trata como UN artista: no se parte por "&", coma ni "x", porque "Earth, Wind & Fire", "Tyler, The Creator"
// o "Simon & Garfunkel" son un solo artista y partirlos dejaba etiquetas sin sentido (artist:fire).
// Solo se separan colaboraciones declaradas con "feat.", "ft." o "featuring" (no "with": rompería bandas como "Sleeping With Sirens"):
//   "Shakira feat. Maluma" -> artist:shakira, artist:maluma
const FEAT = /\s*[([]?\s*\b(?:feat\.?|ft\.?|featuring)\s+/;
export function artistTags(name) {
  const full = normName(name);
  if (!full) return [];
  const [main, ...guests] = full.split(FEAT);
  const out = new Set();
  const add = part => {
    const clean = part.replace(/[)\]]+$/, '').trim();
    if (clean.length > 1) out.add('artist:' + clean);
  };
  add(main);
  // Varios invitados se unen con "&" o "and". La coma NO separa: "feat. Tyler, The Creator" es un solo artista.
  guests.forEach(g => g.split(/\s*(?:&|\band\b)\s*/).forEach(add));
  return [...out];
}

// Para FILTRAR resultados de una búsqueda (no para etiquetar): ¿esta canción es del artista pedido?
// Acá sí conviene ser tolerante con colaboraciones: "Drake & Future" cuenta como una canción de Drake.
export function artistMatches(songArtist, wanted) {
  const w = normName(wanted), full = normName(songArtist);
  if (!w) return false;
  if (full === w || artistTags(songArtist).includes('artist:' + w)) return true;
  return full.split(/\s*(?:&|,|\bx\b|\bcon\b|\by\b|\band\b)\s*/).includes(w);
}

// ---------- Música ----------
// chart = id de género en los rankings de iTunes; terms = búsquedas por género para tener variedad.
export const MUSIC_GENRES = {
  rock: { label: 'Rock', chart: 21, terms: ['Rock', 'Hard Rock'], re: /rock/ },
  pop: { label: 'Pop', chart: 14, terms: ['Pop', 'Pop latino'], re: /\bpop\b/ },
  latin: { label: 'Latino', chart: 12, terms: ['Latino', 'Reggaeton'], re: /latin|reggaet|urban|cumbia|tango/ },
  'hip-hop/rap': { label: 'Hip-hop / Rap', chart: 18, terms: ['Hip-Hop/Rap', 'Rap'], re: /hip.?hop|\brap\b|trap/ },
  dance: { label: 'Dance', chart: 17, terms: ['Dance'], re: /dance/ },
  alternative: { label: 'Alternativo', chart: 20, terms: ['Alternative', 'Indie Rock'], re: /altern|indie/ },
  electronic: { label: 'Electrónica', chart: 7, terms: ['Electronic', 'House'], re: /electr|techno|house|edm/ },
  'r&b/soul': { label: 'R&B / Soul', chart: 15, terms: ['R&B/Soul', 'Soul'], re: /r&b|soul/ },
  reggae: { label: 'Reggae', chart: 24, terms: ['Reggae'], re: /reggae(?!t)/ },
  country: { label: 'Country', chart: 6, terms: ['Country'], re: /country/ },
  jazz: { label: 'Jazz', chart: 2, terms: ['Jazz'], re: /jazz/ },
  metal: { label: 'Metal', chart: 1153, terms: ['Metal', 'Heavy Metal'], re: /metal/ },
  'k-pop': { label: 'K-Pop', chart: 51, terms: ['K-Pop'], re: /k-?pop/ }
};
// Nombre de género que devuelve iTunes ("Música latina", "Pop latino"…) -> etiquetas canónicas.
export function musicGenreTags(raw) {
  const s = normName(raw), out = Object.keys(MUSIC_GENRES).filter(k => MUSIC_GENRES[k].re.test(s)).map(k => 'genre:' + k);
  return out.length ? out : s ? ['genre:' + s] : [];
}
export const songTags = (artist, genre) => [...artistTags(artist), ...musicGenreTags(genre)];

// ---------- Videojuegos ----------
// spy = etiqueta de SteamSpy; re = palabras que delatan el género en un título o descripción.
export const GAME_GENRES = {
  terror: { label: 'Terror', spy: 'Horror', re: /\bterror\b|horror|survival horror|\bmiedo\b|nightmare|haunted|zombie/i, steam: /^terror$/ },
  acción: { label: 'Acción', spy: 'Action', re: /\bacci[oó]n\b|\baction\b|shooter|\bfps\b|battle royale/i, steam: /^acci[oó]n$|^action$/ },
  rpg: { label: 'RPG', spy: 'RPG', re: /\brpg\b|role.?play|jrpg/i, steam: /^rpg$/ },
  estrategia: { label: 'Estrategia', spy: 'Strategy', re: /estrategia|strategy|\brts\b|4x\b|tower defense/i, steam: /^estrategia$|^strategy$/ },
  deportes: { label: 'Deportes', spy: 'Sports', re: /f[uú]tbol|football|soccer|\bfifa\b|\bea fc\b|\bnba\b|madden|\bnfl\b|deporte|\bsports?\b|\bf1\b/i, steam: /^deportes$|^sports$/ },
  aventura: { label: 'Aventura', spy: 'Adventure', re: /aventura|adventure/i, steam: /^aventura$|^adventure$/ },
  shooter: { label: 'Shooters', spy: 'Shooter', re: /shooter|\bfps\b|battle royale|tiros/i, steam: /^shooter$/ },
  indie: { label: 'Indie', spy: 'Indie', re: /\bindie\b/i, steam: /^indie$|^independiente$/ },
  'mundo abierto': { label: 'Mundo abierto', spy: 'Open World', re: /open.?world|mundo abierto/i, steam: /^mundo abierto$|^open world$/ },
  roguelike: { label: 'Roguelike', spy: 'Roguelike', re: /roguelike|rogue-?lite/i, steam: /^roguelike$/ },
  simulación: { label: 'Simulación', spy: 'Simulation', re: /simulaci[oó]n|simulator|simulation/i, steam: /^simulaci[oó]n$|^simulation$/ },
  carreras: { label: 'Carreras', spy: 'Racing', re: /carreras|racing/i, steam: /^carreras$|^racing$/ },
  puzles: { label: 'Puzles', spy: 'Puzzle', re: /puzzle|puzle|rompecabezas/i, steam: /^puzles?$|^puzzle$/ },
  supervivencia: { label: 'Supervivencia', spy: 'Survival', re: /supervivencia|survival(?! horror)/i, steam: /^supervivencia$|^survival$/ },
  lucha: { label: 'Lucha', spy: 'Fighting', re: /\blucha\b|fighting/i, steam: /^lucha$|^fighting$/ },
  plataformas: { label: 'Plataformas', spy: 'Platformer', re: /platformer|plataformas/i, steam: /^plataformas$|^platformer$/ }
};
export const PLATFORMS = {
  pc: { label: 'PC', re: /\bpc\b|steam|windows|epic games/i },
  playstation: { label: 'PlayStation', re: /playstation|\bps[345]\b|\bps vr/i },
  xbox: { label: 'Xbox', re: /\bxbox\b|game pass/i },
  nintendo: { label: 'Nintendo', re: /nintendo|\bswitch\b|\bswitch 2\b/i },
  móvil: { label: 'Celular', re: /android|\bios\b|\biphone\b|mobile|m[oó]vil|celular/i }
};
// Etiquetas de juego a partir de un texto libre (título, descripción de una noticia…).
export const gameTagsFromText = text => [
  ...Object.keys(GAME_GENRES).filter(k => GAME_GENRES[k].re.test(text)).map(k => 'gamegenre:' + k),
  ...Object.keys(PLATFORMS).filter(k => PLATFORMS[k].re.test(text)).map(k => 'platform:' + k)
];
// Géneros de Steam ("Acción", "Free to Play"…) -> etiquetas; los desconocidos se conservan tal cual.
export const steamGenreTag = desc => {
  const d = normName(desc), hit = Object.keys(GAME_GENRES).find(k => GAME_GENRES[k].steam.test(d) || GAME_GENRES[k].steam.test(String(desc).toLowerCase()));
  return 'gamegenre:' + (hit || d);
};

// ---------- Series y películas ----------
// tv = géneros/tipos de TVmaze; term = lo que se busca en iTunes (Películas).
export const MEDIA_GENRES = {
  comedia: { label: 'Comedia', tv: ['Comedy'], terms: ['Comedia', 'Comedy'], re: /comed/i },
  terror: { label: 'Terror', tv: ['Horror'], terms: ['Terror', 'Horror'], re: /terror|horror/i },
  'ciencia ficción': { label: 'Ciencia ficción', tv: ['Science-Fiction'], terms: ['Ciencia ficción', 'Science Fiction'], re: /ciencia|science|sci-?fi/i },
  animación: { label: 'Animación', tv: ['Anime'], tvType: ['Animation'], terms: ['Animación', 'Animation'], re: /anim|infant|anime/i },
  documental: { label: 'Documental', tv: [], tvType: ['Documentary'], terms: ['Documental', 'Documentary'], re: /document/i },
  drama: { label: 'Drama', tv: ['Drama'], terms: ['Drama'], re: /drama/i },
  acción: { label: 'Acción', tv: ['Action', 'Adventure'], terms: ['Acción', 'Action'], re: /acci[oó]n|action/i }
};
export const mediaGenreTags = text => Object.keys(MEDIA_GENRES).filter(k => MEDIA_GENRES[k].re.test(String(text || ''))).map(k => 'mediagenre:' + k);

// Máximo de favoritos que se guardan en la cuenta (el servidor aplica el mismo tope).
export const MAX_FAVORITES = 500;

// ---------- Contenido para adultos ----------
// Es una heurística: puede dejar pasar o esconder algo. Se apoya, en orden de fiabilidad, en:
//   1) la clasificación que trae la fuente (Steam: edad requerida y descriptores; iTunes: clasificación de la película);
//   2) palabras claras en el título o resumen de noticias y juegos.
// Las palabras son deliberadamente pocas y específicas: antes «gore» escondía una nota sobre el director Gore Verbinski
// y «sexual…» escondía cualquier noticia sobre acoso sexual.
const ADULT_RE = new RegExp([
  '\\b(?:porn\\w*|hentai|nsfw|xxx|erotic\\w*|nudity|nudes?|adults? only|onlyfans|brothel|18\\+|\\+18)\\b',
  '\\b(?:sexually explicit|explicit sexual|sexual content|sexual themes)\\b',
  'er[oó]tic|desnud|solo (?:para )?adultos|contenido (?:sexual|expl[ií]cito|para adultos)'
].join('|'), 'i');

// Descriptores de contenido de Steam (appdetails → content_descriptors.ids):
//   1 algo de desnudez o contenido sexual · 2 violencia o gore frecuentes · 3 contenido sexual solo para adultos
//   4 desnudez o contenido sexual frecuentes · 5 contenido maduro en general.
// Se consideran «adultos» el 3 y el 4. El 2 (violencia) NO se oculta: lo llevan muchos juegos populares de acción y el
// texto de Perfil ya no promete ocultarlo. Verificar contra la documentación vigente de Steam antes de cambiar esto.
export const STEAM_ADULT_DESCRIPTORS = [3, 4];
export const steamAdult = d => Number(d?.required_age) >= 18 || (d?.content_descriptors?.ids || []).some(n => STEAM_ADULT_DESCRIPTORS.includes(n));

// Clasificaciones de película de iTunes que se consideran solo para adultos. «R» no entra: es «17+» y escondería
// gran parte del catálogo común. Sin verificar contra respuestas reales de iTunes (ver README).
const ADULT_RATINGS = /^(?:nc-?17|x|tv-?ma|18\+?|r18|\+18)$/i;
export const movieAdult = rating => ADULT_RATINGS.test(String(rating || '').trim());

// Letra explícita en canciones: se marca (insignia «Explícito») pero NO se oculta por defecto, porque esconderla vaciaría
// casi todo el hip-hop de las listas para quien no tocó el ajuste. Cambiar a true para ocultarla junto con el resto.
export const HIDE_EXPLICIT_SONGS = false;

export const isAdult = it => {
  if (!it) return false;
  if (it.adult === true) return true;
  if (it.type === 'song') return HIDE_EXPLICIT_SONGS && it.explicit === true;
  if (it.type === 'movie') return false; // la marca (adult) la pone el servidor según la clasificación
  return (it.type === 'news' || it.type === 'game') && ADULT_RE.test(`${it.title || ''} ${it.summary || ''}`);
};

// Texto legible de una etiqueta: "gamegenre:terror" -> "Terror".
const NAMES = { ...Object.fromEntries(Object.entries(MUSIC_GENRES).map(([k, v]) => [k, v.label])),
  ...Object.fromEntries(Object.entries(GAME_GENRES).map(([k, v]) => [k, v.label])),
  ...Object.fromEntries(Object.entries(PLATFORMS).map(([k, v]) => [k, v.label])),
  ...Object.fromEntries(Object.entries(MEDIA_GENRES).map(([k, v]) => [k, v.label])) };
export const tagLabel = tag => { const name = String(tag).split(':').slice(1).join(':'); return NAMES[name] || (name ? name[0].toUpperCase() + name.slice(1) : ''); };
