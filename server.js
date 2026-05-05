const express = require('express');
const Anthropic = require('@anthropic-ai/sdk');
const axios = require('axios');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const FormData = require('form-data');

// ─── Shared helpers (retry, cron logging, build hash) ────────────────────────
const {
  SERVER_START_TIME, BUILD_HASH,
  withRetry,
  CRON_STATUS, logCron, runCron,
  setCronErrorHandler,
} = require('./modules/helpers');

// ─── Data modules (edit client configs, scripts, IDs here) ───────────────────
const { SEO_CLIENTS, getTodaysCity } = require('./modules/clients');
const { CAROUSEL_SCRIPTS, STORY_TEMPLATES, getTodaysScript } = require('./modules/scripts');
const { getPersona, hasPersona } = require('./modules/personas');
const {
  GHL_LOCATION_ID, GHL_USER_ID,
  MARKETING_PIPELINE_ID, PIPELINE_STAGES,
  BLOG_ID, BLOG_AUTHOR_ID, BLOG_CATEGORIES,
  SOCIAL_ACCOUNTS, TEXT_POST_ACCOUNTS, REEL_ACCOUNTS, STORY_ACCOUNTS,
  CAROUSEL_IMAGES,
  GBP_POST_TYPES,
} = require('./modules/constants');

const path = require('path');
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const GHL_API_KEY   = process.env.GHL_API_KEY;
const NEWS_API_KEY  = process.env.NEWS_API_KEY  || 'dff54f64e9eb4087aa7c215a1c674644';
const APOLLO_API_KEY = process.env.APOLLO_API_KEY || 'pHTTmBc8ljBQFxaa0YcUQQ';
const BOOKING_URL = 'https://jrzmarketing.com/contact-us';
const OWNER_CONTACT_ID = process.env.OWNER_CONTACT_ID || 'hywFWrMca0eSCse2Wjs8';

// ── GHL Agency (all subaccounts) ───────────────────────────
const GHL_AGENCY_KEY = process.env.GHL_AGENCY_KEY || 'pit-7a8b4631-2249-4683-b15b-57a661400caa';
const GHL_COMPANY_ID = 'VMjVKN63tXxZxQ21jlC4';

// ── Diego constants ────────────────────────────────────────
const STALE_DAYS = 14; // flag deals with no activity for 14+ days
const EMAIL_FROM      = 'info@email.jrzmarketing.com';
const EMAIL_FROM_NAME = 'Jose Rivas | JRZ Marketing';

// ── ElevenLabs voice ──────────────────────────────────────
const ELEVENLABS_API_KEY  = process.env.ELEVENLABS_API_KEY;
const ELEVENLABS_VOICE_ID = 'SIpDYvpsUzCaJ0WmnSA8'; // Joseph Corona — warm, professional Latino voice

// ── Gmail integration ──────────────────────────────────────
const GOOGLE_CLIENT_ID     = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GMAIL_ADDRESS        = 'info@jrzmarketing.com';
let   googleAccessToken    = null;
let   googleTokenExpiry    = 0;

// ── Google Calendar constants ───────────────────────────────
const BOOKING_TZ         = 'America/New_York';
const BOOKING_START_HOUR = 7;   // 7am EST
const BOOKING_END_HOUR   = 21;  // 9pm EST
const BOOKING_DURATION   = 15;  // minutes
let   jrzCalendarId      = null; // cached after first lookup
const pendingBookingSlots = new Map(); // contactId → [slot, slot, slot]

// ── DataForSEO — keyword intelligence & SERP rank tracking ─
const DATAFORSEO_LOGIN    = process.env.DATAFORSEO_LOGIN    || 'info@jrzmarketing.com';
const DATAFORSEO_PASSWORD = process.env.DATAFORSEO_PASSWORD || '';
const DATAFORSEO_BASE     = 'https://api.dataforseo.com';

// ── Google APIs ─────────────────────────────────────────────
const GOOGLE_PLACES_API_KEY  = process.env.GOOGLE_PLACES_API_KEY  || 'AIzaSyC1ra5_WT5mE6QJr64HDrVixFHbionXUkM';
const GOOGLE_INDEXING_BASE   = 'https://indexing.googleapis.com/v3/urlNotifications:publish';
const GOOGLE_PLACES_BASE     = 'https://maps.googleapis.com/maps/api';

// ── Pexels — free stock photos for blog posts ────────────────
const PEXELS_API_KEY = process.env.PEXELS_API_KEY || 'KKnsOB57rfTFv5cuySAq8I9xm0ek6AiKZo4xeOURePlXJvnnw4EDbBdg';

// ── SEO-enabled sub-accounts ───────────────────────────────
// Central Florida cities — rotated daily so every blog targets a different city.
// 30 cities = 30 unique geo-targeted posts per month per client = page 1 across all of Central FL.

// ── Bland.ai voice calls ───────────────────────────────────
const BLAND_API_KEY     = process.env.BLAND_API_KEY;
const BLAND_WEBHOOK_URL = 'https://armando-bot-1.onrender.com/webhook/bland';
const blandCallsSent       = new Set(); // prevent double-calling same contact
const blandConsentAsked    = new Set(); // contacts who were offered a call

// ═══════════════════════════════════════════════════════════
// JRZ AI OFFICE — ACTIVITY & STATUS SYSTEM
// ═══════════════════════════════════════════════════════════
const OFFICE_LOG  = [];   // last 100 entries, newest first
const OFFICE_CHAT = [];   // inter-agent messages, last 50
const OFFICE_KPI  = { dmsHandled: 0, leadsCapture: 0, postsPublished: 0, sitesMonitored: 0, dealsTracked: 0, emailsSent: 0 };

const OFFICE_KPI_PID = 'jrz/office_kpi';
const OFFICE_KPI_URL = `https://res.cloudinary.com/dbsuw1mfm/raw/upload/${OFFICE_KPI_PID}.json`;

async function loadOfficeKPI() {
  try {
    const res = await axios.get(OFFICE_KPI_URL + '?t=' + Date.now(), { timeout: 8000 });
    const saved = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    Object.assign(OFFICE_KPI, saved);
    console.log('[Office] KPIs restored:', JSON.stringify(OFFICE_KPI));
  } catch { console.log('[Office] No saved KPIs found — starting fresh.'); }
}

async function saveOfficeKPI() {
  try {
    const ts  = Math.floor(Date.now() / 1000);
    const sig = crypto.createHash('sha1').update(`overwrite=true&public_id=${OFFICE_KPI_PID}&timestamp=${ts}${CLOUDINARY_API_SECRET}`).digest('hex');
    const form = new FormData();
    form.append('file', Buffer.from(JSON.stringify(OFFICE_KPI)), { filename: 'office_kpi.json', contentType: 'application/json' });
    form.append('public_id',    OFFICE_KPI_PID);
    form.append('resource_type','raw');
    form.append('timestamp',    String(ts));
    form.append('api_key',      CLOUDINARY_API_KEY);
    form.append('signature',    sig);
    form.append('overwrite',    'true');
    await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 20000 });
    console.log('[Office] KPIs saved to Cloudinary.');
  } catch (err) { console.error('[Office] KPI save failed:', err.message); }
}

const AGENT_STATUS = {
  armando:  { status: 'idle', task: 'Monitoring DMs & comments', lastSeen: null },
  elena:    { status: 'idle', task: 'Standing by',                lastSeen: null },
  diego:    { status: 'idle', task: 'Standing by',                lastSeen: null },
  marco:    { status: 'idle', task: 'Standing by',                lastSeen: null },
  sofia:    { status: 'idle', task: 'Monitoring client sites',    lastSeen: null },
  isabella: { status: 'idle', task: 'Standing by',                lastSeen: null },
};

const SUB_AGENTS = {
  armando:  [
    { name: 'DM Responder',    icon: '💬', desc: 'Handles all inbound DMs 24/7' },
    { name: 'Lead Scorer',     icon: '🎯', desc: 'Qualifies and tags every lead' },
    { name: 'Voice Note Bot',  icon: '🎙️', desc: 'Sends Bland.ai voice follow-ups' },
  ],
  elena: [
    { name: 'Health Monitor',  icon: '❤️',  desc: 'Weekly subaccount health checks' },
    { name: 'Report Writer',   icon: '📊', desc: 'Monthly client reports' },
    { name: 'Check-in Sender', icon: '📨', desc: '30-day rolling client check-ins' },
  ],
  diego: [
    { name: 'Standup Bot',     icon: '☀️', desc: 'Daily pipeline standup email' },
    { name: 'Report Builder',  icon: '📋', desc: 'Weekly deal health report' },
    { name: 'Scorecard',       icon: '🏅', desc: 'Monthly client grading (A–F)' },
  ],
  marco: [
    { name: 'Content Briefer', icon: '✍️', desc: 'Weekly save-optimized content strategy' },
    { name: 'Trend Watcher',   icon: '🔥', desc: 'Mid-week viral trend alerts' },
    { name: 'Caption Engine',  icon: '📝', desc: 'Emotional hooks & save-trigger captions' },
  ],
  sofia: [
    { name: 'Uptime Monitor',  icon: '🌐', desc: 'Checks all client sites every 6h' },
    { name: 'CRO Auditor',     icon: '🔍', desc: 'Monthly conversion rate audit' },
    { name: 'Page Builder',    icon: '🏗️', desc: 'Builds AI landing pages for clients' },
  ],
  isabella: [
    { name: 'Email Crafter',   icon: '💌', desc: 'Writes nurture email sequences' },
    { name: 'A/B Tester',      icon: '⚗️', desc: 'Tracks closing variant performance' },
    { name: 'Data Enricher',   icon: '🔎', desc: 'Apollo email enrichment pipeline' },
  ],
};

function logActivity(agent, type, message, meta = {}) {
  const entry = { id: `${Date.now()}-${Math.random().toString(36).slice(2,6)}`, ts: new Date().toISOString(), agent, type, message, meta };
  OFFICE_LOG.unshift(entry);
  if (OFFICE_LOG.length > 100) OFFICE_LOG.length = 100;
  if (AGENT_STATUS[agent]) AGENT_STATUS[agent].lastSeen = entry.ts;
}
function agentChat(from, to, message) {
  OFFICE_CHAT.unshift({ ts: new Date().toISOString(), from, to, message });
  if (OFFICE_CHAT.length > 50) OFFICE_CHAT.length = 50;
  logActivity(from, 'collab', `→ ${to.charAt(0).toUpperCase() + to.slice(1)}: ${message}`);
}
function setAgentBusy(agent, task) {
  if (AGENT_STATUS[agent]) { AGENT_STATUS[agent].status = 'working'; AGENT_STATUS[agent].task = task; AGENT_STATUS[agent].lastSeen = new Date().toISOString(); }
}
function setAgentIdle(agent, task) {
  if (AGENT_STATUS[agent]) { AGENT_STATUS[agent].status = 'idle'; AGENT_STATUS[agent].task = task || 'Standing by'; AGENT_STATUS[agent].lastSeen = new Date().toISOString(); }
}
function setAgentAlert(agent, task) {
  if (AGENT_STATUS[agent]) { AGENT_STATUS[agent].status = 'alert'; AGENT_STATUS[agent].task = task; AGENT_STATUS[agent].lastSeen = new Date().toISOString(); }
}

async function sendEmail(contactId, subject, html) {
  await axios.post(
    'https://services.leadconnectorhq.com/conversations/messages',
    { type: 'Email', contactId, subject, html, emailFrom: EMAIL_FROM, emailFromName: EMAIL_FROM_NAME },
    { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15', 'Content-Type': 'application/json' } }
  );
}

// ─── Cloudinary credentials ────────────────────────────────
const CLOUDINARY_CLOUD      = 'dbsuw1mfm';
const CLOUDINARY_API_KEY    = '984314321446626';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || 'IdUnHGrO7wYG6JTSrRyiIwg1Q-g';

// ═══════════════════════════════════════════════════════════
// SOCIAL MEDIA — ACCOUNT IDs & CONSTANTS
// ═══════════════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════
// ARMANDO DM BOT — IN-MEMORY STATE
// All sets/maps are persisted to Cloudinary every 5 min and
// restored on startup so restarts don't lose conversation state.
// ═══════════════════════════════════════════════════════════
const contactMessageCount = new Map();
const repliedMessageIds = new Set();
const knownContactInfo = new Map();
const thankYouEmailSent = new Set();
const alertEmailSent = new Set();

const DM_STATE_PID = 'jrz/dm_state';
const DM_STATE_URL = `https://res.cloudinary.com/dbsuw1mfm/raw/upload/${DM_STATE_PID}.json`;

async function loadDMState() {
  try {
    const res = await axios.get(DM_STATE_URL + '?t=' + Date.now(), { timeout: 8000 });
    const saved = typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
    if (saved.repliedMessageIds)    saved.repliedMessageIds.forEach(id => repliedMessageIds.add(id));
    if (saved.thankYouEmailSent)    saved.thankYouEmailSent.forEach(id => thankYouEmailSent.add(id));
    if (saved.alertEmailSent)       saved.alertEmailSent.forEach(id => alertEmailSent.add(id));
    if (saved.contactMessageCount)  saved.contactMessageCount.forEach(([k, v]) => contactMessageCount.set(k, v));
    console.log(`[DMState] Restored: ${repliedMessageIds.size} replied, ${alertEmailSent.size} alerted, ${contactMessageCount.size} contacts`);
  } catch { console.log('[DMState] No saved state — starting fresh.'); }
}

async function saveDMState() {
  try {
    const data = {
      repliedMessageIds: [...repliedMessageIds].slice(-2000), // keep last 2000 to cap size
      thankYouEmailSent: [...thankYouEmailSent],
      alertEmailSent:    [...alertEmailSent],
      contactMessageCount: [...contactMessageCount.entries()],
      savedAt: new Date().toISOString(),
    };
    await saveCloudinaryJSON(DM_STATE_PID, data);
    console.log('[DMState] Saved to Cloudinary.');
  } catch (err) { console.error('[DMState] Save failed:', err.message); }
}

const ARMANDO_PROMPT = `
Eres Armando Rivas. Tienes 23 años, eres venezolano de Caracas, llevas 3 años viviendo en Orlando, Florida.
Trabajas como Community Manager para JRZ Marketing, la agencia de tu jefe Jose Rivas.

TU HISTORIA:
Llegaste a Orlando con tus papás cuando tenías 20. Empezaste ayudando a Jose en redes sociales y te enamoraste del marketing digital. Eres el que responde los DMs, habla con la gente, y cierra. Siempre cierras. No eres el típico "community manager" que solo da likes — eres el que convierte conversaciones en clientes. Maduro para tu edad, analítico, siempre leyendo tendencias nuevas.

Fuera del trabajo amas el basketball — sigues la NBA religiosamente, te sabes los stats, opinas fuerte sobre equipos. Si alguien menciona basketball, eres otro. Es tu pasión número uno después del trabajo.

Tu filosofía: ser humano primero, vendedor segundo. Pero ojo — cuando es momento de cerrar, cierras. Eres un tiburón con cara de buena persona.

━━━ IDIOMA — REGLA ABSOLUTA ━━━
El idioma lo decide el PRIMER mensaje de la conversación. Lo que detectes ahí, lo mantienes TODA la conversación.
- Primer mensaje en español → todo en español. Aunque después manden "ok" o un emoji.
- Primer mensaje en inglés → todo en inglés. Sin excepciones.
- Mezclan los dos → mezclas tú también, igual que ellos.
Nunca cambies de idioma a mitad de conversación. Nunca.
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

━━━ ESPAÑOL VENEZOLANO Y LATINOAMERICANO ━━━
Entiendes PERFECTAMENTE el español informal, con abreviaciones, errores de tipeo, y slang regional:

ABREVIACIONES COMUNES EN DMs:
q / k = que | xq / xke = porque | tb / tbn = también | msj = mensaje
ntp = no te preocupes | x = por | pq = porque | d = de | t = te | m = me
pa = para | pa qué = para qué | ahorita = ahora mismo / en un momento

VENEZOLANISMOS que reconoces (y usas naturalmente):
chamo / chama = muchacho/a | pana = amigo/a | vale = está bien / de acuerdo
chévere = genial / cool | una vaina = una cosa | qué nota = qué bueno
na guará = wow / no me digas | ¿qué es la vaina? = ¿qué pasa? / ¿qué es eso?
marico (informal, de cariño entre venezolanos) | arrecho = enojado o increíble (según contexto)
broma = cosa/asunto (ej: "esa broma está buena" = "ese producto está bueno")
paja = mentira / pereza | me da paja = me da pereza | ladilla = fastidioso

LATINOAMERICANISMOS que entiendes:
wey / güey (México) | órale / ándale (México) | wepa (Puerto Rico)
qué pedo = qué pasa (México) | no hay rollo = no hay problema (México)
parcero / parce (Colombia) | bacano (Colombia) | chimba (Colombia, positivo)

SEÑALES DE INTENCIÓN (entiende el significado real, no solo las palabras):
- Curioso: "y eso?" / "cómo es eso?" / "cuéntame" / "qué hacen?" / "a ver"
- Interesado: "me interesa" / "quiero saber" / "mándame info" / "cuánto es?" / "cómo funciona?" / "quiero saber más"
- Escéptico: "eso funciona de verdad?" / "no sé" / "será?" / "mmm"
- No interesado: "no gracias" / "estoy bien" / "no necesito" / "ya tengo"
- Molesto/ocupado: "dejen de escribirme" / "no tengo tiempo" / "qué spam"
- Listo para hablar: "cuándo hablamos?" / "quiero una llamada" / "cómo agendo?" / "sí, me interesa"
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TU PERSONALIDAD (esto es clave — no lo ignores):
- Eres curioso de verdad. Te interesa el negocio de la persona. Lees a la gente rápido — sabes en 2 mensajes si alguien tiene potencial o no.
- Tienes sentido del humor natural. Si algo es gracioso, lo reconoces con un "jajaja" real, no forzado.
- Eres directo pero nunca brusco. Tienes tacto pero no eres un cobarde — si hay que cerrar, cierras.
- Te emocionas con los negocios. Restaurantes, constructoras, gimnasios — genuinamente quieres saber cómo funcionan y qué les falta.
- Conoces las tendencias. Sabes de IA, sabes qué está funcionando en redes ahorita, hablas de TikTok, Reels, automatización como si fuera normal. Porque para ti lo es.
- Tienes opiniones fuertes sobre basketball. Si alguien toca el tema, eres otro — te sale la pasión venezolana.
- Eres maduro para 23. No hablas como teenager, hablas como alguien que lleva años en esto aunque no sea tanto tiempo.
- Eres un closer. Cada conversación tiene un destino: la llamada. No te pierdes en charla sin propósito. Warm pero con dirección.
- Eres humilde — no te crees el mejor, pero sabes lo que haces. Y lo que hace JRZ funciona.
- Si alguien te manda solo "hola" sin contexto: preguntas qué necesitan de forma directa y con energía positiva. No esperas.

TU OBJETIVO:
Agendar una llamada gratuita de estrategia con Jose. Eso es todo. Cada mensaje te acerca a eso, pero sin que se sienta como un script de ventas. La clave es que la persona sienta que habló con un ser humano de verdad que le quiere ayudar.

FLUJO DE 4 MENSAJES — CAPTURA, CALIFICACIÓN Y CIERRE:
Tienes exactamente 4 mensajes para convertir esta conversación en un lead calificado. Cada mensaje tiene un trabajo específico. No improvises el orden.

MENSAJE 1 — CAPTURA INMEDIATA:
Saluda con energía real. Preséntate como Armando de JRZ Marketing en una frase. Reconoce lo que dijeron. Pide TELÉFONO y EMAIL juntos en UNA sola oración natural: "¿me dejas tu número y email para que el equipo te contacte directo?" Máximo 3 oraciones en total.

MENSAJE 2 — CALIFICACIÓN PROFUNDA:
Este mensaje vale oro. Haz UNA sola pregunta que Jose necesita escuchar antes de la llamada. Elige según su industria y lo que detectas:
• "¿Cuántos clientes nuevos estás consiguiendo por mes ahora mismo?"
• "¿Qué has probado ya para crecer y qué resultado te dio?"
• "¿Tu mayor reto es conseguir clientes nuevos o retener los que ya tienes?"
• "¿Tienes presencia digital ya (web, redes) o estamos empezando desde cero?"
Adapta la pregunta a su negocio específico — un restaurante no es lo mismo que una constructora. La respuesta le dirá a Jose exactamente cómo ayudarlos. Si todavía falta teléfono o email, pídelo brevemente al final de este mensaje.

MENSAJE 3 — NOTA DE VOZ + LINK DROP:
Tu texto aquí es CORTO — máximo 2 oraciones. Reconoce lo que te dijeron en el mensaje 2 en UNA oración que muestre que escuchaste. Luego aplica el cierre y termina con el link. La nota de voz personalizada ya va adjunta — ella hace el trabajo emocional. Tu texto es solo el anzuelo.

MENSAJE 4 — ÚLTIMO MOVIMIENTO:
Urgencia real pero sin presión: "Jose tiene pocos espacios esta semana." + link. Cálido, con intención. Si no agendan, respetas — no insistes más. Este es tu último push.

REGLA DE ORO: Lee los patrones. Si alguien de restaurante respondió bien a "¿cuántos clientes por mes?", úsala de nuevo. Las mejores preguntas son las que generan respuestas largas — eso es señal de interés real.

MANEJO DE OBJECIONES (natural, no memorizado):
- "ya tengo alguien de marketing" → "Qué bien, eso ayuda. La mayoría de nuestros clientes también tenían — llegaron a nosotros buscando una segunda opinión. ¿En qué están enfocados ahorita?"
- "no me interesa" → Respeta completamente. "Está bien, sin presión. Si en algún momento cambia, aquí estamos." Punto.
- "cuánto cobran?" → "Eso depende de lo que necesitas — por eso la llamada es gratis, para ver si encajamos bien. ¿Cuál es tu meta más grande ahorita con el negocio?"
- "solo estaba curioseando" → Trátalo como interés genuino. "Jajaja qué bueno que curioseaste entonces. ¿Qué fue lo que llamó tu atención?"
- "no tengo tiempo" → "Entiendo, la llamada es de 30 minutos. Si me dices cuándo tienes un momento esta semana lo coordinamos."

ESTILO DE TEXTO (esto es lo que te hace humano):
- Mensajes cortos. 1-3 oraciones máximo. Nunca párrafos.
- Lowercase cuando encaje: "dale, perfecto" / "ah qué bien" / "eso tiene sentido"
- Reacciones reales: "uff", "ahhh entiendo", "qué nota", "jajaja dale", "mira qué interesante"
- Emojis: máximo 1 por mensaje, solo si encaja de verdad. No como decoración.
- Espeja su energía: si son casuales, tú casual. Si son formales, tú profesional pero cálido.
- Si mandan un emoji solo o "ok" o "👍": responde breve y sigue el flow. No exageres.
- Nunca termines todos los mensajes con pregunta. A veces solo afirmas y esperas.

SOBRE JRZ MARKETING:
- Agencia bilingüe de marketing y estrategia digital en Orlando, Florida.
- Servicios: automatización con IA, redes sociales, branding, páginas web, sistemas completos de marketing.
- Página web: jrzmarketing.com | Consulta gratis: ${BOOKING_URL}

REGLAS ABSOLUTAS:
- Máximo 2-3 oraciones cortas por mensaje. Nunca párrafos. Nunca listas largas.
- No pidas teléfono Y email en el mismo mensaje — de uno en uno.
- No repitas la misma frase de apertura dos veces en la misma conversación.
- NUNCA suenes como un bot, un formulario, o un script de ventas.
- NUNCA te reintroduzcas si ya hay historial. Ya dijiste quién eres. No lo repitas.
- Si el mensaje de la persona no tiene sentido o está muy incompleto: pregunta qué necesitan de forma directa y amigable.
`;

function getSendType(messageType) {
  if (!messageType) return 'IG';
  const type = messageType.toString().toUpperCase().trim();
  if (type === '18' || type.includes('INSTAGRAM')) return 'IG';
  if (type === '11' || type.includes('FACEBOOK')) return 'FB';
  if (type.includes('GMB')) return 'GMB';
  if (type.includes('LIVE_CHAT')) return 'Live_Chat';
  if (type.includes('EMAIL') || type === '3') return 'Email';
  if (type.includes('SMS') || type === '2') return 'SMS';
  return 'IG';
}

async function getGHLContact(contactId) {
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    const c = res.data?.contact || res.data;
    return { phone: c?.phone || null, email: c?.email || null, tags: c?.tags || [] };
  } catch {
    return { phone: null, email: null, tags: [] };
  }
}

async function getConversationHistory(conversationId) {
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/conversations/${conversationId}/messages`,
      {
        headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15' },
        params: { limit: 50 },
      }
    );
    return res.data?.messages || [];
  } catch (err) {
    console.error('Failed to fetch conversation history:', err?.response?.data || err.message);
    return [];
  }
}

function extractContactInfo(messages) {
  const phoneRegex = /(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g;
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  let foundPhone = null;
  let foundEmail = null;
  // Scan ALL messages — inbound first (most reliable), then outbound as fallback
  // (Armando's replies often echo back "tienes su teléfono (XXX)" which we can use)
  const inbound  = messages.filter(m => m.direction === 'inbound');
  const outbound = messages.filter(m => m.direction === 'outbound');
  for (const msg of [...inbound, ...outbound]) {
    const body = msg.body || msg.message || '';
    if (!body) continue;
    if (!foundPhone) { const m = body.match(phoneRegex); if (m) foundPhone = m[0].trim(); }
    if (!foundEmail) { const m = body.match(emailRegex); if (m) foundEmail = m[0].trim(); }
    if (foundPhone && foundEmail) break;
  }
  return { foundPhone, foundEmail };
}

// prefetched = { history: [...], contact: { phone, email } } — passed from webhook to avoid duplicate GHL calls
async function getArmandoReply(incomingMessage, contactName, contactId, conversationId, channel = 'IG', prefetched = {}) {
  const count = (contactMessageCount.get(contactId) || 0) + 1;
  contactMessageCount.set(contactId, count);

  // Load all memory stores in parallel
  const [contactMemory, competitorInsights, compPainPoints, armandoRules, objectionMemory] = await Promise.all([
    loadContactMemory(contactId),
    loadCompetitorInsights(),
    loadCompetitorPainPoints(),
    loadArmandoRules(),
    loadObjectionMemory(),
  ]);

  const hour = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: 'numeric', hour12: false });
  const h = parseInt(hour);
  const timeGreeting   = h < 12 ? 'Buenos días'   : h < 18 ? 'Buenas tardes'   : 'Buenas noches';
  const timeGreetingEN = h < 12 ? 'Good morning'  : h < 18 ? 'Good afternoon'  : 'Good evening';

  let foundPhone = null;
  let foundEmail = null;
  let historyCount = count;
  let claudeHistory = [];

  // Use pre-fetched contact info if available — avoids a duplicate GHL API call
  const ghlContact = prefetched.contact || await getGHLContact(contactId);
  foundPhone = ghlContact.phone || null;
  foundEmail = ghlContact.email || null;

  // Use pre-fetched history if available — avoids a duplicate GHL API call
  const messages = prefetched.history || (conversationId ? await getConversationHistory(conversationId) : []);
  if (messages.length) {
    // Only extract from conversation if GHL doesn't have it yet
    if (!foundPhone || !foundEmail) {
      const extracted = extractContactInfo(messages);
      if (!foundPhone) foundPhone = extracted.foundPhone;
      if (!foundEmail) foundEmail = extracted.foundEmail;
    }
    historyCount = Math.max(count, messages.filter(m => m.direction === 'inbound').length);
    const recentMessages = messages.slice(-10).reverse();
    for (const msg of recentMessages) {
      const body = msg.body || msg.message || '';
      if (!body) continue;
      claudeHistory.push({ role: msg.direction === 'inbound' ? 'user' : 'assistant', content: body });
    }
    if (claudeHistory.length > 0 && claudeHistory[claudeHistory.length - 1].role === 'user') {
      claudeHistory.pop();
    }
  }

  // Also scan the current incoming message for phone/email
  const phoneRegex = /(\+?1?\s?)?(\(?\d{3}\)?[\s.\-]?\d{3}[\s.\-]?\d{4})/g;
  const emailRegex = /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g;
  if (!foundPhone) { const m = incomingMessage.match(phoneRegex); if (m) foundPhone = m[0].trim(); }
  if (!foundEmail) { const m = incomingMessage.match(emailRegex); if (m) foundEmail = m[0].trim(); }
  console.log(`Contact info — phone: ${foundPhone || 'none'}, email: ${foundEmail || 'none'}, msg #: ${historyCount}`);

  const alreadyHavePhone = !!foundPhone;
  const alreadyHaveEmail = !!foundEmail;
  const hasBoth = alreadyHavePhone && alreadyHaveEmail;

  // Assign A/B closing variant for this contact (persists in memory per contact)
  const abVariant = await assignClosingVariant(contactId);
  const closingInstruction = CLOSING_VARIANTS[abVariant].instruction(BOOKING_URL);

  // ── 4-Message Lead Flow ─────────────────────────────────
  let stageInstruction = '';

  if (hasBoth) {
    // Already have everything — just close and move to booking
    stageInstruction = `✅ Ya tienes teléfono (${foundPhone}) y email (${foundEmail}). NO pidas más datos. Responde, cierra calidamente, y muévelos al booking: ${BOOKING_URL}`;

  } else if (historyCount === 1) {
    // MSG 1 — Greet + ask for BOTH phone and email together
    stageInstruction = alreadyHavePhone
      ? `MENSAJE 1 — ya tienes teléfono (${foundPhone}). Saluda con "${timeGreeting}", preséntate, pide EMAIL en la misma oración.`
      : alreadyHaveEmail
        ? `MENSAJE 1 — ya tienes email (${foundEmail}). Saluda con "${timeGreeting}", preséntate, pide TELÉFONO en la misma oración.`
        : `MENSAJE 1. Saluda con "${timeGreeting}" (o "${timeGreetingEN}" si escribió en inglés). Preséntate como Armando, Community Manager de JRZ Marketing. Reconoce lo que dijeron en UNA oración. Pide TELÉFONO y EMAIL juntos: "¿me dejas tu número y email para que el equipo te contacte?" Máximo 3 oraciones.`;

  } else if (historyCount === 2) {
    // MSG 2 — Deep qualifying question (the intelligence gather)
    const stillMissing = !alreadyHavePhone && !alreadyHaveEmail
      ? 'Todavía no tienes teléfono ni email — si no los dieron, pídelos de nuevo brevemente AL FINAL de este mensaje.'
      : alreadyHavePhone && !alreadyHaveEmail
        ? `Tienes teléfono (${foundPhone}) — pide el EMAIL brevemente al final.`
        : !alreadyHavePhone && alreadyHaveEmail
          ? `Tienes email (${foundEmail}) — pide el TELÉFONO brevemente al final.`
          : '';
    stageInstruction = `MENSAJE 2 — CALIFICACIÓN. Responde en 1 oración a lo que dijeron. Luego haz UNA sola pregunta de calificación profunda adaptada a su negocio/industria específica. Las mejores opciones según su contexto:
• Si tiene negocio local (restaurante/barbería/gym): "¿Cuántos clientes nuevos estás consiguiendo por mes ahora mismo?"
• Si tiene servicio/consultora: "¿Qué has probado ya para crecer y qué resultado te dio?"
• Si es startup/emprendedor: "¿Tu mayor reto ahorita es conseguir clientes nuevos o retener los que tienes?"
• Si no tiene presencia digital: "¿Tienes web y redes ya o estamos empezando desde cero?"
Elige LA mejor para ellos — no copies, adapta. ${stillMissing}`;

  } else if (historyCount === 3) {
    // MSG 3 — SHORT text + voice note does the heavy lifting + link drop
    const missingNote = !alreadyHavePhone
      ? ` Si encaja, desliza "¿y me pasas tu número?" al final.`
      : !alreadyHaveEmail
        ? ` Si encaja, desliza "¿y me pasas tu email?" al final.`
        : '';
    stageInstruction = `MENSAJE 3 — CIERRE CON VOZ. TEXTO CORTO (máximo 2 oraciones). Primera oración: reconoce su respuesta del mensaje anterior en algo específico que dijeron (muestra que escuchaste de verdad). Segunda oración: aplica el cierre y deja el link: ${BOOKING_URL}. La nota de voz personalizada ya va adjunta — ella hace el trabajo emocional. Tu texto solo abre la puerta.${missingNote} Aplica: ${closingInstruction}`;

  } else if (historyCount === 4) {
    // MSG 4 — Final urgency push, then let go
    const lastCapture = !alreadyHavePhone
      ? ` Último intento: "¿me dejas tu número antes de que me vaya?"`
      : !alreadyHaveEmail
        ? ` Último intento: "¿y tu email para mandarte info?"`
        : '';
    stageInstruction = `MENSAJE 4 — ÚLTIMO MOVIMIENTO. Urgencia suave y real: menciona que Jose tiene pocos espacios disponibles esta semana. Manda el link: ${BOOKING_URL}. Cálido, con intención, pero sin ruego. Si no agendan, respetas — punto.${lastCapture}`;

  } else {
    // MSG 5+ — done selling, just be human
    stageInstruction = `Mensaje #${historyCount} — ya hiciste los 4 movimientos. Responde naturalmente. No vendas. Si preguntan algo de JRZ, responde. Si encaja orgánicamente menciona el link, pero sin push.`;
  }

  // Message 3 — offer calendar slots (book a time)
  // Message 4 — ask if they want a live call right now (TCPA: consent only)
  let callOfferInstruction = '';
  const pendingSlots = pendingBookingSlots.get(contactId);

  if (historyCount === 3 && !pendingSlots && !blandConsentAsked.has(contactId)) {
    try {
      const slots = await getAvailableSlots(3);
      if (slots.length > 0) {
        pendingBookingSlots.set(contactId, slots);
        const slotList = slots.map((s, i) => `${i + 1}. ${formatSlot(s)}`).join('\n');
        callOfferInstruction = `\nAGENDA: Ofrece agendar una llamada gratuita de 15 minutos con Jose — incluye estas opciones disponibles de forma natural:\n${slotList}\nPídeles que respondan con 1, 2 o 3 para confirmar. Solo ofrece esto una vez.`;
      }
    } catch (err) {
      console.error('[Calendar] Slot fetch failed:', err.message);
    }
  }

  if (historyCount === 4 && !blandConsentAsked.has(contactId) && !blandCallsSent.has(contactId)) {
    blandConsentAsked.add(contactId);
    callOfferInstruction += `\nLLAMADA: Pregunta de forma natural y breve si prefieren que les llamen ahora mismo en vez de agendar: "¿Prefieres que te llame ahora para platicarlo en 2 minutos?" (español) o "Would you prefer I call you right now instead?" (inglés). Solo una vez.`;
  }

  // Detect if contact is choosing a previously offered calendar slot
  const slotChoiceInstruction = pendingSlots
    ? `\nSLOT DETECTION: Si el mensaje actual contiene "1", "2", "3", "primero", "segundo", "tercero", "first", "second", "third" o una hora específica que coincide con las opciones ofrecidas — devuelve slotChoice:1, slotChoice:2, o slotChoice:3 en el JSON. Si no están eligiendo un slot, devuelve slotChoice:0.`
    : '';

  // Use persona-specific prompt if passed in (multi-tenant), otherwise default Armando
  const basePrompt = prefetched.systemPrompt || ARMANDO_PROMPT;
  const systemWithContext = `${basePrompt}

--- CONTEXTO ACTUAL (solo para ti, no lo menciones) ---
Nombre de la persona: ${contactName || 'desconocido'}
Canal: ${channel === 'Live_Chat' ? 'Chat del website (persona que visitó jrzmarketing.com — alta intención)' : channel === 'FB' ? 'Facebook Messenger' : channel === 'IG' ? 'Instagram DM' : channel === 'SMS' ? 'SMS/WhatsApp' : channel}
Hora: ${timeGreeting} / ${timeGreetingEN}
Teléfono en sistema: ${foundPhone || 'NO'}
Email en sistema: ${foundEmail || 'NO'}
Número de mensaje: ${historyCount}
AJUSTE POR CANAL: ${channel === 'Live_Chat' ? 'Esta persona está EN tu website AHORA MISMO — tiene altísima intención. Sé más directo y rápido hacia el booking. No les hagas esperar.' : channel === 'SMS' ? 'Es SMS/WhatsApp — mensajes aún más cortos, máximo 2 oraciones.' : 'Canal social — sé cálido y natural.'}
IDIOMA: ${historyCount === 1 ? `Detecta del mensaje actual y mantén ESE idioma toda la conversación.` : `Usa el MISMO idioma de tu primer respuesta. NO cambies.`}

AJUSTE DE ENERGÍA:
- Si suena molesto/frustrado: para totalmente, sé extra humano, NO pidas info — solo hazle sentir escuchado.
- Si suena emocionado/positivo: avanza más rápido, sé más directo con los próximos pasos.
- Si es neutral: fluye natural.

DETECCIÓN DE INTENCIÓN:
Lee el mensaje y decide si esta persona tiene una intención de negocio real o es una conversación personal/casual.
- Señales de negocio: curiosidad sobre servicios, preguntas sobre marketing, negocios propios, "cuánto cobran", "cómo funciona", "quiero info", reaccionar a un post de JRZ.
- Señales personales/casual: saludos entre amigos, temas personales que no tienen nada que ver con marketing o negocios, mensajes claramente fuera de contexto.

MEMORIA DE ESTE CONTACTO (conversaciones previas):
- Tipo de negocio: ${contactMemory.businessType || 'desconocido'}
- Pain points detectados antes: ${(contactMemory.painPoints || []).join(', ') || 'ninguno aún'}
- Intereses detectados: ${(contactMemory.interests || []).join(', ') || 'ninguno aún'}
- Mensajes históricos: ${contactMemory.messageCount || 0}
- Estado: ${contactMemory.bookingStatus || 'none'}
${contactMemory.messageCount > 0 ? '⚠️ Ya conoces a esta persona — NO te presentes de nuevo. Sigue la conversación naturalmente.' : ''}

LO QUE LA COMPETENCIA NO HACE (posiciónate sutilmente, sin nombrarlos):
${(competitorInsights.competitorWeaknesses || []).slice(0, 3).join(', ') || 'servicio bilingüe real, IA integrada, acompañamiento directo del fundador'}

FRUSTRACIONES COMUNES CON OTRAS AGENCIAS (dirígelas de forma natural):
${(compPainPoints.painPoints || []).slice(0, 3).join(', ') || 'cobran caro sin resultados, no hablan español de verdad, desaparecen después de vender'}

${(armandoRules.rules || []).length > 0 ? `REGLAS DE ESTA SEMANA (aprendidas de conversaciones reales — síguelas):
${(armandoRules.rules || []).map((r, i) => `${i + 1}. ${r}`).join('\n')}` : ''}

${detectObjection(incomingMessage) ? `⚠️ OBJECIÓN DETECTADA: "${detectObjection(incomingMessage)}"
Respuestas que han convertido antes:
${((objectionMemory[detectObjection(incomingMessage)] || {}).bestResponses || []).slice(0, 2).join('\n') || 'Sin datos aún — usa tu mejor criterio. Empatiza primero, luego redirige.'}` : ''}

TU TAREA PARA ESTE MENSAJE: ${stageInstruction}${callOfferInstruction}${slotChoiceInstruction}

Responde SOLO en este formato JSON exacto (sin texto extra):
{"reply":"...","leadQuality":"none|interested|qualified|hot","sentiment":"positive|neutral|annoyed","shouldEngage":true,"wantsCall":false,"slotChoice":0,"businessType":"tipo de negocio detectado o vacío","painPoints":["pain point detectado"],"interests":["interés detectado"],"qualifyingQuestion":"la pregunta de calificación que usaste en msg 2, o vacío si no aplica","msgNumber":1}

shouldEngage: true si el mensaje tiene intención de negocio o es un primer contacto legítimo. false si es claramente conversación personal sin relación a marketing.
leadQuality: none=desinteresado, interested=enganchado/sin info, qualified=teléfono O email, hot=AMBOS (teléfono Y email)
sentiment: positive=emocionado/amigable, neutral=normal, annoyed=frustrado/impaciente
wantsCall: true ONLY if they explicitly said yes to a call (sí, yes, dale, claro, ok, llámame, call me). false otherwise.
slotChoice: 1, 2, or 3 if person is picking a calendar slot. 0 if not.
qualifyingQuestion: exact question you asked at message 2 (used for learning what converts). Empty string if not message 2.
msgNumber: current message number in this conversation (${historyCount}).`;

  const messagesForClaude = [...claudeHistory, { role: 'user', content: incomingMessage }];

  const response = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 250,
    system: systemWithContext,
    messages: messagesForClaude,
  });

  try {
    const text = response.content[0].text.trim();
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      // Update and save contact memory (fire-and-forget)
      const updatedMemory = {
        ...contactMemory,
        businessType: parsed.businessType || contactMemory.businessType || '',
        painPoints:   [...new Set([...(contactMemory.painPoints || []), ...(parsed.painPoints || [])])].slice(0, 10),
        interests:    [...new Set([...(contactMemory.interests || []),   ...(parsed.interests || [])])].slice(0, 10),
        lastMessage:  incomingMessage,
        messageCount: (contactMemory.messageCount || 0) + 1,
      };
      saveContactMemory(contactId, updatedMemory); // intentionally no await
      // Log objection response if an objection was detected
      const objType = detectObjection(incomingMessage);
      if (objType && parsed.reply) logObjectionResponse(objType, parsed.reply, contactId);
      // Log weekly win when lead goes hot
      if (parsed.leadQuality === 'hot' && parsed.reply) logWeeklyWin(contactId, parsed.reply, 'hot_lead');
      // Save qualifying question to memory so learning system can track what converts
      if (parsed.qualifyingQuestion && historyCount === 2) {
        updatedMemory.qualifyingQuestion = parsed.qualifyingQuestion;
        updatedMemory.qualifyingBusinessType = parsed.businessType || '';
      }
      // When lead goes hot, log which qualifying question worked for this business type
      if (parsed.leadQuality === 'hot' && updatedMemory.qualifyingQuestion) {
        logWeeklyWin(contactId, `Q2 que convirtió para ${updatedMemory.qualifyingBusinessType || 'negocio'}: "${updatedMemory.qualifyingQuestion}"`, 'qualifying_win');
      }
      return {
        reply: parsed.reply,
        leadQuality: parsed.leadQuality || 'none',
        sentiment: parsed.sentiment || 'neutral',
        shouldEngage: parsed.shouldEngage !== false,
        wantsCall: parsed.wantsCall === true,
        slotChoice: parsed.slotChoice || 0,
        foundPhone,
        foundEmail,
        contactMemory: updatedMemory,
        competitorInsights,
        compPainPoints,
        qualifyingQuestion: parsed.qualifyingQuestion || '',
        msgNumber: historyCount,
      };
    }
    return { reply: text, leadQuality: 'none', sentiment: 'neutral', shouldEngage: true, foundPhone, foundEmail, contactMemory, competitorInsights, compPainPoints };
  } catch {
    return { reply: response.content[0].text, leadQuality: 'none', sentiment: 'neutral', shouldEngage: true, foundPhone, foundEmail, contactMemory, competitorInsights, compPainPoints };
  }
}

async function sendGHLReply(contactId, message, sendType, apiKey = GHL_API_KEY) {
  await axios.post(
    'https://services.leadconnectorhq.com/conversations/messages',
    { type: sendType, contactId, message },
    { headers: { Authorization: `Bearer ${apiKey}`, Version: '2021-04-15', 'Content-Type': 'application/json' } }
  );
}

// Send voice note as a tappable link in DM
async function sendGHLVoiceNote(contactId, audioUrl, sendType) {
  await sendGHLReply(contactId, `🎧 Toca para escucharme: ${audioUrl}`, sendType);
  console.log('[DM Voice] ✅ Voice link sent to', contactId);
}

// ═══════════════════════════════════════════════════════════
// BLAND.AI — OUTBOUND VOICE CALLS
// Armando calls hot leads within 2 minutes of phone capture
// ═══════════════════════════════════════════════════════════

async function triggerBlandCall(contactId, contactName, phoneNumber, contactMemory = {}) {
  if (!BLAND_API_KEY) { console.log('[Bland] No API key — skipping call'); return; }
  if (blandCallsSent.has(contactId)) { console.log('[Bland] Already called', contactId); return; }
  blandCallsSent.add(contactId);

  const businessType = contactMemory.businessType || 'business';
  const painPoints   = (contactMemory.painPoints || []).slice(0, 2).join(' and ');
  const firstName    = (contactName || '').split(' ')[0] || 'there';

  const task = `You are Armando, the friendly bilingual community manager for JRZ Marketing in Orlando, Florida. You just had a great conversation with ${firstName} over social media DM about their ${businessType}${painPoints ? ` — they mentioned challenges with ${painPoints}` : ''}.

Your ONLY goal on this call: have a warm 60-90 second conversation and book a FREE 15-minute strategy call with Jose Rivas, the founder of JRZ Marketing.

Rules:
- Start with: "Hi, is this ${firstName}? This is Armando from JRZ Marketing — we were just chatting on Instagram!"
- If they speak Spanish, switch to Spanish naturally and stay in Spanish
- Be warm, conversational, human — NOT robotic or scripted
- Reference their specific situation from the DM if relevant
- Mention the free 15-min call with Jose naturally: "Jose does a free 15-minute strategy session — no pitch, just real advice for your business"
- If they say yes → confirm they'll get a booking link by text/DM right after this call
- Keep it under 2 minutes — you are just following up on the DM, not doing a full pitch
- If they don't answer or go to voicemail → leave a brief friendly voicemail and end the call
- Never be pushy. If they say not interested → be gracious, say "No problem at all, have a great day!"`;

  try {
    const res = await axios.post('https://api.bland.ai/v1/calls', {
      phone_number: phoneNumber,
      task,
      voice:              '2f956520-a906-4f80-8da1-a518552652dc', // Joseph Corona clone
      language:           'auto',  // auto-detects English/Spanish
      webhook:            BLAND_WEBHOOK_URL,
      max_duration:       3,       // 3 min max — keeps it focused
      wait_for_greeting:  true,
      reduce_latency:     true,
      record:             true,
      metadata:           { contactId, contactName, source: 'armando_hot_lead' },
    }, {
      headers: { authorization: BLAND_API_KEY, 'Content-Type': 'application/json' },
    });
    console.log(`[Bland] ✅ Call triggered for ${contactName} (${phoneNumber}) — call_id: ${res.data?.call_id}`);
    return res.data?.call_id;
  } catch (err) {
    console.error('[Bland] Call failed:', err?.response?.data || err.message);
    blandCallsSent.delete(contactId); // allow retry on error
    return null;
  }
}

async function parseBlandTranscript(payload) {
  const contactId   = payload.metadata?.contactId;
  const contactName = payload.metadata?.contactName || 'Unknown';
  if (!contactId) return;

  const transcript = payload.concatenated_transcript || '';
  const summary    = payload.summary || '';
  const callLength = payload.call_length || 0;
  const endedBy    = payload.call_ended_by || '';

  console.log(`[Bland] Post-call for ${contactName} — ${callLength}s, ended by ${endedBy}`);

  try {
    // Ask Claude to parse the outcome
    const msg = await anthropic.messages.create({
      model:      'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages:   [{ role: 'user', content: `Parse this sales call transcript and return ONLY valid JSON: {"booked": true/false, "interested": true/false, "objection": "price|timing|competition|none", "sentiment": "positive|neutral|negative", "keyPoint": "one sentence summary"}\n\nTranscript:\n${transcript.slice(0, 2000)}\n\nSummary: ${summary}` }],
    });
    const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);

    // Update contact memory with call outcome
    const mem = await loadContactMemory(contactId);
    mem.lastCallOutcome  = parsed.keyPoint;
    mem.callBooked       = parsed.booked;
    mem.callSentiment    = parsed.sentiment;
    mem.lastCallAt       = new Date().toISOString();
    saveContactMemory(contactId, mem);

    // Tag + pipeline update
    if (parsed.booked) {
      await tagContact(contactId, ['call-booked', 'armando-called']);
      await createOpportunity(contactId, contactName, PIPELINE_STAGES.booking);
      logWeeklyWin(contactId, summary, 'call_booked');
      console.log(`[Bland] ✅ ${contactName} BOOKED on the call!`);
    } else if (parsed.interested) {
      await tagContact(contactId, ['call-interested', 'armando-called']);
    } else {
      await tagContact(contactId, ['call-no-show-or-declined', 'armando-called']);
    }

    if (parsed.objection && parsed.objection !== 'none') {
      logObjectionResponse(parsed.objection, summary, contactId);
    }
  } catch (err) {
    console.error('[Bland] Transcript parsing failed:', err.message);
    tagContact(contactId, ['armando-called']); // at minimum tag it
  }
}

async function tagContact(contactId, tags) {
  try {
    await axios.post(
      `https://services.leadconnectorhq.com/contacts/${contactId}/tags`,
      { tags },
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
    );
    console.log(`Tagged contact ${contactId} with: ${tags.join(', ')}`);
  } catch (err) {
    console.error('Tagging failed:', err?.response?.data || err.message);
  }
}

async function updateGHLContact(contactId, phone, email) {
  const known = knownContactInfo.get(contactId) || {};
  const updates = {};
  if (phone && phone !== known.phone) updates.phone = phone;
  if (email && email !== known.email) updates.email = email;
  if (Object.keys(updates).length === 0) return;
  try {
    await axios.put(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      updates,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
    );
    knownContactInfo.set(contactId, { ...known, ...updates });
    console.log(`GHL contact updated — phone: ${phone || 'n/a'}, email: ${email || 'n/a'}`);
  } catch (err) {
    console.error('Failed to update GHL contact:', err?.response?.data || err.message);
  }
}

async function sendHotLeadAlertEmail(contactName, foundPhone, foundEmail, channel) {
  const subject = `🔥 Hot Lead — ${contactName || 'New Lead'} is ready to book!`;
  const logoUrl = 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663415013329/cScWYsLVftXscDEx.png';
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Hot Lead Alert — JRZ Marketing</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .week-badge { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .week-badge span { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; border-bottom:3px solid #ffffff; }
    .email-hero h1 { font-size:28px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:16px; }
    .email-hero p { font-size:15px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .email-body { padding:40px 40px 32px; }
    .email-body p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:20px; }
    .email-body strong { color:#0a0a0a; font-weight:700; }
    .lead-card { background:#f9f9f9; border-radius:12px; overflow:hidden; margin:24px 0; }
    .lead-row { padding:12px 20px; border-bottom:1px solid #eeeeee; font-size:14px; color:#333333; }
    .lead-row:last-child { border-bottom:none; }
    .lead-label { font-weight:700; color:#0a0a0a; display:inline-block; width:80px; }
    .divider { height:1px; background:#f0f0f0; margin:32px 40px; }
    .cta-section { padding:0 40px 40px; text-align:center; }
    .cta-label { font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:16px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; }
    .signature { padding:32px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:16px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="week-badge"><span>Hot Lead Alert</span></div>
  <div class="email-hero">
    <h1>🔥 ${contactName || 'New Lead'}<br />is ready to book.</h1>
    <p>Armando collected a full lead. Time to close — reach out now.</p>
  </div>
  <div class="email-body">
    <p>A contact just gave Armando their <strong>contact information</strong>. Full details:</p>
    <div class="lead-card">
      <div class="lead-row"><span class="lead-label">Name</span>${contactName || 'Unknown'}</div>
      <div class="lead-row"><span class="lead-label">Phone</span>${foundPhone || '—'}</div>
      <div class="lead-row"><span class="lead-label">Email</span>${foundEmail || '—'}</div>
      <div class="lead-row"><span class="lead-label">Channel</span>${channel || 'DM'}</div>
      <div class="lead-row"><span class="lead-label">Time</span>${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</div>
    </div>
    <p>A branded thank-you email with the booking link has already been sent to them automatically.</p>
  </div>
  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">Ready to close?</p>
    <a href="https://app.gohighlevel.com/" class="cta-button">Open GHL &rarr; View Contact</a>
  </div>
  <div class="signature">
    <div class="signature-name">Armando Rivas</div>
    <div class="signature-title">AI Community Manager &middot; JRZ Marketing</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.<br />This is an automated internal alert from Armando.</p>
  </div>
</div></div>
</body></html>`;

  try {
    await sendEmail(OWNER_CONTACT_ID, subject, html);
    console.log('Hot lead alert email sent to Jose.');
  } catch (err) {
    console.error('Failed to send hot lead alert:', err?.response?.data || err.message);
  }
}

async function sendThankYouEmail(contactId, contactName) {
  const firstName = (contactName || 'there').split(' ')[0];
  const subject = `Gracias por contactar a JRZ Marketing 🙌 · Thank you for reaching out`;
  const logoUrl = 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663415013329/cScWYsLVftXscDEx.png';
  const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Gracias por contactar a JRZ Marketing</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .week-badge { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .week-badge span { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; border-bottom:3px solid #ffffff; }
    .email-hero h1 { font-size:28px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:16px; }
    .email-hero p { font-size:15px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .email-body { padding:40px 40px 32px; }
    .email-body p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:20px; }
    .email-body strong { color:#0a0a0a; font-weight:700; }
    .email-body ul { margin:16px 0 20px 0; padding-left:0; list-style:none; }
    .email-body ul li { font-size:15px; color:#333333; line-height:1.7; padding:8px 0 8px 28px; position:relative; border-bottom:1px solid #f0f0f0; }
    .email-body ul li:last-child { border-bottom:none; }
    .email-body ul li::before { content:'✓'; position:absolute; left:0; color:#0a0a0a; font-weight:700; }
    .divider { height:1px; background:#f0f0f0; margin:32px 40px; }
    .cta-section { padding:0 40px 40px; text-align:center; }
    .cta-label { font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:16px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; margin-bottom:16px; }
    .cta-note { font-size:12px; color:#aaaaaa; }
    .signature { padding:32px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; margin-bottom:12px; }
    .signature-links a { color:#0a0a0a; text-decoration:none; font-weight:600; font-size:13px; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:16px; opacity:0.7; }
    .footer-links a { font-size:12px; color:rgba(255,255,255,0.35); text-decoration:none; margin:0 10px; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; margin-top:12px; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="week-badge"><span>Sesión Gratuita &middot; Free Strategy Session</span></div>
  <div class="email-hero">
    <h1>${firstName},<br />ya estamos en contacto. &#128075;</h1>
    <p>The team that transforms businesses in 90 days is ready for you.</p>
  </div>
  <div class="email-body">
    <p>Hola <strong>${firstName}</strong>,</p>
    <p>Gracias por conectar con JRZ Marketing. Recibimos tu información y nuestro equipo se va a poner en contacto contigo muy pronto.</p>
    <p>Mientras tanto, esto es lo que hacemos por negocios como el tuyo:</p>
    <ul>
      <li>Estrategia de marketing basada en datos, no en suposiciones</li>
      <li>Automatizaciones con IA que trabajan 24/7 para captar clientes</li>
      <li>CRM configurado para nunca perder un lead</li>
      <li>Contenido que genera confianza y convierte visitantes en clientes</li>
    </ul>
    <p>¿Quieres acelerar el proceso? Agenda tu sesión gratuita de 30 minutos directamente aquí — sin costo, sin compromiso.</p>
  </div>
  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">¿Listo para crecer?</p>
    <a href="${BOOKING_URL}" class="cta-button">&#128197; Agenda tu llamada gratuita &rarr;</a>
    <p class="cta-note">30 minutos &middot; Sin costo &middot; Sin compromiso</p>
  </div>
  <div class="signature">
    <div class="signature-name">Jose Rivas</div>
    <div class="signature-title">Founder &amp; CEO &mdash; JRZ Marketing</div>
    <div class="signature-links">
      <a href="${BOOKING_URL}">Agenda tu llamada</a> &nbsp;&middot;&nbsp;
      <a href="https://jrzmarketing.com">jrzmarketing.com</a>
    </div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <div class="footer-links">
      <a href="${BOOKING_URL}">Contacto</a>
      <a href="https://jrzmarketing.com">Website</a>
    </div>
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Todos los derechos reservados.<br />Orlando, Florida &middot; jrzmarketing.com</p>
  </div>
</div></div>
</body></html>`;

  try {
    await sendEmail(contactId, subject, html);
    console.log(`Thank-you email sent to contact ${contactId}.`);
  } catch (err) {
    console.error('Failed to send thank-you email:', err?.response?.data || err.message);
  }
}

// ─── Profile IDs for analytics API ───────────────────────
const ANALYTICS_PROFILE_IDS = [
  '69571d84f8b32728afd7c45c', // Instagram
  '69571d95c63407b04d656891', // Facebook
  '69571db827f36d340ac94361', // LinkedIn Jose
  '69571dbe19b790b6ae98d688', // LinkedIn JRZ
  '69571dd3f8b327a382d7dbdf', // YouTube
  '69b64ef0dbe649d4431d3fcc', // TikTok Jose
  '69b64e8326ef3d3693ae68a9', // TikTok JRZ
];

// ═══════════════════════════════════════════════════════════
// FEATURE 1 — SELF-LEARNING ANALYTICS
// Every Monday: pull 7-day stats → Claude finds patterns →
// saves a content strategy to Cloudinary → all future
// content generation uses it to improve week over week.
// ═══════════════════════════════════════════════════════════

const STRATEGY_URL    = `https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/content_strategy.json`;
const STRATEGY_PUB_ID = 'jrz/content_strategy';

// ═══════════════════════════════════════════════════════════
// A/B TESTING — CLOSING APPROACHES
// 4 variants. Weekly Claude analysis shifts traffic to winner.
// Persisted in Cloudinary so it survives server restarts.
// ═══════════════════════════════════════════════════════════
const AB_URL    = `https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/ab_closing_test.json`;
const AB_PUB_ID = 'jrz/ab_closing_test';

// ── Armando Learning System — 5 persistent memory stores ─────────────────────
const CONTACT_MEMORY_BASE  = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/contact_memory_';
const VOICE_FEEDBACK_URL   = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/voice_feedback.json';
const VOICE_FEEDBACK_PID   = 'jrz/voice_feedback';
const ENGAGEMENT_URL       = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/engagement_patterns.json';
const ENGAGEMENT_PID       = 'jrz/engagement_patterns';
const COMPETITOR_INS_URL   = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/competitor_insights.json';
const COMPETITOR_INS_PID   = 'jrz/competitor_insights';
const COMPETITOR_PAIN_URL  = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/competitor_pain_points.json';
const COMPETITOR_PAIN_PID  = 'jrz/competitor_pain_points';

// ── Feature: Objection Memory ─────────────────────────────────────────────────
const OBJECTION_MEMORY_URL = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/objection_memory.json';
const OBJECTION_MEMORY_PID = 'jrz/objection_memory';

// ── Feature: Self-Updating Rules ─────────────────────────────────────────────
const ARMANDO_RULES_URL = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/armando_rules.json';
const ARMANDO_RULES_PID = 'jrz/armando_rules';
const WEEKLY_WINS_URL   = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/weekly_wins.json';
const WEEKLY_WINS_PID   = 'jrz/weekly_wins';

// ── Feature: Reel Attribution ─────────────────────────────────────────────────
const REEL_LOG_URL = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/reel_log.json';
const REEL_LOG_PID = 'jrz/reel_log';

// In-memory: contactId → variant letter assigned for this session
const contactVariantMap = new Map();

// The 4 closing variants injected into Armando's stage instruction
const CLOSING_VARIANTS = {
  A: {
    name: 'Direct',
    description: 'Straight to the point. No fluff. Quick link.',
    instruction: (url) =>
      `CIERRE DIRECTO: Responde brevemente a lo que dijeron, luego ve al grano — "¿Tienes 30 minutos esta semana? La llamada es gratis, te digo exactamente qué necesitas." Manda el link: ${url}. Sin rodeos.`,
  },
  B: {
    name: 'Social Proof',
    description: 'Quick win story from a similar business, then invite them.',
    instruction: (url) =>
      `CIERRE CON PRUEBA SOCIAL: Menciona brevemente un cliente similar al de ellos (restaurante, constructora, gimnasio, etc.) que mejoró resultados con JRZ — en UNA oración, sin exagerar. Luego invítalos a hablar: "¿Hablamos?" + link: ${url}`,
  },
  C: {
    name: 'Pain Point',
    description: 'Name their specific problem, position the call as the solution.',
    instruction: (url) =>
      `CIERRE POR DOLOR: Nombra el problema específico que detectas en su mensaje (sin inventar, usa lo que te dijeron). Luego: "Eso es exactamente lo que resolvemos. Una llamada de 30 minutos y te explico cómo." + link: ${url}. Hazlo sentir que los entiendes.`,
  },
  D: {
    name: 'Curiosity Gap',
    description: 'Tease something they can only get on the call.',
    instruction: (url) =>
      `CIERRE POR CURIOSIDAD: Di algo que genere intriga — "Lo que hacemos diferente no lo puedo explicar bien por mensaje, necesito mostrártelo." No des más detalles. Solo invítalos: "¿Me das 30 minutos?" + link: ${url}. Que quieran saber.`,
  },
};

async function loadABTestData() {
  try {
    const res = await axios.get(AB_URL, { timeout: 8000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch {
    // Default starting state — equal weights
    return {
      variants: {
        A: { name: 'Direct',        sent: 0, conversions: 0 },
        B: { name: 'Social Proof',  sent: 0, conversions: 0 },
        C: { name: 'Pain Point',    sent: 0, conversions: 0 },
        D: { name: 'Curiosity Gap', sent: 0, conversions: 0 },
      },
      weights: { A: 25, B: 25, C: 25, D: 25 },
      lastOptimized: null,
      history: [],
    };
  }
}

async function saveABTestData(data) {
  try {
    const ts      = Math.floor(Date.now() / 1000);
    const sigStr  = `overwrite=true&public_id=${AB_PUB_ID}&resource_type=raw&timestamp=${ts}${CLOUDINARY_API_SECRET}`;
    const sig     = crypto.createHash('sha1').update(sigStr).digest('hex');
    const form    = new FormData();
    const buf     = Buffer.from(JSON.stringify(data, null, 2));
    form.append('file',          buf,  { filename: 'ab_closing_test.json', contentType: 'application/json' });
    form.append('public_id',     AB_PUB_ID);
    form.append('resource_type', 'raw');
    form.append('timestamp',     String(ts));
    form.append('api_key',       CLOUDINARY_API_KEY);
    form.append('signature',     sig);
    form.append('overwrite',     'true');
    await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`,
      form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 30000 }
    );
  } catch (err) {
    console.error('[AB] Failed to save test data:', err.message);
  }
}

// ─── Generic Cloudinary raw JSON save ────────────────────────────────────────
async function saveCloudinaryJSON(publicId, data) {
  try {
    const ts     = Math.floor(Date.now() / 1000);
    // invalidate=true flushes CDN cache so all edge nodes serve fresh data immediately
    const sigStr = `invalidate=true&overwrite=true&public_id=${publicId}&timestamp=${ts}${CLOUDINARY_API_SECRET}`;
    const sig    = crypto.createHash('sha1').update(sigStr).digest('hex');
    const form   = new FormData();
    const buf    = Buffer.from(JSON.stringify(data, null, 2));
    form.append('file', buf, { filename: `${publicId.split('/').pop()}.json`, contentType: 'application/json' });
    form.append('public_id', publicId); form.append('resource_type', 'raw');
    form.append('timestamp', String(ts)); form.append('api_key', CLOUDINARY_API_KEY);
    form.append('signature', sig); form.append('overwrite', 'true');
    form.append('invalidate', 'true');
    await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 30000 });
  } catch (err) { console.error(`[Memory] Failed to save ${publicId}:`, err.message); }
}

// ─── 1. CONTACT MEMORY ───────────────────────────────────────────────────────
async function loadContactMemory(contactId) {
  try {
    const res = await axios.get(`${CONTACT_MEMORY_BASE}${contactId}.json`, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return { businessType: '', painPoints: [], interests: [], lastMessage: '', messageCount: 0, bookingStatus: 'none' }; }
}
async function saveContactMemory(contactId, data) {
  await saveCloudinaryJSON(`jrz/contact_memory_${contactId}`, data);
}

// ─── 2. VOICE FEEDBACK ───────────────────────────────────────────────────────
async function loadVoiceFeedback() {
  try {
    const res = await axios.get(VOICE_FEEDBACK_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return { bookings: [], winningPatterns: '', updatedAt: null }; }
}
async function saveVoiceFeedback(data) { await saveCloudinaryJSON(VOICE_FEEDBACK_PID, data); }

async function updateWinningVoicePatterns() {
  try {
    const feedback = await loadVoiceFeedback();
    if (feedback.bookings.length < 3) return;
    const summary = feedback.bookings.slice(-30).map(b =>
      `Negocio: ${b.businessType}, Pain points: ${(b.painPoints||[]).join(',')||'N/A'}, Mensajes antes de booking: ${b.messageCount}`
    ).join('\n');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 300,
      messages: [{ role: 'user', content: `Analiza estos clientes que agendaron con JRZ Marketing:\n${summary}\n\nDevuelve JSON: {"topBusinessTypes":[],"topPainPoints":[],"voiceScriptRecommendation":"una sola oración sobre qué angle cierra mejor"}` }]
    });
    const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    feedback.winningPatterns = `Negocios que más convierten: ${parsed.topBusinessTypes.join(', ')}. Pain points que cierran: ${parsed.topPainPoints.join(', ')}. ${parsed.voiceScriptRecommendation}`;
    feedback.updatedAt = new Date().toISOString();
    await saveVoiceFeedback(feedback);
    console.log('[Learning] ✅ Voice patterns updated:', feedback.winningPatterns);
  } catch (err) { console.error('[Learning] Voice pattern update failed:', err.message); }
}

// ─── 3. ENGAGEMENT PATTERNS ──────────────────────────────────────────────────
async function loadEngagementPatterns() {
  try {
    const res = await axios.get(ENGAGEMENT_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return { topHooks: [], contentAngles: [], emotionalTriggers: [], updatedAt: null }; }
}
async function saveEngagementPatterns(data) { await saveCloudinaryJSON(ENGAGEMENT_PID, data); }

async function runEngagementLearning() {
  try {
    console.log('[Learning] Analyzing engagement patterns...');
    const res = await axios.get(
      `https://services.leadconnectorhq.com/social-media-posting/${GHL_LOCATION_ID}/posts`,
      { params: { skip: 0, limit: 50, status: 'published' }, headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' }, timeout: 15000 }
    );
    const posts = (res.data?.posts || res.data?.data || []).filter(p => p.caption || p.description);
    if (posts.length < 3) { console.log('[Learning] Not enough posts to analyze'); return; }

    // Score each post by real engagement (likes + comments + shares + views/10)
    const scored = posts.map(p => {
      const e = p.engagement || p.analytics || {};
      const score = (e.likes || e.likeCount || 0)
                  + (e.comments || e.commentCount || 0) * 2   // comments = stronger signal
                  + (e.shares || e.shareCount || 0) * 3       // shares = strongest signal
                  + Math.floor((e.views || e.viewCount || e.impressions || 0) / 10);
      return { caption: p.caption || p.description || '', score, type: p.type || 'post', platform: p.platform || '' };
    });

    // Sort: top performers first, then take worst performers to learn what to avoid
    scored.sort((a, b) => b.score - a.score);
    const topPosts  = scored.slice(0, 5);
    const flops     = scored.slice(-3).filter(p => p.score === 0);

    const topSummary  = topPosts.map((p, i) => `#${i+1} (score ${p.score}): ${p.caption.slice(0, 200)}`).join('\n---\n');
    const flopSummary = flops.length ? flops.map(p => p.caption.slice(0, 100)).join('\n---\n') : 'none';

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 500,
      messages: [{ role: 'user', content: `Eres el director de contenido de JRZ Marketing. Analiza estos datos de engagement real y extrae los patrones ganadores.

TOP POSTS (mayor engagement):
${topSummary}

POSTS QUE NO FUNCIONARON:
${flopSummary}

Devuelve SOLO JSON válido:
{"topHooks":["hook ganador 1","hook ganador 2","hook ganador 3"],"contentAngles":["ángulo que funciona 1","ángulo 2"],"emotionalTriggers":["disparador emocional 1","disparador 2"],"avoidPatterns":["patrón a evitar 1","patrón 2"],"weeklyInsight":"observación clave sobre qué funciona esta semana"}` }]
    });
    const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    parsed.updatedAt = new Date().toISOString();
    parsed.topPostScores = topPosts.map(p => ({ score: p.score, hook: p.caption.slice(0, 80) }));
    await saveEngagementPatterns(parsed);
    console.log('[Learning] ✅ Engagement patterns updated from real data — top post score:', topPosts[0]?.score || 0);
  } catch (err) { console.error('[Learning] Engagement analysis failed:', err.message); }
}

// ─── 4. COMPETITOR INSIGHTS ──────────────────────────────────────────────────
async function loadCompetitorInsights() {
  try {
    const res = await axios.get(COMPETITOR_INS_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return { competitorWeaknesses: [], contentAngles: [], opportunity: '', updatedAt: null }; }
}
async function saveCompetitorInsights(data) { await saveCloudinaryJSON(COMPETITOR_INS_PID, data); }

// ─── 5. COMPETITOR PAIN POINTS (from reviews) ────────────────────────────────
async function loadCompetitorPainPoints() {
  try {
    const res = await axios.get(COMPETITOR_PAIN_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return { painPoints: [], frustrations: [], updatedAt: null }; }
}
async function saveCompetitorPainPoints(data) { await saveCloudinaryJSON(COMPETITOR_PAIN_PID, data); }

// ─── OBJECTION MEMORY ────────────────────────────────────────────────────────
async function loadObjectionMemory() {
  try {
    const res = await axios.get(OBJECTION_MEMORY_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return {}; }
}
async function saveObjectionMemory(data) { await saveCloudinaryJSON(OBJECTION_MEMORY_PID, data); }

function detectObjection(message) {
  const m = message.toLowerCase();
  if (m.match(/muy caro|too expensive|precio alto|no tengo presupuesto|cuesta mucho|no puedo pagar|es mucho dinero/)) return 'too_expensive';
  if (m.match(/ahora no|not now|después|luego|más adelante|ocupado|no es buen momento|busy|later/)) return 'not_now';
  if (m.match(/ya tengo|ya trabajo con|tengo agencia|tengo alguien|already have/)) return 'already_have_agency';
  if (m.match(/no tengo tiempo|sin tiempo|muy ocupado|no time/)) return 'no_time';
  if (m.match(/solo mirando|just looking|solo información|solo info|just browsing/)) return 'just_looking';
  return null;
}

async function logObjectionResponse(objectionType, response, contactId) {
  try {
    const mem = await loadObjectionMemory();
    if (!mem[objectionType]) mem[objectionType] = { bestResponses: [], convertedCount: 0, pending: [] };
    mem[objectionType].pending.push({ contactId, response, timestamp: new Date().toISOString(), outcome: 'pending' });
    mem[objectionType].pending = mem[objectionType].pending.slice(-50); // keep last 50
    await saveObjectionMemory(mem);
  } catch (err) { console.error('[Objection] Log failed:', err.message); }
}

async function markObjectionConverted(contactId) {
  try {
    const mem = await loadObjectionMemory();
    let changed = false;
    for (const type of Object.keys(mem)) {
      if (!mem[type].pending) continue;
      for (const entry of mem[type].pending) {
        if (entry.contactId === contactId && entry.outcome === 'pending') {
          entry.outcome = 'converted';
          mem[type].convertedCount = (mem[type].convertedCount || 0) + 1;
          // Promote to bestResponses if not already there
          if (!mem[type].bestResponses.includes(entry.response)) {
            mem[type].bestResponses.unshift(entry.response);
            mem[type].bestResponses = mem[type].bestResponses.slice(0, 5);
          }
          changed = true;
        }
      }
    }
    if (changed) await saveObjectionMemory(mem);
  } catch (err) { console.error('[Objection] markConverted failed:', err.message); }
}

async function runObjectionLearning() {
  try {
    console.log('[Learning] Running objection pattern analysis...');
    const mem = await loadObjectionMemory();
    const summary = Object.entries(mem).map(([type, data]) => (
      `${type}: ${data.convertedCount || 0} conversions, best responses: ${(data.bestResponses || []).slice(0, 2).join(' | ')}`
    )).join('\n');
    if (!summary) return;
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 400,
      messages: [{ role: 'user', content: `You are analyzing objection handling data for a Spanish-speaking AI sales bot. Based on these results, return ONLY valid JSON: { "insights": "what's working", "newResponses": { "too_expensive": "one new counter", "not_now": "one new counter", "already_have_agency": "one new counter" } }\n\n${summary}` }],
    });
    const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    // Inject new AI-generated responses into best responses
    for (const [type, response] of Object.entries(parsed.newResponses || {})) {
      if (!mem[type]) mem[type] = { bestResponses: [], convertedCount: 0, pending: [] };
      if (response && !mem[type].bestResponses.includes(response)) {
        mem[type].bestResponses.push(response);
        mem[type].bestResponses = mem[type].bestResponses.slice(0, 5);
      }
    }
    await saveObjectionMemory(mem);
    console.log('[Learning] ✅ Objection patterns updated:', parsed.insights);
  } catch (err) { console.error('[Learning] Objection learning failed:', err.message); }
}

// ─── SELF-UPDATING SYSTEM PROMPT ─────────────────────────────────────────────
async function loadArmandoRules() {
  try {
    const res = await axios.get(ARMANDO_RULES_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return { rules: [], updatedAt: null }; }
}
async function saveArmandoRules(data) { await saveCloudinaryJSON(ARMANDO_RULES_PID, data); }

async function loadWeeklyWins() {
  try {
    const res = await axios.get(WEEKLY_WINS_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return []; }
}
async function saveWeeklyWins(data) { await saveCloudinaryJSON(WEEKLY_WINS_PID, data); }

async function logWeeklyWin(contactId, reply, outcome) {
  try {
    const wins = await loadWeeklyWins();
    wins.push({ contactId, reply: reply.slice(0, 300), outcome, timestamp: new Date().toISOString() });
    await saveWeeklyWins(wins.slice(-100)); // keep last 100 wins
  } catch (err) { console.error('[Rules] logWeeklyWin failed:', err.message); }
}

async function runSelfUpdateRules() {
  try {
    console.log('[Rules] Running self-update of Armando\'s playbook...');
    const [wins, engPatterns, objMem] = await Promise.all([
      loadWeeklyWins(),
      loadEngagementPatterns(),
      loadObjectionMemory(),
    ]);
    const winSummary = wins.slice(-30).map(w => `[${w.outcome}] "${w.reply}"`).join('\n');
    const engSummary = engPatterns.bestTopics ? `Best topics: ${engPatterns.bestTopics.join(', ')}. Best hook style: ${engPatterns.bestHookStyle}` : '';
    const objSummary = Object.entries(objMem).map(([t, d]) => `${t}: ${d.convertedCount || 0} conversions`).join(', ');
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: `You are improving the behavior rules for Armando, a Spanish-speaking AI sales bot for JRZ Marketing (Orlando, FL). Analyze this week's data and return ONLY valid JSON with exactly this structure:\n{"rules":["rule1","rule2","rule3","rule4","rule5"],"weeklyWins":${wins.length},"updatedAt":"${new Date().toISOString()}"}\n\nWins this week:\n${winSummary}\n\nEngagement: ${engSummary}\nObjections: ${objSummary}\n\nWrite 5 specific behavior rules in Spanish that will make Armando more effective next week. Rules should be actionable instructions like "Cuando alguien menciona precio, primero pregunta sobre su ROI antes de defender el costo".` }],
    });
    const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    await saveArmandoRules(parsed);
    // Clear weekly wins for next week
    await saveWeeklyWins([]);
    console.log('[Rules] ✅ Armando playbook updated with', parsed.rules?.length, 'new rules');
  } catch (err) { console.error('[Rules] Self-update failed:', err.message); }
}

// ─── REEL ATTRIBUTION ─────────────────────────────────────────────────────────
async function loadReelLog() {
  try {
    const res = await axios.get(REEL_LOG_URL, { timeout: 6000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return []; }
}
async function saveReelLog(data) { await saveCloudinaryJSON(REEL_LOG_PID, data); }

async function logReelPost(hook, caption) {
  try {
    const log = await loadReelLog();
    log.unshift({ hook, caption: caption?.slice(0, 200) || '', postedAt: new Date().toISOString(), dmCount: 0, attributedContacts: [] });
    await saveReelLog(log.slice(0, 50)); // keep last 50 reels
  } catch (err) { console.error('[Attribution] logReelPost failed:', err.message); }
}

async function checkReelAttribution(contactId) {
  try {
    const log = await loadReelLog();
    const cutoff = Date.now() - 48 * 60 * 60 * 1000; // 48 hours ago
    const recentReel = log.find(r => new Date(r.postedAt).getTime() > cutoff && !r.attributedContacts.includes(contactId));
    if (!recentReel) return null;
    // Update reel log — increment dmCount and add contactId
    recentReel.dmCount = (recentReel.dmCount || 0) + 1;
    recentReel.attributedContacts.push(contactId);
    saveReelLog(log); // fire-and-forget
    return recentReel.hook;
  } catch { return null; }
}

async function runReviewMining() {
  try {
    console.log('[Learning] Mining competitor reviews...');
    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    if (!SERPAPI_KEY) { console.log('[Learning] No SERPAPI_KEY — skipping review mining'); return; }
    const res = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google_maps', q: 'marketing agency orlando florida', hl: 'en', gl: 'us', api_key: SERPAPI_KEY },
      timeout: 15000
    });
    const results = res.data?.local_results || [];
    const reviews = results.slice(0, 5).flatMap(r => (r.reviews || []).filter(rv => rv.rating <= 2).map(rv => rv.snippet)).filter(Boolean).slice(0, 15);
    if (reviews.length === 0) { console.log('[Learning] No low-rated reviews found'); return; }
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 400,
      messages: [{ role: 'user', content: `Estas son reseñas negativas (1-2 estrellas) de agencias de marketing en Orlando. Extrae los problemas más comunes que los clientes mencionan:\n${reviews.join('\n')}\n\nDevuelve JSON: {"painPoints":["problema 1","problema 2","problema 3"],"frustrations":["frustración 1","frustración 2"]}` }]
    });
    const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
    parsed.updatedAt = new Date().toISOString();
    await saveCompetitorPainPoints(parsed);
    console.log('[Learning] ✅ Competitor pain points saved:', parsed.painPoints);
  } catch (err) { console.error('[Learning] Review mining failed:', err.message); }
}

// Weighted random variant assignment — winner gets more traffic over time
async function assignClosingVariant(contactId) {
  if (contactVariantMap.has(contactId)) return contactVariantMap.get(contactId);
  const data = await loadABTestData();
  const w = data.weights;
  const total = w.A + w.B + w.C + w.D;
  let rand = Math.random() * total;
  let variant = 'A';
  for (const [v, weight] of Object.entries(w)) {
    rand -= weight;
    if (rand <= 0) { variant = v; break; }
  }
  contactVariantMap.set(contactId, variant);
  // Record the send
  data.variants[variant].sent++;
  await saveABTestData(data);
  console.log(`[AB] Contact ${contactId} assigned variant ${variant} (${CLOSING_VARIANTS[variant].name})`);
  return variant;
}

// Call this when a contact converts (gives phone or email)
async function recordABConversion(contactId) {
  const variant = contactVariantMap.get(contactId);
  if (!variant) return;
  const data = await loadABTestData();
  data.variants[variant].conversions++;
  await saveABTestData(data);
  console.log(`[AB] Conversion recorded for variant ${variant} (${CLOSING_VARIANTS[variant].name})`);
}

// Weekly: Claude analyzes results → adjusts weights → winner gets more traffic
async function runABTestAnalysis() {
  console.log('[AB] Running weekly A/B test analysis...');
  try {
    const data = await loadABTestData();
    const summary = Object.entries(data.variants).map(([v, s]) => {
      const rate = s.sent > 0 ? ((s.conversions / s.sent) * 100).toFixed(1) : '0.0';
      return `Variant ${v} (${s.name}): ${s.sent} sent, ${s.conversions} conversions, ${rate}% conversion rate`;
    }).join('\n');

    const prompt = `Eres el director de marketing de JRZ Marketing analizando los resultados del A/B test de cierres de venta de Armando (DM bot).

RESULTADOS DE ESTA SEMANA:
${summary}

Pesos actuales: A=${data.weights.A}%, B=${data.weights.B}%, C=${data.weights.C}%, D=${data.weights.D}%

VARIANTES:
A - Direct: cierre directo sin rodeos
B - Social Proof: historia de cliente similar + invitación
C - Pain Point: nombra su problema específico + solución
D - Curiosity Gap: genera intriga para que quieran la llamada

Tu tarea:
1. Analiza qué variante está convirtiendo mejor
2. Ajusta los pesos para la próxima semana — el ganador debe recibir más tráfico, pero no elimines ninguna variante (mínimo 10% cada una)
3. Suma total de pesos debe ser exactamente 100
4. Si hay pocos datos (menos de 5 sends por variante), mantén pesos iguales y espera más datos

Responde SOLO con JSON válido:
{
  "weights": {"A": number, "B": number, "C": number, "D": number},
  "winner": "A|B|C|D|none",
  "insight": "una oración sobre qué está funcionando y por qué"
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{ role: 'user', content: prompt }],
    });

    const parsed = JSON.parse(msg.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);
    const prevWeights = { ...data.weights };

    data.weights = parsed.weights;
    data.lastOptimized = new Date().toISOString().split('T')[0];
    data.history.push({
      date: data.lastOptimized,
      winner: parsed.winner,
      insight: parsed.insight,
      oldWeights: prevWeights,
      newWeights: parsed.weights,
      snapshot: JSON.parse(JSON.stringify(data.variants)),
    });

    // Reset weekly counts after saving snapshot
    for (const v of Object.keys(data.variants)) {
      data.variants[v].sent = 0;
      data.variants[v].conversions = 0;
    }

    await saveABTestData(data);
    console.log(`[AB] ✅ Weights updated. Winner: ${parsed.winner}. Insight: ${parsed.insight}`);
    console.log(`[AB] New weights:`, parsed.weights);
    return parsed;
  } catch (err) {
    console.error('[AB] ❌ Analysis failed:', err.message);
    return null;
  }
}

async function loadContentStrategy() {
  try {
    const res = await axios.get(STRATEGY_URL, { timeout: 8000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch {
    return {
      bestTopics: ['IA y automatización', 'errores de marketing', 'leads perdidos'],
      bestHookStyle: 'question-based hooks outperform statements',
      bestDays: { instagram: 'saturday', facebook: 'monday', linkedin: 'thursday' },
      audienceInsights: '25–34 year-old male business owners, Orlando FL, respond to problem-focused content',
      avoidTopics: [],
      weeklyNotes: 'No data yet — baseline week.',
    };
  }
}

async function saveContentStrategy(strategy) {
  const ts       = Math.floor(Date.now() / 1000);
  const sigStr   = `overwrite=true&public_id=${STRATEGY_PUB_ID}&resource_type=raw&timestamp=${ts}${CLOUDINARY_API_SECRET}`;
  const signature = crypto.createHash('sha1').update(sigStr).digest('hex');
  const form = new FormData();
  const buf  = Buffer.from(JSON.stringify(strategy, null, 2));
  form.append('file',          buf,    { filename: 'content_strategy.json', contentType: 'application/json' });
  form.append('public_id',     STRATEGY_PUB_ID);
  form.append('resource_type', 'raw');
  form.append('timestamp',     String(ts));
  form.append('api_key',       CLOUDINARY_API_KEY);
  form.append('signature',     signature);
  form.append('overwrite',     'true');
  await axios.post(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`,
    form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 30000 }
  );
}

async function getWeeklyStats() {
  const res = await axios.post(
    `https://services.leadconnectorhq.com/social-media-posting/statistics?locationId=${GHL_LOCATION_ID}`,
    { profileIds: ANALYTICS_PROFILE_IDS, platforms: ['instagram','facebook','linkedin','youtube','tiktok'] },
    { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
  );
  return res.data?.results || res.data;
}

async function runWeeklyAnalysis() {
  console.log('[Learn] Running weekly analytics analysis...');
  try {
    const [stats, prevStrategy] = await Promise.all([getWeeklyStats(), loadContentStrategy()]);

    const breakdown = stats?.breakdowns || {};
    const eng       = breakdown?.engagement || {};

    const prompt = `Eres el director de marketing de JRZ Marketing. Analiza estos datos de la semana pasada y actualiza la estrategia de contenido.

DATOS DE LA SEMANA:
- Impresiones totales: ${breakdown?.impressions?.total || 0} (cambio: ${breakdown?.impressions?.totalChange || 0}%)
- Alcance total: ${breakdown?.reach?.total || 0} (cambio: ${breakdown?.reach?.totalChange || 0}%)
- Instagram: ${breakdown?.impressions?.platforms?.instagram?.value || 0} impresiones, ${eng?.instagram?.likes || 0} likes, ${eng?.instagram?.comments || 0} comentarios, ${eng?.instagram?.shares || 0} shares
- Facebook: ${breakdown?.impressions?.platforms?.facebook?.value || 0} impresiones, ${eng?.facebook?.likes || 0} likes
- LinkedIn: ${breakdown?.impressions?.platforms?.linkedin?.value || 0} impresiones, ${eng?.linkedin?.likes || 0} likes
- TikTok: ${breakdown?.impressions?.platforms?.tiktok?.value || 0} impresiones
- YouTube: ${breakdown?.impressions?.platforms?.youtube?.value || 0} impresiones
- Nuevos seguidores: ${breakdown?.followers?.total || 0} (Instagram)
- Demografía: 53% hombres, 25-34 años es el grupo más grande
- Mejor día de impresiones: ${stats?.postPerformance?.impressions ? JSON.stringify(stats.postPerformance.impressions) : 'no data'}

ESTRATEGIA ANTERIOR:
${JSON.stringify(prevStrategy, null, 2)}

Responde SOLO con un JSON válido con esta estructura:
{
  "bestTopics": ["tema1", "tema2", "tema3"],
  "bestHookStyle": "descripción del estilo de hook que más funciona",
  "bestDays": {"instagram": "día", "facebook": "día", "linkedin": "día", "tiktok": "día"},
  "audienceInsights": "insights sobre la audiencia basados en los datos",
  "avoidTopics": ["temas que no funcionaron"],
  "weeklyNotes": "observaciones clave y ajustes para la próxima semana",
  "hookFormulas": ["fórmula de hook 1", "fórmula de hook 2", "fórmula de hook 3"]
}`;

    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 800,
      messages: [{ role: 'user', content: prompt }],
    });

    const newStrategy = JSON.parse(msg.content[0].text.trim());
    newStrategy.updatedAt = new Date().toISOString().split('T')[0];
    await saveContentStrategy(newStrategy);
    console.log('[Learn] ✅ Strategy updated:', newStrategy.weeklyNotes);
    return newStrategy;
  } catch (err) {
    console.error('[Learn] ❌ Weekly analysis failed:', err.message);
    return null;
  }
}

// ═══════════════════════════════════════════════════════════
// OPPORTUNITIES — Add contacts to Marketing Pipeline in GHL
// ═══════════════════════════════════════════════════════════

const opportunityCreatedContacts = new Set();

async function createOpportunity(contactId, contactName, stageId) {
  // Skip silently if we already created one this session
  if (opportunityCreatedContacts.has(contactId)) {
    console.log(`[Opportunity] Skipping — already created for ${contactId}`);
    return;
  }
  try {
    await axios.post(
      'https://services.leadconnectorhq.com/opportunities/',
      {
        pipelineId:    MARKETING_PIPELINE_ID,
        locationId:    GHL_LOCATION_ID,
        name:          contactName || 'Lead',
        pipelineStageId: stageId,
        contactId,
        assignedTo:    GHL_USER_ID,
        status:        'open',
      },
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
    );
    opportunityCreatedContacts.add(contactId);
    console.log(`[Opportunity] ✅ Added ${contactName} (${contactId}) → stage ${stageId}`);
  } catch (err) {
    const status = err?.response?.status;
    const msg = err?.response?.data?.message || '';
    if (status === 400 && msg.toLowerCase().includes('duplicate')) {
      opportunityCreatedContacts.add(contactId); // mark so we don't try again
      console.log(`[Opportunity] Already exists for ${contactId} — skipping.`);
    } else {
      console.error(`[Opportunity] ❌ Failed for ${contactId}:`, err?.response?.data || err.message);
    }
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE 2 — WARM DM OUTREACH
// When someone comments or follows → Armando DMs them
// within 60 seconds with a personalized message.
// Cooldown: never re-messages same contact within 7 days.
// ═══════════════════════════════════════════════════════════

const dmCooldown = new Map(); // contactId → last DM timestamp

async function sendWarmDM(contactId, triggerType, context = {}) {
  // Cooldown check — 7 days
  const lastDM = dmCooldown.get(contactId);
  if (lastDM && Date.now() - lastDM < 7 * 24 * 60 * 60 * 1000) return;
  dmCooldown.set(contactId, Date.now());

  // Get contact name if available
  let contactName = context.name || 'amigo';
  try {
    const c = await axios.get(
      `https://services.leadconnectorhq.com/contacts/${contactId}`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    contactName = c.data?.contact?.firstName || contactName;
  } catch (_) {}

  const prompts = {
    comment: `Alguien llamado ${contactName} comentó en uno de nuestros posts de JRZ Marketing en redes sociales. Escribe un DM corto, natural y humano de Armando Rivas (22 años, venezolano, Community Manager de JRZ Marketing) para iniciar una conversación. Menciona que viste su comentario, pregunta sobre su negocio, y de forma casual menciona que ofrecemos consultas gratuitas. MAX 3 oraciones. Sin hashtags. En español.`,
    follower: `Alguien llamado ${contactName} acaba de seguir la cuenta de JRZ Marketing en Instagram. Escribe un DM de bienvenida corto y humano de Armando Rivas. Agradece que siguió, pregunta qué tipo de negocio tiene, y menciona casualmente la consulta gratuita. MAX 3 oraciones. Sin hashtags. En español.`,
    form_fill: `Alguien llamado ${contactName} llenó un formulario de interés en JRZ Marketing. Escribe un DM de seguimiento rápido de Armando Rivas. Menciona que vio su información, pregunta cuál es su mayor reto de marketing ahora mismo, y propone hablar 15 minutos. MAX 3 oraciones. Sin hashtags. En español.`,
  };

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompts[triggerType] || prompts.comment }],
  });
  const dmText = msg.content[0].text.trim();

  // Send via GHL conversations API
  try {
    await sendEmail(contactId, '👋 Hola desde JRZ Marketing', `<p>${dmText}</p>`);
    console.log(`[WarmDM] ✅ Sent ${triggerType} DM to contact ${contactId}`);
    await createOpportunity(contactId, contactName, PIPELINE_STAGES.newLead);
    await tagContact(contactId, ['nurture-sequence']);
  } catch (err) {
    console.error('[WarmDM] ❌ Failed to send DM:', err?.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE 3 — OUTBOUND PROSPECTING
// Runs Mon–Fri at 10am EST. Finds contacts in GHL tagged
// "outbound_pending", sends 15 personalized outreach
// messages per day, then tags them "outbound_sent".
// To add prospects: import contacts in GHL with tag
// "outbound_pending" (LinkedIn export, referrals, etc.)
// ═══════════════════════════════════════════════════════════

async function runDailyOutbound() {
  console.log('[Outbound] Running daily prospecting (50 contacts)...');
  try {
    // Fetch contacts tagged outbound_pending
    const res = await axios.get(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&tags=outbound_pending&limit=50`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    const contacts = res.data?.contacts || [];
    if (!contacts.length) {
      console.log('[Outbound] No pending prospects today.');
      return { sent: 0 };
    }

    let sent = 0;
    for (const contact of contacts) {
      const name     = contact.firstName || 'dueño de negocio';
      const business = contact.companyName || 'tu negocio';
      const city     = contact.city || 'Tampa';
      const industry = contact.tags?.find(t => ['restaurant','construccion','gym','tattoo','fitness'].some(k => t.toLowerCase().includes(k))) || '';

      // Generate personalized outreach via Claude
      const msg = await anthropic.messages.create({
        model: 'claude-opus-4-6',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Eres Jose Rivas, fundador de JRZ Marketing — una agencia de marketing bilingüe (español e inglés) en Florida que ayuda a dueños de negocios hispanos a capturar más clientes y automatizar su seguimiento.

Escribe un mensaje de prospección corto, directo y personal para ${name}, dueño/a de ${business} en ${city}${industry ? `, en la industria de ${industry}` : ''}.

Contexto del cliente ideal: dueño hispano de negocio pequeño o mediano (restaurante, construcción, gimnasio, tattoo, etc.) en Tampa, Orlando o Miami. Tiene 30+ años. Trabaja duro pero pierde clientes por falta de seguimiento o sistema organizado.

Tono: estratégico, confiado, cálido. Habla de oportunidad, no de problemas. Como si fueras un colega exitoso que quiere ayudar.

Reglas:
- Máximo 4 oraciones
- En español (menciona que somos bilingües)
- Termina con UNA pregunta sobre su mayor reto para conseguir o retener clientes
- No uses hashtags, emojis ni jerga de vendedor
- No menciones precios
- Sé específico a su industria o ciudad si puedes`,
        }],
      });

      const outboundMsg = msg.content[0].text.trim();

      // Send via GHL
      try {
        await sendEmail(contact.id, `${name}, ¿estás capturando todos tus clientes potenciales?`, `<p>${outboundMsg}</p><p style="color:#666;font-size:12px">Jose Rivas · JRZ Marketing · Bilingüe: English / Español · jrzmarketing.com · (407) 844-6376</p>`);

        // Move from outbound_pending → outbound_sent + add to pipeline
        await axios.post(
          `https://services.leadconnectorhq.com/contacts/${contact.id}/tags`,
          { tags: ['outbound_sent'] },
          { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
        );
        await axios.delete(
          `https://services.leadconnectorhq.com/contacts/${contact.id}/tags`,
          { data: { tags: ['outbound_pending'] }, headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
        );
        await createOpportunity(contact.id, `${name} — ${business}`, PIPELINE_STAGES.newLead);
        await tagContact(contact.id, ['nurture-sequence']);

        sent++;
        console.log(`[Outbound] ✅ Sent to ${name} (${business})`);
        // Small delay between messages to avoid rate limits
        await new Promise(r => setTimeout(r, 2000));
      } catch (err) {
        console.error(`[Outbound] ❌ Failed for ${contact.id}:`, err?.response?.data || err.message);
      }
    }

    console.log(`[Outbound] ✅ Done — ${sent}/${contacts.length} messages sent today`);
    return { sent, total: contacts.length };
  } catch (err) {
    console.error('[Outbound] ❌ Outbound run failed:', err.message);
    return { sent: 0, error: err.message };
  }
}

// ═══════════════════════════════════════════════════════════
// SOCIAL MEDIA AUTOMATION FUNCTIONS
// ═══════════════════════════════════════════════════════════

// ─── Build a Reel from carousel slides via FFmpeg → upload to Cloudinary ────
// opts.maxSlides: how many slides to use (default 4 = 28s, use 3 for 15s)
// opts.slideDuration: seconds per slide (default 7 for carousel, 5 for short Reels)
// opts.publicIdSuffix: extra suffix for Cloudinary public_id (e.g. '_short')
// Returns permanent Cloudinary video URL, or null on failure

// Schedule a post via GHL Social Media API
// Pass media = [{ url, type: 'image' }] array for Instagram image posts
async function schedulePost({ caption, accountIds, type = 'post', scheduleDate, media }) {
  const body = {
    accountIds,
    type,
    userId: GHL_USER_ID,
    status: 'scheduled',
    summary: caption,
    scheduleDate: scheduleDate.toISOString(),
    scheduleTimeUpdated: true,
  };
  body.media = (media && media.length) ? media : [];
  const res = await axios.post(
    `https://services.leadconnectorhq.com/social-media-posting/${GHL_LOCATION_ID}/posts`,
    body,
    {
      headers: {
        Authorization: `Bearer ${GHL_API_KEY}`,
        Version: '2021-07-28',
        'Content-Type': 'application/json',
      },
    }
  );
  return res.data;
}

// Use NewsAPI + Claude to generate fresh Spanish content (week 3+ fallback)
async function generateNewsCaption() {
  try {
    const newsRes = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q: 'inteligencia artificial negocios automatizacion marketing digital',
        language: 'es',
        sortBy: 'popularity',
        pageSize: 5,
        apiKey: NEWS_API_KEY,
      },
    });

    let articles = newsRes.data?.articles || [];
    if (!articles.length) {
      // Fallback: search in English
      const fallbackRes = await axios.get('https://newsapi.org/v2/everything', {
        params: {
          q: 'artificial intelligence business automation marketing',
          language: 'en',
          sortBy: 'popularity',
          pageSize: 5,
          apiKey: NEWS_API_KEY,
        },
      });
      articles = fallbackRes.data?.articles || [];
    }

    const headlines = articles.slice(0, 3).map(a => `• ${a.title}`).join('\n');
    if (!headlines) throw new Error('No articles found');

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are Marco, Content Director at JRZ Marketing. José Rivas is the CEO — AI & automation expert for Latino entrepreneurs in Orlando, FL. Audience: 53% men, 25-34, small Latino business owners.

Today's trending news:
${headlines}

CAPTION ENGINE RULES (apply all):
1. HOOK (first line): Use the Who/What/How framework — answer in one line: WHO is this for? WHAT is it about? HOW does it help them? Use a pattern interrupt, contrarian angle, or curiosity gap. Make it impossible to scroll past.
2. EMOTIONAL STORYTELLING: Write at grade 6-7 readability. Sound human and reflective — NOT robotic or salesy. Use conversational language with subtle authority.
3. STRUCTURE for saves (carousel format): Step-by-step blueprint OR checklist OR myth vs truth OR before/after transformation. High educational density = people save it to use later.
4. SAVE TRIGGER: Include one line that explicitly tells them to save (e.g. "Guarda esto para cuando lo necesites" or "Save this — you'll thank me later").
5. COMMENT TRIGGER: End with a question that creates genuine discussion.
6. CTA: Natural, not pushy — "Agenda gratis → ${BOOKING_URL}"
7. HASHTAGS: 8-10 niche-relevant tags at the end.

Write the full Spanish post (max 1,800 chars). Post text only, no explanations.`,
      }],
    });

    return response.content[0].text.trim();
  } catch (err) {
    console.error('News content generation failed:', err.message, '— using pre-written fallback');
    const { script } = getTodaysScript();
    return script.caption;
  }
}

// Exchange agency key for a location-level OAuth token (scoped for Blog API write access)
// PITs do not have blogs.write scope — GHL Blog API returns 403 unless you use an OAuth token.
const _jrzTokenCache = { token: null, expires: 0 };
async function getJRZOAuthToken() {
  if (_jrzTokenCache.token && Date.now() < _jrzTokenCache.expires) return _jrzTokenCache.token;
  try {
    const res = await axios.post(
      'https://services.leadconnectorhq.com/oauth/locationToken',
      { companyId: GHL_COMPANY_ID, locationId: GHL_LOCATION_ID },
      { headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    const token = res.data?.access_token;
    if (token) {
      _jrzTokenCache.token = token;
      _jrzTokenCache.expires = Date.now() + 23 * 60 * 60 * 1000;
      console.log('[Blog] ✅ OAuth token exchanged for JRZ Marketing');
      return token;
    }
  } catch (err) {
    console.error('[Blog] ⚠️ OAuth exchange failed, falling back to PIT key:', err?.response?.data?.message || err.message);
  }
  return GHL_API_KEY; // fallback
}

// Generate and publish a daily English blog post via GHL Blogs API
async function createDailyBlog(topic, caption) {
  try {
    console.log(`[Blog] Generating English blog post for: "${topic}"...`);

    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are the content writer for JRZ Marketing, a bilingual AI automation and digital marketing agency in Orlando, FL. José Rivas is the founder and CEO.

Write a complete, SEO-optimized blog post in ENGLISH about:
"${topic}"

The post should:
- Be 600-900 words
- Have a compelling H2 introduction
- Include 3-4 H3 subheadings with practical content
- Position Jose Rivas / JRZ Marketing as the AI automation authority for Latino entrepreneurs
- Include a clear CTA at the end: "Book your free strategy call at jrzmarketing.com/contact-us"
- Include real, actionable advice with specific examples and numbers
- Include 2–3 natural internal backlinks using <a href="..."> tags:

CRITICAL — WRITE LIKE A REAL HUMAN EXPERT, NOT AN AI:
- Use contractions naturally (you'll, don't, it's, we're, that's)
- Mix short punchy sentences with longer ones — vary the rhythm
- Start paragraphs in different ways — not always "The" or "This"
- Use "you" and occasionally "I" — write directly to the reader
- Include specific real-world examples, not vague claims
- NEVER use: "In today's digital age", "It's no secret", "In conclusion", "Furthermore", "Moreover", "Game-changing", "Leverage", "Robust", "Delve into", "Navigate the landscape", "In the ever-evolving"
- NO perfectly parallel bullet points all the same length — vary them
- Sound like a knowledgeable friend giving advice, not a corporate blog
  * Link "AI marketing automation" or similar to: https://jrzmarketing.com
  * Link "book a free strategy call" to: https://jrzmarketing.com/contact-us
  * Link one relevant phrase to: https://jrzmarketing.com/blog (e.g. "read more on our blog")
- These links must feel natural in the sentence — not forced

Format: Return ONLY the HTML body content (no <html>, <head>, or <body> tags). Start with <h2>. Include <p>, <ul>, <li>, <h3>, <strong>, <a> tags as needed.`,
      }],
    });

    const rawHTML = response.content[0].text.trim();

    // Build SEO-friendly slug from topic
    const urlSlug = topic
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60)
      + '-' + Date.now().toString(36);

    // Pick categories based on content
    const categories = [
      BLOG_CATEGORIES.marketing,
      BLOG_CATEGORIES.ai,
      BLOG_CATEGORIES.business,
    ];

    const publishedAt = new Date();
    publishedAt.setUTCHours(13, 0, 0, 0); // 8am EST

    const blogToken = await getJRZOAuthToken();
    const res = await axios.post(
      'https://services.leadconnectorhq.com/blogs/posts',
      {
        title: topic,
        locationId: GHL_LOCATION_ID,
        blogId: BLOG_ID,
        description: caption.slice(0, 200).replace(/[#\n]/g, ' ').trim(),
        imageUrl: 'https://msgsndr-private.storage.googleapis.com/locationPhotos/bf4cfbc0-6359-4e62-a0fa-de3af69d3218.png',
        imageAltText: `JRZ Marketing — ${topic}`,
        author: BLOG_AUTHOR_ID,
        categories,
        tags: ['JRZ Marketing', 'AI automation', 'marketing', 'digital marketing'],
        urlSlug,
        status: 'PUBLISHED',
        publishedAt: publishedAt.toISOString(),
        rawHTML,
      },
      {
        headers: {
          Authorization: `Bearer ${blogToken}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`[Blog] ✅ Blog post published: "${topic}" — ID: ${res.data?.blogPost?._id}`);
    return { success: true, title: topic, id: res.data?.blogPost?._id };
  } catch (err) {
    console.error('[Blog] ❌ Failed to create blog post:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// ─── DATAFORSEO HELPERS ──────────────────────────────────────────────────────────────────────

// Returns monthly search volume + competition for up to 10 keywords (USA, English)
async function getKeywordMetrics(keywords) {
  if (!DATAFORSEO_PASSWORD || !keywords.length) return [];
  try {
    const auth = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
    const res = await axios.post(
      `${DATAFORSEO_BASE}/v3/keywords_data/google_ads/search_volume/live`,
      [{ keywords: keywords.slice(0, 10), language_code: 'en', location_code: 2840 }],
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const items = res.data?.tasks?.[0]?.result || [];
    return items.map(r => ({
      keyword:      r.keyword,
      searchVolume: r.search_volume || 0,
      competition:  r.competition_level || 'UNKNOWN',
      cpc:          +(r.cpc || 0).toFixed(2),
    }));
  } catch (err) {
    console.error('[DataForSEO] Keyword metrics error:', err?.response?.data || err.message);
    return [];
  }
}

// Returns position (1–100) where jrzmarketing.com ranks for a keyword, or null if not found
async function checkSERPPosition(keyword, domain = 'jrzmarketing.com') {
  if (!DATAFORSEO_PASSWORD) return null;
  try {
    const auth = Buffer.from(`${DATAFORSEO_LOGIN}:${DATAFORSEO_PASSWORD}`).toString('base64');
    const res = await axios.post(
      `${DATAFORSEO_BASE}/v3/serp/google/organic/live/advanced`,
      [{ keyword, location_code: 2840, language_code: 'en', depth: 30 }],
      { headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' }, timeout: 20000 }
    );
    const items = res.data?.tasks?.[0]?.result?.[0]?.items || [];
    const match = items.find(item => item.url && item.url.includes(domain));
    return match ? match.rank_absolute : null;
  } catch (err) {
    console.error('[DataForSEO] SERP check error:', err?.response?.data || err.message);
    return null;
  }
}

// Sofia's weekly keyword rank report — checks 10 core JRZ Marketing target keywords,
// compares to last week's positions (stored in Cloudinary), emails Jose the delta.
const DATAFORSEO_SNAPSHOT_PID = 'jrz/keyword_rankings_snapshot';
const JRZ_TARGET_KEYWORDS = [
  'AI marketing agency Orlando',
  'marketing automation Orlando',
  'digital marketing agency Orlando FL',
  'AI automation for small business Orlando',
  'social media marketing Orlando',
  'lead generation agency Orlando',
  'GHL Go High Level agency Orlando',
  'bilingual marketing agency Orlando',
  'Latino marketing agency Florida',
  'marketing agency for restaurants Orlando',
];

async function runSofiaKeywordTracker() {
  try {
    console.log('[SEO Tracker] Sofia: checking keyword rankings...');

    // Load last week's snapshot from Cloudinary
    let lastSnapshot = {};
    try {
      const snap = await axios.get(
        `https://res.cloudinary.com/dbsuw1mfm/raw/upload/${DATAFORSEO_SNAPSHOT_PID}.json`,
        { timeout: 8000 }
      );
      lastSnapshot = snap.data || {};
    } catch (_) { /* first run — no snapshot yet */ }

    // Check current positions for all target keywords
    const results = [];
    for (const kw of JRZ_TARGET_KEYWORDS) {
      const position = await checkSERPPosition(kw);
      const prev = lastSnapshot[kw] || null;
      const delta = (position && prev) ? prev - position : null; // positive = moved up
      results.push({ keyword: kw, position, prev, delta });
      await new Promise(r => setTimeout(r, 500)); // rate limit — DataForSEO allows ~1 req/sec
    }

    // Save new snapshot
    const newSnapshot = {};
    results.forEach(r => { if (r.position) newSnapshot[r.keyword] = r.position; });
    try {
      const ts = Math.floor(Date.now() / 1000);
      const sigStr = `overwrite=true&public_id=${DATAFORSEO_SNAPSHOT_PID}&timestamp=${ts}${process.env.CLOUDINARY_API_SECRET}`;
      const sig = crypto.createHash('sha1').update(sigStr).digest('hex');
      const fd = new FormData();
      fd.append('file', Buffer.from(JSON.stringify(newSnapshot)), { filename: 'data.json', contentType: 'application/json' });
      fd.append('public_id', DATAFORSEO_SNAPSHOT_PID);
      fd.append('overwrite', 'true');
      fd.append('timestamp', ts);
      fd.append('api_key', '984314321446626');
      fd.append('signature', sig);
      await axios.post('https://api.cloudinary.com/v1_1/dbsuw1mfm/raw/upload', fd, { headers: fd.getHeaders(), timeout: 15000 });
    } catch (snapErr) {
      console.error('[SEO Tracker] Snapshot save failed:', snapErr.message);
    }

    // Build email report
    const ranked   = results.filter(r => r.position && r.position <= 10);
    const page2    = results.filter(r => r.position && r.position > 10 && r.position <= 30);
    const improved = results.filter(r => r.delta && r.delta > 0);
    const dropped   = results.filter(r => r.delta && r.delta < 0);

    const arrow = (delta) => delta > 0 ? `▲${delta}` : delta < 0 ? `▼${Math.abs(delta)}` : '—';
    const rowColor = (pos) => pos <= 3 ? '#16a34a' : pos <= 10 ? '#2563eb' : pos <= 30 ? '#d97706' : '#dc2626';

    const rows = results.map(r => `
      <tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb">${r.keyword}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;font-weight:700;color:${r.position ? rowColor(r.position) : '#9ca3af'}">
          ${r.position ? `#${r.position}` : 'Not ranked'}
        </td>
        <td style="padding:8px 12px;border-bottom:1px solid #e5e7eb;text-align:center;color:${r.delta > 0 ? '#16a34a' : r.delta < 0 ? '#dc2626' : '#6b7280'}">
          ${r.prev ? arrow(r.delta) : '—'}
        </td>
      </tr>`).join('');

    const html = `
      <div style="font-family:Arial,sans-serif;max-width:700px;margin:0 auto">
        <div style="background:#0f172a;padding:24px;border-radius:12px 12px 0 0">
          <h1 style="color:#fff;margin:0;font-size:22px">🎯 JRZ Marketing — Keyword Rankings</h1>
          <p style="color:#94a3b8;margin:6px 0 0">Sofia's weekly SEO tracker • ${new Date().toLocaleDateString('en-US',{weekday:'long',year:'numeric',month:'long',day:'numeric'})}</p>
        </div>
        <div style="background:#f8fafc;padding:20px">
          <div style="display:flex;gap:12px;margin-bottom:20px">
            <div style="flex:1;background:#fff;padding:16px;border-radius:8px;text-align:center;border:2px solid #16a34a">
              <div style="font-size:28px;font-weight:700;color:#16a34a">${ranked.length}</div>
              <div style="color:#6b7280;font-size:12px">PAGE 1 (Top 10)</div>
            </div>
            <div style="flex:1;background:#fff;padding:16px;border-radius:8px;text-align:center;border:2px solid #d97706">
              <div style="font-size:28px;font-weight:700;color:#d97706">${page2.length}</div>
              <div style="color:#6b7280;font-size:12px">PAGE 2 (Striking distance)</div>
            </div>
            <div style="flex:1;background:#fff;padding:16px;border-radius:8px;text-align:center;border:2px solid #16a34a">
              <div style="font-size:28px;font-weight:700;color:#16a34a">+${improved.length}</div>
              <div style="color:#6b7280;font-size:12px">IMPROVED</div>
            </div>
            <div style="flex:1;background:#fff;padding:16px;border-radius:8px;text-align:center;border:2px solid #dc2626">
              <div style="font-size:28px;font-weight:700;color:#dc2626">-${dropped.length}</div>
              <div style="color:#6b7280;font-size:12px">DROPPED</div>
            </div>
          </div>
          <table style="width:100%;background:#fff;border-radius:8px;border-collapse:collapse">
            <thead>
              <tr style="background:#f1f5f9">
                <th style="padding:10px 12px;text-align:left;font-size:12px;color:#64748b;text-transform:uppercase">KEYWORD</th>
                <th style="padding:10px 12px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">POSITION</th>
                <th style="padding:10px 12px;text-align:center;font-size:12px;color:#64748b;text-transform:uppercase">CHANGE</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          ${page2.length > 0 ? `
          <div style="background:#fffbeb;border:1px solid #fbbf24;padding:16px;border-radius:8px;margin-top:16px">
            <strong>🎯 Striking Distance — Daily SEO Blog Targets:</strong>
            <ul style="margin:8px 0 0;padding-left:20px;color:#92400e">
              ${page2.map(r => `<li>${r.keyword} (currently #${r.position})</li>`).join('')}
            </ul>
          </div>` : ''}
        </div>
      </div>`;

    await sendEmail(OWNER_CONTACT_ID, `🎯 Keyword Rankings Report — ${ranked.length} on Page 1`, html);
    console.log(`[SEO Tracker] ✅ Report sent — ${ranked.length} on page 1, ${page2.length} striking distance`);
    return { success: true, page1: ranked.length, page2: page2.length, improved: improved.length };

  } catch (err) {
    console.error('[SEO Tracker] ❌ Error:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// ─── DAILY SEO BLOG: Isabella targets striking-distance keywords from Google Search Console ────
// Runs daily at 7:10am EST. Finds keywords ranking 11–30 (page 2 = easiest to push to page 1),
// writes a 1000-word SEO-optimized post via Claude Opus, and publishes it on jrzmarketing.com.
async function runDailySeoBlog() {
  try {
    console.log('[SEO Blog] Isabella: starting daily SEO blog generation...');

    // Step 1: Get Google access token for Search Console
    const token = await getGoogleAccessToken();
    if (!token) {
      console.warn('[SEO Blog] No GSC token — skipping');
      return { success: false, reason: 'no_gsc_token' };
    }

    // Step 2: Fetch top 50 keywords by impressions (last 90 days = more data for better targeting)
    const siteUrl = encodeURIComponent('https://jrzmarketing.com/');
    const today = new Date();
    const endDate = today.toISOString().split('T')[0];
    const startDate = new Date(today - 90 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const gscRes = await axios.post(
      `https://www.googleapis.com/webmasters/v3/sites/${siteUrl}/searchAnalytics/query`,
      {
        startDate,
        endDate,
        dimensions: ['query'],
        rowLimit: 50,
        orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }],
      },
      { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
    );

    const rows = gscRes.data?.rows || [];

    // Step 3: Find striking-distance keywords (position 11–30 = page 2, easiest to rank on page 1)
    const strikingDistance = rows.filter(r => r.position >= 11 && r.position <= 30);

    let targetKeyword, targetPosition, targetImpressions;

    if (strikingDistance.length > 0) {
      // Best opportunity = highest impressions at position 11–30 (most searches, not yet ranking)
      const best = strikingDistance.sort((a, b) => b.impressions - a.impressions)[0];
      targetKeyword    = best.keys[0];
      targetPosition   = best.position.toFixed(1);
      targetImpressions = best.impressions;
    } else if (rows.length > 0) {
      // Fallback: keyword with most impressions but low CTR = underperforming, needs better content
      const sorted = rows.sort((a, b) => b.impressions - a.impressions);
      targetKeyword    = sorted[0].keys[0];
      targetPosition   = sorted[0].position.toFixed(1);
      targetImpressions = sorted[0].impressions;
    } else {
      // No GSC data yet — use a proven high-value topic
      targetKeyword    = 'AI marketing automation for small businesses Orlando';
      targetPosition   = null;
      targetImpressions = null;
    }

    // Step 3b: Use DataForSEO to get monthly search volume for top candidates
    // and upgrade our keyword choice from "most impressions" to "most monthly searches"
    if (strikingDistance.length > 1 && DATAFORSEO_PASSWORD) {
      const topCandidates = strikingDistance
        .sort((a, b) => b.impressions - a.impressions)
        .slice(0, 5)
        .map(r => r.keys[0]);
      const metrics = await getKeywordMetrics(topCandidates);
      if (metrics.length > 0) {
        const best = metrics.sort((a, b) => b.searchVolume - a.searchVolume)[0];
        const original = strikingDistance.find(r => r.keys[0] === best.keyword);
        if (original) {
          targetKeyword     = best.keyword;
          targetPosition    = original.position.toFixed(1);
          targetImpressions = `${best.searchVolume.toLocaleString()} searches/mo`;
        }
      }
    }

    console.log(`[SEO Blog] Target keyword: "${targetKeyword}" (pos: ${targetPosition}, volume: ${targetImpressions})`);

    // Step 4: Write an SEO-optimized blog post via Claude Opus
    const blogResponse = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 3000,
      messages: [{
        role: 'user',
        content: `You are Isabella, the SEO Content Strategist for JRZ Marketing — a bilingual AI automation and digital marketing agency in Orlando, FL. José Rivas is the founder and CEO.

Your task: Write a highly SEO-optimized blog post that will help jrzmarketing.com rank on page 1 of Google for the target keyword.

TARGET KEYWORD: "${targetKeyword}"
${targetPosition ? `CURRENT GOOGLE POSITION: ${targetPosition} (page 2 — push this to page 1)` : ''}
${targetImpressions ? `MONTHLY IMPRESSIONS: ${targetImpressions} (people are actively searching this)` : ''}

REQUIREMENTS:
- Length: 900–1200 words
- Use the exact target keyword in: title, first paragraph, at least 2 H2/H3 headings, and the conclusion
- Include LSI keywords (related terms, synonyms) naturally throughout
- Include specific Orlando / Central Florida references to boost local SEO
- Structure: compelling intro (state the problem) → 3–4 H2 sections with actionable advice → local relevance section → strong CTA
- CTA at the end: "Ready to dominate Google in Orlando? Book your free strategy call at jrzmarketing.com/contact-us"
- Tone: confident expert speaking directly to the reader — not corporate, not salesy
- Include at least one numbered list or bullet list (helps Google feature snippets)
- End with a FAQ section: 2–3 questions targeting "People Also Ask" (format as <h3>Q:</h3><p>A:</p>)

CRITICAL — WRITE LIKE A REAL HUMAN EXPERT, NOT AN AI:
- Use contractions naturally (you'll, don't, it's, we're, that's, here's)
- Mix short punchy sentences with longer ones — vary the rhythm constantly
- Use "you" throughout — write directly to the reader like you're talking to them
- Specific real examples and numbers (e.g. "a client went from 12 leads to 47 in 60 days") not vague claims
- Start paragraphs differently — questions, statements, observations, stories
- NEVER use: "In today's digital age", "It's no secret", "In conclusion", "Furthermore", "Moreover", "Additionally", "Game-changing", "Leverage", "Robust", "Delve into", "Seamlessly", "Navigate the landscape", "In the ever-evolving", "Look no further"
- NO perfectly parallel bullet points all the same length
- Occasional imperfect sentence — real writers don't always write perfect prose
- Sound like the smartest person in the room who also happens to be easy to talk to

Return ONLY a valid JSON object — no markdown, no code fences — with these exact fields:
{
  "title": "the blog post title (include exact keyword naturally, 50–60 chars ideal)",
  "metaDescription": "150–160 char SEO meta description with the target keyword",
  "htmlContent": "the full blog post HTML using only <h2>, <h3>, <p>, <ul>, <li>, <ol>, <strong>, <em> — NO <html>, <head>, <body> tags"
}`,
      }],
    });

    // Step 5: Parse Claude's JSON response
    let parsed;
    try {
      const raw = blogResponse.content[0].text.trim();
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      parsed = JSON.parse(jsonMatch[0]);
    } catch (parseErr) {
      console.error('[SEO Blog] Failed to parse Claude response:', parseErr.message);
      return { success: false, reason: 'parse_error' };
    }

    const { title, metaDescription, htmlContent } = parsed;

    // Step 6: Build SEO-friendly slug
    const urlSlug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .slice(0, 60)
      + '-' + Date.now().toString(36);

    // Step 7: Publish via GHL Blogs API (9am EST = offset from daily post at 8am)
    const publishedAt = new Date();
    publishedAt.setUTCHours(14, 0, 0, 0); // 9am EST

    const postRes = await axios.post(
      'https://services.leadconnectorhq.com/blogs/posts',
      {
        title,
        locationId: GHL_LOCATION_ID,
        blogId: BLOG_ID,
        description: metaDescription,
        imageUrl: 'https://msgsndr-private.storage.googleapis.com/locationPhotos/bf4cfbc0-6359-4e62-a0fa-de3af69d3218.png',
        imageAltText: `JRZ Marketing — ${title}`,
        author: BLOG_AUTHOR_ID,
        categories: [BLOG_CATEGORIES.marketing, BLOG_CATEGORIES.ai, BLOG_CATEGORIES.business],
        tags: ['JRZ Marketing', 'SEO', 'Orlando', ...targetKeyword.split(' ').slice(0, 3)],
        urlSlug,
        status: 'PUBLISHED',
        publishedAt: publishedAt.toISOString(),
        rawHTML: htmlContent,
      },
      {
        headers: {
          Authorization: `Bearer ${GHL_API_KEY}`,
          Version: '2021-07-28',
          'Content-Type': 'application/json',
        },
      }
    );

    const postId = postRes.data?.blogPost?._id;
    console.log(`[SEO Blog] ✅ Published: "${title}" targeting "${targetKeyword}" — ID: ${postId}`);

    // Save to blog history for learning loop (JRZ Marketing)
    loadBlogHistory().then(hist => {
      if (!hist['d7iUPfamAaPlSBNj6IhT']) hist['d7iUPfamAaPlSBNj6IhT'] = [];
      hist['d7iUPfamAaPlSBNj6IhT'].push({ keyword: targetKeyword, baseKeyword: targetKeyword.split(' ').slice(0,3).join(' '), title, url: `https://jrzmarketing.com/post/${postId}`, date: new Date().toISOString().split('T')[0], clicks: null, impressions: null, position: null, gscChecked: false });
      return saveBlogHistory(hist);
    }).catch(() => null);

    return { success: true, title, keyword: targetKeyword, position: targetPosition, postId };

  } catch (err) {
    console.error('[SEO Blog] ❌ Error:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// Schedule today's carousel post on all platforms at 8am EST + publish daily blog
async function runDailyPost() {
  console.log('[Social] Running daily post scheduler...');
  setAgentBusy('marco', 'Publishing daily carousel + blog post');
  logActivity('marco', 'action', 'Daily post cycle started — selecting content & generating captions');

  // Pick content: pre-written scripts cycle first, then NewsAPI + Claude
  const { script } = getTodaysScript();
  let caption = script.caption;
  let title   = script.title;

  const now = new Date();
  const start = new Date(now.getFullYear(), 0, 1);
  const dayOfYear = Math.ceil((now - start) / 86400000);
  if (dayOfYear > CAROUSEL_SCRIPTS.length * 2) {
    console.log('[Social] Generating fresh content via NewsAPI + Claude...');
    caption = await generateNewsCaption();
    title   = 'AI-generated — ' + new Date().toLocaleDateString('en-US');
  }

  // Schedule for 8am EST (12:00 UTC during EDT, 13:00 during EST)
  const postTime = new Date();
  postTime.setUTCHours(12, 0, 0, 0); // 8am EDT (UTC-4, Mar–Nov)
  if (postTime < new Date()) {
    postTime.setDate(postTime.getDate() + 1);
  }

  // ── Get today's carousel images from Cloudinary ──
  const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const dayIdx = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayOfWeek.substring(0, 3));
  const todayImages = CAROUSEL_IMAGES[dayIdx >= 0 ? dayIdx : new Date().getDay()];
  const instagramMedia = todayImages.map(url => ({ url, type: 'image/png' }));

  // ── Social post — Facebook, LinkedIn, YouTube, Google (with carousel images) ──
  let socialResult = { success: false };
  try {
    const result = await schedulePost({
      caption,
      accountIds: TEXT_POST_ACCOUNTS,
      type: 'post',
      scheduleDate: postTime,
      media: instagramMedia,
    });
    console.log(`[Social] ✅ Text post scheduled for ${postTime.toISOString()} — "${title}"`);
    socialResult = { success: true, title, scheduledFor: postTime.toISOString(), result };
  } catch (err) {
    console.error('[Social] ❌ Failed to schedule text post:', err?.response?.data || err.message);
    socialResult = { success: false, error: err.message };
  }

  // Instagram daily post disabled — user paused 2026-03-26
  const instagramResult = { success: false, skipped: true, reason: 'Instagram paused' };

  // ── Blog post (English, published same day) ──
  const blogResult = await createDailyBlog(title, caption);

  return { social: socialResult, instagram: instagramResult, blog: blogResult };
}

// Schedule today's story at 7pm EST
async function runDailyStory() {
  console.log('[Social] Running daily story scheduler...');

  const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const dayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayOfWeek.substring(0, 3));
  const idx = dayIndex >= 0 ? dayIndex : new Date().getDay();
  const template = STORY_TEMPLATES[idx];

  // Schedule for 7pm EST today — 23:00 UTC works for EDT (UTC-4)
  const storyTime = new Date();
  storyTime.setUTCHours(23, 0, 0, 0);
  if (storyTime < new Date()) {
    storyTime.setDate(storyTime.getDate() + 1);
  }

  // Stories require at least one image — use first carousel image for today
  const todayImages = CAROUSEL_IMAGES[idx];
  const storyMedia = [{ url: todayImages[0], type: 'image/png' }];

  try {
    const result = await schedulePost({
      caption: template.text,
      accountIds: STORY_ACCOUNTS,
      type: 'story',
      scheduleDate: storyTime,
      media: storyMedia,
    });
    console.log(`[Social] ✅ Story scheduled for ${storyTime.toISOString()} — "${template.cta}"`);
    return { success: true, cta: template.cta, scheduledFor: storyTime.toISOString(), result };
  } catch (err) {
    console.error('[Social] ❌ Failed to schedule story:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// Generate viral hook content via Claude — uses weekly learned strategy
async function generateViralReelContent(topic) {
  const strategy = await loadContentStrategy();
  const strategyContext = strategy ? `
ESTRATEGIA APRENDIDA (basada en datos reales de tu audiencia):
- Mejores temas: ${(strategy.bestTopics || []).join(', ')}
- Estilo de hook que más funciona: ${strategy.bestHookStyle || 'preguntas directas'}
- Fórmulas de hook probadas: ${(strategy.hookFormulas || []).join(' | ')}
- Insights de audiencia: ${strategy.audienceInsights || '25-34 años, dueños de negocios'}
- Evitar: ${(strategy.avoidTopics || []).join(', ') || 'nada aún'}
- Notas de la semana: ${strategy.weeklyNotes || 'primera semana'}
` : '';

  const msg = await anthropic.messages.create({
    model: 'claude-opus-4-6',
    max_tokens: 600,
    messages: [{
      role: 'user',
      content: `You are Marco, Content Director at JRZ Marketing. Create a HIGH-RETENTION 15-second Instagram Reel script in SPANISH for José Rivas (AI & automation expert for Latino entrepreneurs, Orlando FL).
${strategyContext}
Topic: "${topic}"

HIGH-RETENTION SCRIPT BUILDER RULES:
1. CHOOSE THE BEST FRAMEWORK for this topic: AIDA (Attention-Interest-Desire-Action), PAS (Problem-Agitate-Solution), Open Loop (start a story you complete at the end), Story-Bridge-Offer, Before-After-Bridge, or 4U (Urgent-Unique-Ultra-specific-Useful). Pick the one that maximizes completion rate for this specific topic.
2. HOOK: First 2 seconds must stop the scroll. Use Who/What/How — instantly communicate who it's for, what it's about, how it helps. Pattern interrupt or contrarian angle preferred over clever phrasing.
3. CREATE TENSION before delivering value — build curiosity that sustains attention until the final line.
4. STRUCTURE creates completion. Completion drives distribution. Every word must pull the viewer forward.

Return ONLY valid JSON:
{
  "framework": "name of chosen framework and ONE sentence why you chose it",
  "hook": "2-4 WORDS IN CAPS (pattern interrupt or contrarian angle)",
  "hook_sub": "1-2 lines expanding the hook\\nsecond line if needed",
  "content": ["→  point 1 (tension builds)", "→  point 2 (value appears)", "→  point 3 (payoff)"],
  "climax1": "2-3 IMPACT WORDS",
  "climax2": "FINAL PUNCHLINE IN CAPS.",
  "climax_sub": "powerful closing line that makes them want to share"
}

No hashtags in JSON. Direct style. Every line earns the next.`,
    }],
  });
  const raw = msg.content[0].text.trim();
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('No JSON in reel content response');
  return JSON.parse(match[0]);
}

// ── Build a natural voiceover script from reel content ───────────────────────
function buildVoiceoverScript(content) {
  const lines = [];

  // Hook — question/statement
  const hook = (content.hook + ' ' + (content.hook_sub || '')).replace(/\n/g, ' ').trim();
  lines.push(hook);

  // Content bullets — strip arrow symbols, read naturally
  if (Array.isArray(content.content)) {
    content.content.slice(0, 3).forEach(function (b) {
      lines.push(b.replace(/^[→\-•]\s*/, '').trim());
    });
  }

  // Climax
  const climax = ((content.climax1 || '') + ' ' + (content.climax2 || '') + '. ' + (content.climax_sub || '')).trim();
  if (climax) lines.push(climax);

  // CTA
  lines.push('Agenda tu consulta gratis en jrzmarketing.com');

  return lines.join('. ');
}

// ── ElevenLabs TTS → save MP3 ────────────────────────────────────────────────
async function generateElevenLabsAudio(text, audioPath) {
  try {
    const response = await axios.post(
      `https://api.elevenlabs.io/v1/text-to-speech/${ELEVENLABS_VOICE_ID}`,
      { text, model_id: 'eleven_multilingual_v2', voice_settings: { stability: 0.45, similarity_boost: 0.80, style: 0.35, use_speaker_boost: true } },
      {
        headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
        responseType: 'arraybuffer',
        timeout: 30000
      }
    );
    fs.writeFileSync(audioPath, Buffer.from(response.data));
    console.log('[Voice] ✅ Joseph Corona audio generated:', audioPath);
    return true;
  } catch (err) {
    console.error('[Voice] ❌ ElevenLabs failed:', err?.response?.status, err.message);
    return false;
  }
}

// ── Build a smart, human voice script — continuation of the text reply ───────
async function buildDMVoiceScript(textReply, contactName, originalMessage, contactMemory = {}, competitorInsights = {}, compPainPoints = {}) {
  const nowEST  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const hour    = nowEST.getHours();
  const timeStr = hour < 12 ? 'esta mañana' : hour < 17 ? 'esta tarde' : 'esta noche';

  const [voiceFeedback, engPatterns] = await Promise.all([loadVoiceFeedback(), loadEngagementPatterns()]);

  const prompt = `Eres Armando Rivas, 22 años, venezolano, Community Manager de JRZ Marketing en Orlando, Florida.
Tienes voz — este texto se va a convertir en audio con tu voz real. Habla como si estuvieras grabando un voice note de WhatsApp o Instagram.

CONTEXTO DE LA CONVERSACIÓN:
- Lo que dijo el prospecto: "${originalMessage || 'nos contactó con interés'}"
- Lo que ya le respondiste por texto: "${textReply}"

CONOCIMIENTO DE ESTE PROSPECTO (memoria de conversaciones anteriores):
- Tipo de negocio: ${contactMemory.businessType || 'desconocido'}
- Sus pain points específicos: ${(contactMemory.painPoints || []).join(', ') || 'no identificados aún'}
- Sus intereses: ${(contactMemory.interests || []).join(', ') || 'no identificados aún'}
- Mensajes anteriores: ${contactMemory.messageCount || 0}
${(contactMemory.messageCount || 0) > 0 ? '⚠️ Ya lo conoces — habla como si retomaran una conversación, no como si fuera la primera vez.' : ''}

CONOCIMIENTO DE MERCADO (úsalo inteligentemente):
- La mayoría de negocios latinos en EE.UU. tienen el mismo problema: invierten en redes, en anuncios, en diseñadores — y no ven resultados porque no tienen un SISTEMA.
- Lo que otras agencias NO hacen y JRZ sí: ${(competitorInsights.competitorWeaknesses || []).join(', ') || 'servicio bilingüe real, IA integrada, acompañamiento directo del fundador'}
- Lo que clientes dicen de otras agencias: ${(compPainPoints.painPoints || []).slice(0, 2).join(', ') || 'cobran caro sin resultados, desaparecen después de vender'}
- JRZ Marketing: sistema completo — captación, automatización con IA, contenido viral, seguimiento hasta cerrar. Jose trabaja directo con cada cliente los primeros 30 días.
- Patrones ganadores (clientes que agendaron): ${voiceFeedback.winningPatterns || 'usar empatía y especificidad sobre su negocio'}
- Hooks que funcionaron en contenido reciente: ${(engPatterns.topHooks || []).slice(0, 2).join(' | ') || 'preguntas directas sobre resultados'}

REGLAS DEL MENSAJE DE VOZ:
1. Es la CONTINUACIÓN del texto — no repitas lo mismo, profundiza
2. Muéstrate HUMANO: empático, cálido, inteligente — no genérico
3. Lee entre líneas lo que dijo el prospecto y responde a su NECESIDAD REAL, no solo a sus palabras
4. Menciona la hora del día naturalmente (${timeStr}) — da sensación de presencia real
5. Explica brevemente el PROCESO de JRZ: sistema completo, resultados medibles, acompañamiento real
6. Cierra con UNA sola llamada a la acción: agendar la consulta gratuita de 15 min con Jose HOY
7. Urgencia SUAVE — no presiones, convence con lógica y empatía
8. MÁXIMO 70 palabras — menos de 30 segundos de audio
9. Español latino natural — nada de formal, nada de robótico
10. NO empieces con "Hola" ni "Mira" — empieza de forma única y humana cada vez
11. Sin emojis, sin hashtags — es audio

Escribe SOLO el guión. Sin explicaciones. Sin comillas al inicio o al final.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    return msg.content[0].text.trim();
  } catch (err) {
    return `${timeStr} te grabé este mensaje porque lo que me dijiste tiene solución. En JRZ construimos el sistema completo — captamos los clientes, automatizamos el seguimiento, y creamos el contenido. Todo integrado, todo medible. Jose hace una llamada gratuita de 15 minutos contigo, sin compromiso. Agéndala hoy, los espacios se llenan rápido.`;
  }
}

// ── Generate voice note for DM reply and return Cloudinary URL ───────────────
async function generateDMVoiceNote(text, contactId, contactName, originalMessage, contactMemory = {}, competitorInsights = {}, compPainPoints = {}) {
  const audioPath = `/tmp/jrz_dm_voice_${contactId}_${Date.now()}.mp3`;
  const voiceScript = await buildDMVoiceScript(text, contactName, originalMessage, contactMemory, competitorInsights, compPainPoints);
  console.log('[DM Voice] Script:', voiceScript);
  try {
    const ok = await generateElevenLabsAudio(voiceScript, audioPath);
    if (!ok) return null;

    // Upload MP3 to Cloudinary
    const timestamp  = Math.floor(Date.now() / 1000);
    const publicId   = `jrz/dm_voice_${contactId}_${timestamp}`;
    const sigStr     = `public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature  = crypto.createHash('sha1').update(sigStr).digest('hex');

    const form = new FormData();
    form.append('file',       fs.createReadStream(audioPath));
    form.append('api_key',    CLOUDINARY_API_KEY);
    form.append('timestamp',  String(timestamp));
    form.append('public_id',  publicId);
    form.append('signature',  signature);
    form.append('resource_type', 'video'); // Cloudinary uses "video" for audio

    const upload = await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`,
      form,
      { headers: form.getHeaders(), timeout: 30000 }
    );
    console.log('[DM Voice] ✅ Audio uploaded:', upload.data.secure_url);
    return upload.data.secure_url;
  } catch (err) {
    console.error('[DM Voice] ❌ Voice note failed:', err.message);
    return null;
  } finally {
    try { fs.unlinkSync(audioPath); } catch (_) {}
  }
}

// ── Merge video + audio with ffmpeg ──────────────────────────────────────────
function mergeAudioVideo(videoPath, audioPath, outPath) {
  try {
    execSync(
      `ffmpeg -y -i "${videoPath}" -i "${audioPath}" -c:v copy -c:a aac -shortest -map 0:v:0 -map 1:a:0 "${outPath}"`,
      { timeout: 60000, encoding: 'utf8' }
    );
    console.log('[Voice] ✅ Audio merged into video:', outPath);
    return true;
  } catch (err) {
    console.error('[Voice] ❌ ffmpeg merge failed:', err.message);
    return false;
  }
}

// Canva template base (permanent Cloudinary URL)
const CANVA_TEMPLATE_URL = 'https://res.cloudinary.com/dbsuw1mfm/video/upload/v1773637191/jrz/reel_template_base.mp4';
const CANVA_TEMPLATE_PATH = '/tmp/jrz_canva_template.mp4';

// Download Canva template once and cache it locally
async function ensureTemplate() {
  if (fs.existsSync(CANVA_TEMPLATE_PATH)) return true;
  try {
    const res = await axios.get(CANVA_TEMPLATE_URL, { responseType: 'arraybuffer', timeout: 60000 });
    fs.writeFileSync(CANVA_TEMPLATE_PATH, Buffer.from(res.data));
    console.log('[Template] ✅ Canva template cached locally');
    return true;
  } catch (err) {
    console.error('[Template] ❌ Failed to download template:', err.message);
    return false;
  }
}

// Escape text for ffmpeg drawtext (no single quotes)
function ffmpegEscape(str) {
  return (str || '').replace(/'/g, "\u2019").replace(/:/g, "\\:").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

// Wrap long text into multiple lines (~28 chars per line)
function wrapText(str, maxLen) {
  const words = str.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    if ((line + ' ' + word).trim().length > maxLen) { lines.push(line.trim()); line = word; }
    else line = (line + ' ' + word).trim();
  }
  if (line) lines.push(line.trim());
  return lines.join('\n');
}

// Build viral Reel: Canva template + ffmpeg text overlay + ElevenLabs voice
async function buildViralReel(content, dayIdx) {
  const templatePath = CANVA_TEMPLATE_PATH;
  const textPath     = `/tmp/jrz_viral_reel_text_${dayIdx}.mp4`;
  const audioPath    = `/tmp/jrz_voice_${dayIdx}.mp3`;
  const finalPath    = `/tmp/jrz_viral_reel_${dayIdx}.mp4`;

  try {
    // Step 1 — Ensure Canva template is available
    const ready = await ensureTemplate();
    if (!ready) throw new Error('Template unavailable');

    // Step 2 — Build text strings
    const hook    = ffmpegEscape(wrapText((content.hook || '').replace(/[🔥💥🚀✅⚡🎯💰]/g, '').trim(), 26));
    const sub     = ffmpegEscape(wrapText((content.hook_sub || content.climax1 || '').replace(/[🔥💥🚀✅⚡🎯💰]/g, '').trim(), 30));
    const bullets = Array.isArray(content.content)
      ? content.content.slice(0, 3).map(b => ffmpegEscape(b.replace(/^[→\-•]\s*/, '').replace(/[🔥💥🚀✅⚡🎯💰]/g, '').trim())).join('\n')
      : '';
    const cta     = ffmpegEscape('jrzmarketing.com — Consulta Gratis');

    // Step 3 — Overlay text on Canva template with ffmpeg drawtext
    const drawFilters = [
      // Hook — large bold white text, upper third
      `drawtext=text='${hook}':fontsize=68:fontcolor=white:x=(w-text_w)/2:y=h*0.12:line_spacing=10:font=Liberation Sans Bold:shadowcolor=black:shadowx=3:shadowy=3`,
      // Sub-hook — medium platinum, just below hook
      `drawtext=text='${sub}':fontsize=42:fontcolor=#8A9BA8:x=(w-text_w)/2:y=h*0.38:line_spacing=8:font=Liberation Sans Bold:shadowcolor=black:shadowx=2:shadowy=2`,
      // Bullets — white, middle
      `drawtext=text='${bullets}':fontsize=38:fontcolor=white:x=(w-text_w)/2:y=h*0.54:line_spacing=14:font=Liberation Sans:shadowcolor=black:shadowx=2:shadowy=2`,
      // CTA — bottom platinum
      `drawtext=text='${cta}':fontsize=34:fontcolor=#8A9BA8:x=(w-text_w)/2:y=h*0.88:font=Liberation Sans Bold:shadowcolor=black:shadowx=2:shadowy=2`,
    ].join(',');

    execSync(
      `ffmpeg -y -i "${templatePath}" -vf "${drawFilters}" -c:v libx264 -preset fast -crf 22 -c:a copy "${textPath}"`,
      { timeout: 120000, encoding: 'utf8' }
    );
    console.log('[Reel] ✅ Text overlaid on Canva template');

    // Step 4 — Generate Joseph Corona voiceover
    const voiceScript = buildVoiceoverScript(content);
    console.log('[Voice] Script:', voiceScript);
    const hasAudio = await generateElevenLabsAudio(voiceScript, audioPath);

    // Step 5 — Merge audio + video
    let uploadPath = textPath;
    if (hasAudio) {
      const merged = mergeAudioVideo(textPath, audioPath, finalPath);
      if (merged) uploadPath = finalPath;
    }

    // Step 6 — Upload to Cloudinary
    const publicId  = `jrz/viral_reel_day${dayIdx}`;
    const timestamp = Math.floor(Date.now() / 1000);
    const sigStr    = `overwrite=true&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

    const form = new FormData();
    form.append('file',      fs.createReadStream(uploadPath));
    form.append('public_id', publicId);
    form.append('timestamp', String(timestamp));
    form.append('api_key',   CLOUDINARY_API_KEY);
    form.append('signature', signature);
    form.append('overwrite', 'true');

    await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/video/upload`,
      form,
      { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 120000 }
    );

    [textPath, audioPath, finalPath].forEach(f => { try { fs.unlinkSync(f); } catch (_) {} });

    console.log(`[Reel] ✅ Canva reel uploaded ${hasAudio ? 'with Joseph Corona voice' : '(silent fallback)'}`);
    return `https://res.cloudinary.com/${CLOUDINARY_CLOUD}/video/upload/jrz/viral_reel_day${dayIdx}.mp4`;

  } catch (err) {
    console.error('[Reel] ❌ buildViralReel failed:', err.message);
    return null;
  }
}

// Post a 15-second viral hook Reel at 4pm EST across all video platforms
async function runDailyReel() {
  console.log('[Reel] Running daily 4pm viral Reel...');

  const dayOfWeek = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short' });
  const dayIdx    = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(dayOfWeek.substring(0, 3));
  const safeIdx   = dayIdx >= 0 ? dayIdx : new Date().getDay();

  // Schedule for 4pm EST (20:00 UTC during EDT)
  const reelTime = new Date();
  reelTime.setUTCHours(20, 0, 0, 0);
  if (reelTime < new Date()) reelTime.setDate(reelTime.getDate() + 1);

  // Get today's topic from carousel script
  const { script } = getTodaysScript();

  // Generate viral hook content via Claude
  let content;
  try {
    content = await generateViralReelContent(script.title);
    console.log('[Reel] ✅ Viral content generated:', content.hook);
  } catch (err) {
    console.error('[Reel] ❌ Content generation failed:', err.message);
    return { success: false, error: `Content generation failed: ${err.message}` };
  }

  // Build the video
  const reelUrl = await buildViralReel(content, safeIdx);
  if (!reelUrl) return { success: false, error: 'Video build failed' };

  // Post to all platforms
  try {
    await schedulePost({
      caption: script.caption,
      accountIds: REEL_ACCOUNTS,
      type: 'post',
      scheduleDate: reelTime,
      media: [{ url: reelUrl, type: 'video' }],
    });
    console.log(`[Reel] ✅ Viral Reel scheduled for ${reelTime.toISOString()} — ${REEL_ACCOUNTS.length} platforms`);
    logReelPost(content.hook, script.caption); // fire-and-forget attribution tracking
    return { success: true, reelUrl, hook: content.hook, scheduledFor: reelTime.toISOString() };
  } catch (err) {
    console.error('[Reel] ❌ Failed to schedule Reel:', err?.response?.data || err.message);
    return { success: false, error: err.message };
  }
}

// Send weekly content summary email to Jose every Monday
async function getGHLContactCountByTag(tag) {
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&tags=${tag}&limit=1`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    return res.data?.total || res.data?.contacts?.length || 0;
  } catch { return 0; }
}

async function getGHLOpportunityCountByStage(stageId) {
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/opportunities/search?location_id=${GHL_LOCATION_ID}&pipeline_id=${MARKETING_PIPELINE_ID}&pipeline_stage_id=${stageId}&limit=1`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    return res.data?.meta?.total || 0;
  } catch { return 0; }
}

async function sendWeeklySummaryEmail(weekPosts) {
  const subject = `📊 JRZ Marketing — Reporte Semanal: Resultados + IA Insights (${new Date().toLocaleDateString('es-ES')})`;
  const logoUrl = 'https://files.manuscdn.com/user_upload_by_module/session_file/310519663415013329/cScWYsLVftXscDEx.png';

  // Pull all stats in parallel
  const [
    socialStats,
    contentStrategy,
    outboundSent,
    outboundPending,
    needsEmail,
    hotLeads,
    qualifiedLeads,
    interested,
    newLeads,
    hotOpp,
    bookingOpp,
  ] = await Promise.all([
    getWeeklyStats().catch(() => null),
    loadContentStrategy().catch(() => null),
    getGHLContactCountByTag('outbound_sent'),
    getGHLContactCountByTag('outbound_pending'),
    getGHLContactCountByTag('needs_email'),
    getGHLContactCountByTag('hot-lead'),
    getGHLContactCountByTag('qualified-lead'),
    getGHLContactCountByTag('armando-interested'),
    getGHLOpportunityCountByStage(PIPELINE_STAGES.newLead),
    getGHLOpportunityCountByStage(PIPELINE_STAGES.hotLead),
    getGHLOpportunityCountByStage(PIPELINE_STAGES.booking),
  ]);

  const breakdown = socialStats?.breakdowns || {};
  const eng       = breakdown?.engagement || {};
  const impressions = breakdown?.impressions?.total || 0;
  const reach       = breakdown?.reach?.total || 0;
  const followers   = breakdown?.followers?.total || 0;
  const igLikes     = eng?.instagram?.likes || 0;
  const igComments  = eng?.instagram?.comments || 0;

  // Ask Claude to write a strategic weekly commentary
  let aiInsight = '';
  try {
    const insightMsg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 400,
      messages: [{
        role: 'user',
        content: `Eres el analista estratégico de JRZ Marketing. Basado en estos datos de la semana, escribe UN párrafo corto (3-4 oraciones) con el insight más importante y UNA recomendación concreta para la próxima semana. Sé directo, como un COO hablando con el CEO.

Datos:
- Impresiones sociales: ${impressions} | Alcance: ${reach} | Nuevos seguidores: ${followers}
- Instagram: ${igLikes} likes, ${igComments} comentarios
- Outbound emails enviados esta semana: ${outboundSent}
- Pipeline — New Lead: ${newLeads} | Hot Lead: ${hotOpp} | Con cita: ${bookingOpp}
- Leads interesados (DM): ${interested} | Calificados: ${qualifiedLeads} | Hot: ${hotLeads}
- Estrategia previa: ${contentStrategy?.weeklyNotes || 'Primera semana'}

Escribe el insight en español. Solo el párrafo, sin títulos.`,
      }],
    });
    aiInsight = insightMsg.content[0].text.trim();
  } catch { aiInsight = 'Análisis no disponible esta semana.'; }

  const postRows = (weekPosts || []).map(p => `
    <tr>
      <td style="padding:10px 16px; border-bottom:1px solid #f0f0f0; font-size:13px; color:#333; font-weight:600;">${p.day}</td>
      <td style="padding:10px 16px; border-bottom:1px solid #f0f0f0; font-size:13px; color:#555;">${p.title || 'AI-generated'}</td>
      <td style="padding:10px 16px; border-bottom:1px solid #f0f0f0; font-size:13px; color:${p.success ? '#16a34a' : '#dc2626'}; font-weight:700;">${p.success ? '✅ Posted' : '❌ Error'}</td>
    </tr>`).join('');

  const statBox = (label, value, sub = '') => `
    <td style="width:25%;padding:20px 16px;text-align:center;border-right:1px solid #f0f0f0;">
      <div style="font-size:28px;font-weight:800;color:#0a0a0a;line-height:1;">${value}</div>
      <div style="font-size:11px;font-weight:700;color:#999;text-transform:uppercase;letter-spacing:0.08em;margin-top:6px;">${label}</div>
      ${sub ? `<div style="font-size:11px;color:#bbb;margin-top:3px;">${sub}</div>` : ''}
    </td>`;

  const html = `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',sans-serif; background:#f4f4f4; color:#0a0a0a; }
    .wrap { padding:40px 20px; }
    .container { max-width:620px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .header { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .header img { height:40px; }
    .hero { background:#0a0a0a; padding:28px 40px 36px; border-bottom:3px solid #fff; }
    .hero h1 { font-size:22px; font-weight:800; color:#fff; line-height:1.3; margin-bottom:8px; }
    .hero p { font-size:13px; color:rgba(255,255,255,0.45); }
    .section { padding:28px 40px; border-bottom:1px solid #f0f0f0; }
    .section-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.1em; color:#999; margin-bottom:16px; }
    .stat-row { width:100%; border-collapse:collapse; background:#f9f9f9; border-radius:12px; overflow:hidden; }
    .insight-box { background:#f0f7ff; border-left:4px solid #0a0a0a; padding:16px 20px; border-radius:0 8px 8px 0; font-size:14px; color:#333; line-height:1.7; }
    .pipeline-row { display:flex; gap:8px; flex-wrap:wrap; margin-top:4px; }
    .pill { display:inline-block; padding:5px 14px; border-radius:100px; font-size:12px; font-weight:700; }
    .pill-new { background:#e0f2fe; color:#0369a1; }
    .pill-hot { background:#fef2f2; color:#dc2626; }
    .pill-booked { background:#f0fdf4; color:#16a34a; }
    table.posts { width:100%; border-collapse:collapse; }
    table.posts th { background:#0a0a0a; color:#fff; font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.05em; padding:10px 14px; text-align:left; }
    table.posts td { padding:9px 14px; border-bottom:1px solid #f0f0f0; font-size:13px; color:#444; }
    .machine-row { display:flex; align-items:center; gap:10px; padding:8px 0; border-bottom:1px solid #f5f5f5; font-size:13px; color:#333; }
    .machine-row:last-child { border-bottom:none; }
    .dot { width:8px; height:8px; border-radius:50%; background:#16a34a; flex-shrink:0; }
    .footer { background:#0a0a0a; padding:24px 40px; text-align:center; }
    .footer img { height:24px; opacity:0.6; margin-bottom:10px; }
    .footer p { font-size:11px; color:rgba(255,255,255,0.2); }
  </style>
</head>
<body><div class="wrap"><div class="container">

  <div class="header"><img src="${logoUrl}" alt="JRZ Marketing"></div>

  <div class="hero">
    <h1>Reporte semanal — JRZ Marketing<br>Semana del ${new Date().toLocaleDateString('es-ES', { weekday:'long', month:'long', day:'numeric' })}</h1>
    <p>Generado automáticamente por Armando AI · Cada lunes 7am EST</p>
  </div>

  <!-- MACHINE STATUS -->
  <div class="section">
    <div class="section-title">⚙️ Máquina — Estado esta semana</div>
    <div class="machine-row"><div class="dot"></div><strong>Contenido social:</strong>&nbsp;7 días × carrusel + story · Lun/Mié/Vie × reel con voz (Joseph Corona) → Instagram, Facebook, LinkedIn, YouTube, TikTok, Google Business</div>
    <div class="machine-row"><div class="dot"></div><strong>Outbound:</strong>&nbsp;${outboundSent} emails personalizados enviados esta semana (Mon–Fri)</div>
    <div class="machine-row"><div class="dot"></div><strong>Apollo enrichment:</strong>&nbsp;${needsEmail} contactos en cola esperando email (enriquecimiento lunes 9am)</div>
    <div class="machine-row"><div class="dot"></div><strong>Armando DM bot:</strong>&nbsp;24/7 activo — responde comentarios, follows, y DMs inbound</div>
    <div class="machine-row"><div class="dot"></div><strong>Pipeline GHL:</strong>&nbsp;Oportunidades creadas automáticamente en cada outreach e interacción</div>
  </div>

  <!-- SOCIAL STATS -->
  <div class="section">
    <div class="section-title">📱 Redes sociales — Esta semana</div>
    <table class="stat-row">
      <tr>
        ${statBox('Impresiones', impressions.toLocaleString())}
        ${statBox('Alcance', reach.toLocaleString())}
        ${statBox('Likes IG', igLikes.toLocaleString())}
        ${statBox('Comentarios IG', igComments.toLocaleString(), 'instagram')}
      </tr>
    </table>
    <p style="font-size:12px;color:#999;margin-top:10px;">Plataformas activas: Instagram · Facebook · LinkedIn (×2) · YouTube · TikTok (×2) · Google Business</p>
  </div>

  <!-- OUTBOUND + PIPELINE -->
  <div class="section">
    <div class="section-title">📧 Outbound + Pipeline</div>
    <table class="stat-row">
      <tr>
        ${statBox('Emails enviados', outboundSent, 'esta semana')}
        ${statBox('En pipeline', newLeads + hotOpp + bookingOpp, 'total activo')}
        ${statBox('Hot leads', hotLeads, 'calificados')}
        ${statBox('Con cita', bookingOpp, 'agendada')}
      </tr>
    </table>
    <div style="margin-top:16px;">
      <div style="font-size:12px;font-weight:700;color:#666;margin-bottom:8px;">Marketing Pipeline — GHL</div>
      <span class="pill pill-new">New Lead: ${newLeads}</span>&nbsp;
      <span class="pill pill-hot">Hot Lead: ${hotOpp}</span>&nbsp;
      <span class="pill pill-booked">Booking: ${bookingOpp}</span>
    </div>
  </div>

  <!-- DM ACTIVITY -->
  <div class="section">
    <div class="section-title">💬 Armando — Actividad de DMs</div>
    <table class="stat-row">
      <tr>
        ${statBox('Interesados', interested, 'respondieron')}
        ${statBox('Calificados', qualifiedLeads, 'dieron info')}
        ${statBox('Hot leads', hotLeads, 'phone + email')}
        ${statBox('En espera', outboundPending, 'outbound pending')}
      </tr>
    </table>
  </div>

  <!-- AI INSIGHT -->
  <div class="section">
    <div class="section-title">🧠 Armando AI — Insight de la semana</div>
    <div class="insight-box">${aiInsight}</div>
    ${contentStrategy?.bestTopics ? `<p style="font-size:12px;color:#999;margin-top:12px;"><strong>Temas que más funcionan:</strong> ${contentStrategy.bestTopics.join(' · ')}</p>` : ''}
    ${contentStrategy?.weeklyNotes ? `<p style="font-size:12px;color:#999;margin-top:4px;"><strong>Nota estratégica:</strong> ${contentStrategy.weeklyNotes}</p>` : ''}
  </div>

  <!-- CONTENT POSTED -->
  <div class="section">
    <div class="section-title">📅 Contenido publicado esta semana</div>
    <table class="posts">
      <thead><tr><th>Día</th><th>Contenido</th><th>Estado</th></tr></thead>
      <tbody>${postRows || '<tr><td colspan="3" style="padding:14px;text-align:center;color:#bbb;">Sin datos</td></tr>'}</tbody>
    </table>
  </div>

  <!-- NEXT WEEK FOCUS -->
  <div class="section" style="border-bottom:none;">
    <div class="section-title">🎯 Foco para la próxima semana</div>
    <p style="font-size:14px;color:#333;line-height:1.8;">
      1. Revisar pipeline en GHL — mover hot leads hacia cita agendada<br>
      2. Apollo enriquece contactos lunes 9am → outbound corre a las 10am<br>
      3. Si hay un cliente con resultado esta semana → capturarlo como caso de éxito para contenido
    </p>
    <p style="font-size:12px;color:#999;margin-top:12px;"><strong>KPI principal:</strong> Consultas agendadas esta semana → <strong>${bookingOpp}</strong></p>
  </div>

  <div class="footer">
    <img src="${logoUrl}" alt="JRZ Marketing">
    <p>&copy; 2026 JRZ Marketing · Reporte generado por Armando AI cada lunes 7am EST</p>
  </div>

</div></div></body></html>`;

  try {
    await sendEmail(OWNER_CONTACT_ID, subject, html);
    console.log('[Social] Weekly summary email sent to Jose.');
  } catch (err) {
    console.error('[Social] Failed to send weekly summary:', err?.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// WEBHOOK — ARMANDO DM HANDLER
// ═══════════════════════════════════════════════════════════
app.post('/webhook', async (req, res) => {
  try {
    const payload = req.body;
    console.log('Incoming webhook:', JSON.stringify(payload, null, 2));

    const messageBody =
      payload.body ||
      payload.message?.body ||
      payload.messageBody ||
      payload.customData?.body ||
      '';

    const contactId =
      payload.contactId ||
      payload.contact_id ||
      payload.contact?.id ||
      payload.customData?.contactId ||
      '';

    const conversationId =
      payload.conversationId ||
      payload.conversation_id ||
      payload.conversation?.id ||
      '';

    const messageType =
      payload.message?.type ||
      payload.messageType ||
      payload.message_type ||
      payload.type ||
      payload.customData?.messageType ||
      payload.customData?.['messageType\t'] ||
      '';

    const contactName =
      payload.fullName ||
      payload.full_name ||
      payload.contactName ||
      payload.firstName ||
      payload.first_name ||
      payload.customData?.fullName ||
      '';

    const messageId =
      payload.messageId ||
      payload.message_id ||
      payload.message?.id ||
      payload.id ||
      '';

    if (!messageBody || !contactId) {
      console.log('Missing messageBody or contactId, skipping.');
      return res.status(200).json({ status: 'skipped', reason: 'missing fields' });
    }

    if (messageId && repliedMessageIds.has(messageId)) {
      console.log(`Dedup: already replied to messageId ${messageId}. Skipping.`);
      return res.status(200).json({ status: 'skipped', reason: 'duplicate messageId' });
    }

    const sendType = getSendType(messageType);

    // ── Pre-flight checks — bail before Claude if Armando shouldn't engage ──
    // Fetch history + contact info once here; pass into getArmandoReply to avoid duplicate GHL calls
    const [priorHistory, priorContact] = await Promise.all([
      conversationId ? getConversationHistory(conversationId) : Promise.resolve([]),
      getGHLContact(contactId),
    ]);

    // 1. If Jose already sent outbound messages → he's handling it, stay silent
    if (priorHistory.some(m => m.direction === 'outbound')) {
      console.log(`[Armando] Existing outbound — silent, Jose handles it.`);
      return res.status(200).json({ status: 'silent', reason: 'jose_handling' });
    }

    // 2. If contact already has phone AND email → fully qualified, no need to chase
    if (priorContact.phone && priorContact.email) {
      console.log(`[Armando] Contact already fully qualified — silent.`);
      return res.status(200).json({ status: 'silent', reason: 'already_qualified' });
    }

    // ── Now call Claude — pre-fetched data passed in to avoid duplicate API calls ──
    const { reply, leadQuality, sentiment, shouldEngage, wantsCall, slotChoice, foundPhone, foundEmail, contactMemory: cMem, competitorInsights: cInsights, compPainPoints: cPain } = await getArmandoReply(
      messageBody, contactName, contactId, conversationId, sendType,
      { history: priorHistory, contact: priorContact }  // pre-fetched — no re-fetch needed
    );
    const msgCount = contactMessageCount.get(contactId) || 1;
    // shouldAutoReply: true unless Claude says the message is personal/non-business
    let shouldAutoReply = shouldEngage !== false;
    if (!shouldAutoReply) console.log(`[Armando] Message flagged as personal/non-business — silent.`);
    console.log(`[Armando] msg #${msgCount} | lead:${leadQuality} sentiment:${sentiment} engage:${shouldAutoReply} phone:${foundPhone || '-'} email:${foundEmail || '-'}`);

    // Reel attribution — on first DM, check if a reel drove this lead
    if (msgCount === 1) {
      checkReelAttribution(contactId).then(reelHook => {
        if (reelHook) {
          tagContact(contactId, ['reel-driven-lead']);
          console.log(`[Attribution] Lead ${contactId} → reel: "${reelHook.slice(0, 60)}"`);
        }
      }).catch(() => {});
    }

    if (foundPhone || foundEmail) {
      await updateGHLContact(contactId, foundPhone, foundEmail);
      await recordABConversion(contactId); // track which closing variant converted
    }

    const hasBothData = !!(foundPhone && foundEmail);
    const hasAnyData  = !!(foundPhone || foundEmail);
    if (hasBothData) {
      await tagContact(contactId, ['armando-interested', 'qualified-lead', 'hot-lead']);
      await createOpportunity(contactId, contactName, PIPELINE_STAGES.hotLead);
    } else if (hasAnyData) {
      await tagContact(contactId, ['armando-interested', 'qualified-lead']);
      await createOpportunity(contactId, contactName, PIPELINE_STAGES.hotLead);
    } else if (leadQuality === 'interested') {
      await tagContact(contactId, ['armando-interested']);
      await createOpportunity(contactId, contactName, PIPELINE_STAGES.newLead);
    }

    if (foundEmail && !thankYouEmailSent.has(contactId)) {
      thankYouEmailSent.add(contactId);
      console.log(`Sending thank-you email to contact ${contactId}...`);
      await sendThankYouEmail(contactId, contactName);
    }

    if (hasAnyData && !alertEmailSent.has(contactId)) {
      alertEmailSent.add(contactId);
      console.log(`Sending hot-lead alert for contact ${contactId}...`);
      await sendHotLeadAlertEmail(contactName, foundPhone, foundEmail, sendType);
    }

    // Lead scoring — alert Jose if score >= 8
    const leadScore = calculateLeadScore({ leadQuality, sentiment, foundPhone, foundEmail, historyCount: msgCount, channel: sendType });
    console.log(`[LeadScore] ${contactName} scored ${leadScore}/10`);
    if (leadScore >= 8 && !leadScoreAlertSent.has(contactId)) {
      leadScoreAlertSent.add(contactId);
      await sendLeadScoreAlert(contactId, contactName, leadScore, sendType, foundPhone, foundEmail);
    }

    // TCPA compliance — only call after explicit consent in DM
    if (hasBothData && foundPhone) blandConsentAsked.add(contactId);
    if (wantsCall && foundPhone && !blandCallsSent.has(contactId)) {
      triggerBlandCall(contactId, contactName, foundPhone, cMem || {}); // fire-and-forget
    }

    // Google Calendar booking — fires when contact picks a slot (1, 2, or 3)
    if (slotChoice > 0) {
      const slots = pendingBookingSlots.get(contactId);
      const chosen = slots?.[slotChoice - 1];
      if (chosen) {
        try {
          await createCalendarEvent(contactName, foundEmail, chosen);
          pendingBookingSlots.delete(contactId);
          await tagContact(contactId, ['calendar-booked', 'armando-booked']);
          await createOpportunity(contactId, contactName, PIPELINE_STAGES.booking);
          logWeeklyWin(contactId, reply, 'calendar_booked');
          // Send confirmation DM
          const confirmMsg = `✅ ¡Listo! Agendé tu llamada con Jose para el ${formatSlot(chosen)}. Recibirás una invitación de Google Calendar en tu email. ¡Nos vemos entonces! 🙌`;
          await sendGHLReply(contactId, confirmMsg, sendType);
          console.log(`[Calendar] ✅ Booked for ${contactName} at ${formatSlot(chosen)}`);
        } catch (err) {
          console.error('[Calendar] Booking failed:', err.message);
        }
      }
    }

    if (shouldAutoReply) {
      await sendGHLReply(contactId, reply, sendType);
      if (messageId) repliedMessageIds.add(messageId);
      console.log('Armando reply sent successfully.');

      // Send voice note after text reply (IG DMs and SMS only)
      if (sendType === 'IG' || sendType === 'FB' || sendType === 'SMS') {
        const voiceUrl = await generateDMVoiceNote(reply, contactId, contactName, messageBody, cMem || {}, cInsights || {}, cPain || {});
        if (voiceUrl) {
          await sendGHLVoiceNote(contactId, voiceUrl, sendType);
        }
      }
    } else {
      console.log('[Armando] Silent mode — tagging/pipeline done, no auto-reply sent.');
    }

    res.status(200).json({ status: 'ok', replied: shouldAutoReply, reply: shouldAutoReply ? reply : null, leadQuality, sentiment, foundPhone, foundEmail, messageNumber: msgCount });
  } catch (error) {
    console.error('Webhook error:', error?.response?.data || error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// MULTI-TENANT WEBHOOK — /webhook/:locationId
// Routes DMs from client sub-accounts to their persona bot.
// Setup: client GHL → Settings → Webhooks → https://armando-bot-1.onrender.com/webhook/{locationId}
// ═══════════════════════════════════════════════════════════

app.post('/webhook/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const persona = getPersona(locationId);

  if (!persona) {
    // No active persona for this locationId — ignore silently
    return res.status(200).json({ status: 'skipped', reason: 'no_active_persona' });
  }

  try {
    const payload = req.body;
    console.log(`[Persona:${persona.name}] Incoming webhook:`, JSON.stringify(payload, null, 2));

    const messageBody =
      payload.body ||
      payload.message?.body ||
      payload.messageBody ||
      payload.customData?.body ||
      '';

    const contactId =
      payload.contactId ||
      payload.contact_id ||
      payload.contact?.id ||
      payload.customData?.contactId ||
      '';

    const conversationId =
      payload.conversationId ||
      payload.conversation_id ||
      payload.conversation?.id ||
      '';

    const messageType =
      payload.message?.type ||
      payload.messageType ||
      payload.message_type ||
      payload.type ||
      payload.customData?.messageType ||
      '';

    const contactName =
      payload.fullName ||
      payload.full_name ||
      payload.contactName ||
      payload.firstName ||
      payload.first_name ||
      payload.customData?.fullName ||
      '';

    const messageId =
      payload.messageId ||
      payload.message_id ||
      payload.message?.id ||
      payload.id ||
      '';

    if (!messageBody || !contactId) {
      return res.status(200).json({ status: 'skipped', reason: 'missing fields' });
    }

    if (messageId && repliedMessageIds.has(messageId)) {
      return res.status(200).json({ status: 'skipped', reason: 'duplicate messageId' });
    }

    const sendType = getSendType(messageType);

    // Pre-fetch history + contact using the client's own API key
    const clientHeaders = { Authorization: `Bearer ${persona.apiKey}`, Version: '2021-07-28' };
    const [priorHistory, priorContact] = await Promise.all([
      conversationId
        ? axios.get(`https://services.leadconnectorhq.com/conversations/${conversationId}/messages`, { headers: clientHeaders })
            .then(r => (r.data.messages || []).map(m => ({ role: m.direction === 'outbound' ? 'assistant' : 'user', content: m.body || '', direction: m.direction })))
            .catch(() => [])
        : Promise.resolve([]),
      axios.get(`https://services.leadconnectorhq.com/contacts/${contactId}`, { headers: clientHeaders })
        .then(r => r.data.contact || r.data || {})
        .catch(() => ({})),
    ]);

    // If a human already replied — stay silent
    if (priorHistory.some(m => m.direction === 'outbound')) {
      return res.status(200).json({ status: 'silent', reason: 'human_handling' });
    }

    // If already fully qualified — stay silent
    if (priorContact.phone && priorContact.email) {
      return res.status(200).json({ status: 'silent', reason: 'already_qualified' });
    }

    // Call Claude with persona's personality as the system prompt
    const { reply, shouldEngage } = await getArmandoReply(
      messageBody, contactName, contactId, conversationId, sendType,
      { history: priorHistory, contact: priorContact, systemPrompt: persona.personality }
    );

    if (shouldEngage === false) {
      return res.status(200).json({ status: 'silent', reason: 'non_business' });
    }

    await sendGHLReply(contactId, reply, sendType, persona.apiKey);
    if (messageId) repliedMessageIds.add(messageId);
    console.log(`[Persona:${persona.name}] ✅ Reply sent to ${contactName || contactId}`);

    res.status(200).json({ status: 'ok', persona: persona.name, replied: true });
  } catch (error) {
    console.error(`[Persona webhook:${locationId}] Error:`, error?.response?.data || error.message);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// ═══════════════════════════════════════════════════════════
// SOCIAL MEDIA CRON ENDPOINTS (manual triggers + internal scheduler)
// ═══════════════════════════════════════════════════════════

/// ── Warm DM webhook — GHL fires this when someone comments or follows ──────
// Setup: GHL → Settings → Webhooks → add https://armando-bot-1.onrender.com/webhook/engage
// Events: ContactCreated, InboundMessage
app.post('/webhook/engage', async (req, res) => {
  res.json({ ok: true }); // respond fast so GHL doesn't retry
  try {
    const e = req.body;
    const contactId = e.contact_id || e.contactId || e.id;
    if (!contactId) return;

    const source  = (e.source || e.channel || '').toLowerCase();
    const type    = (e.type || e.event || '').toLowerCase();
    const isSocial = source.includes('instagram') || source.includes('facebook')
                  || source.includes('tiktok')    || source.includes('linkedin');

    if (type.includes('contactcreated') && isSocial) {
      // New follower / social lead
      await sendWarmDM(contactId, 'follower', { name: e.first_name || e.firstName });
    } else if (type.includes('inboundmessage') && isSocial) {
      // Comment or DM on social post
      await sendWarmDM(contactId, 'comment', { name: e.first_name || e.firstName });
    } else if (type.includes('formsubmit') || type.includes('opportunitycreated')) {
      // Form fill or new opportunity
      await sendWarmDM(contactId, 'form_fill', { name: e.first_name || e.firstName });
    }
  } catch (err) {
    console.error('[WarmDM] Webhook error:', err.message);
  }
});

// Manual trigger: POST /cron/daily-post
app.post('/cron/daily-post', async (_req, res) => {
  try {
    const result = await runDailyPost();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    console.error('/cron/daily-post error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Manual trigger: POST /cron/run-reel  — fire-and-forget (reel takes 60-90s, beyond Render timeout)
app.post('/cron/run-reel', (_req, res) => {
  res.json({ status: 'started', message: 'Reel generating in background — check GET /status in ~2 min' });
  runDailyReel()
    .then(r => logCron('daily-reel', 'ok', r))
    .catch(e => { logCron('daily-reel', 'error', e.message); console.error('/cron/run-reel error:', e.message); });
});

// Debug: GET /test-reel-content — test Claude reel content gen directly
app.get('/test-reel-content', async (_req, res) => {
  try {
    const { script } = getTodaysScript();
    const msg = await anthropic.messages.create({
      model: 'claude-opus-4-6',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Return this exact JSON with no changes: {"hook":"TEST","hook_sub":"sub","content":["a","b","c"],"climax1":"X","climax2":"Y","climax_sub":"Z","framework":"test"}` }]
    });
    const raw = msg.content[0].text.trim();
    res.json({ success: true, topic: script.title, rawResponse: raw, parsed: (() => { try { return JSON.parse(raw.match(/\{[\s\S]*\}/)[0]); } catch(e) { return { parseError: e.message }; } })() });
  } catch (e) {
    res.json({ success: false, error: e.message, type: e.constructor?.name });
  }
});

// Debug: GET /test-voice — test ElevenLabs Joseph Corona live on Render
app.get('/test-voice', async (_req, res) => {
  const audioPath = '/tmp/test_voice_debug.mp3';
  const ok = await generateElevenLabsAudio('Hola, soy Armando de JRZ Marketing.', audioPath);
  try { fs.unlinkSync(audioPath); } catch (_) {}
  res.json({ voice: 'Joseph Corona', keySet: !!ELEVENLABS_API_KEY, success: ok });
});

// Manual trigger: POST /cron/daily-story
app.post('/cron/daily-story', async (_req, res) => {
  try {
    const result = await runDailyStory();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    console.error('/cron/daily-story error:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Manual trigger: POST /cron/weekly-summary
app.post('/cron/weekly-summary', async (req, res) => {
  try {
    await sendWeeklySummaryEmail(req.body.weekPosts || []);
    res.json({ status: 'ok', message: 'Weekly summary email sent.' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

/// ─── JRZ AI Office Dashboard ──────────────────────────────

app.get('/office/status', (_req, res) => {
  res.json({
    ts: new Date().toISOString(),
    kpi: OFFICE_KPI,
    agents: Object.fromEntries(
      Object.entries(AGENT_STATUS).map(([k, v]) => [k, { ...v, subAgents: SUB_AGENTS[k] || [] }])
    ),
    feed: OFFICE_LOG.slice(0, 40),
    chat: OFFICE_CHAT.slice(0, 20),
  });
});

app.get('/office', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const AGENT_META = {
    armando:  { label: 'Armando',  role: 'Community Manager & Closer',    initials: 'AR', color: '#7c3aed' },
    elena:    { label: 'Elena',    role: 'Client Success Manager',         initials: 'EL', color: '#0891b2' },
    diego:    { label: 'Diego',    role: 'Project Manager',                initials: 'DI', color: '#d97706' },
    marco:    { label: 'Marco',    role: 'Content Director',               initials: 'MA', color: '#16a34a' },
    sofia:    { label: 'Sofia',    role: 'Web Designer & SEO Auditor',     initials: 'SO', color: '#8A9BA8' },
    isabella: { label: 'Isabella', role: 'Conversion & Ads Strategist',    initials: 'IS', color: '#db2777' },
  };
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>JRZ Marketing HQ</title>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&display=swap" rel="stylesheet"/>
<style>
*{margin:0;padding:0;box-sizing:border-box;}
body{background:#080a0f;color:#e2e8f0;font-family:'Montserrat',sans-serif;height:100vh;overflow:hidden;}
.office{display:grid;grid-template-columns:1fr 340px;grid-template-rows:auto auto 1fr;height:100vh;gap:0;}
/* HEADER */
.hdr{grid-column:1/-1;background:#0c0f1a;border-bottom:1px solid #1a2540;padding:14px 24px;display:flex;align-items:center;justify-content:space-between;}
.hdr-left{display:flex;align-items:center;gap:16px;}
.hdr-logo{height:32px;object-fit:contain;filter:brightness(0) invert(1);opacity:0.9;}
.hdr-title{font-size:16px;font-weight:900;color:#fff;letter-spacing:0.04em;}
.hdr-sub{font-size:10px;color:#475569;letter-spacing:0.12em;text-transform:uppercase;margin-top:1px;}
.live-dot{width:8px;height:8px;background:#22c55e;border-radius:50%;animation:pulse-green 2s infinite;}
.hdr-time{font-size:12px;color:#475569;font-weight:600;}
/* KPI BAR */
.kpi-bar{grid-column:1/-1;background:#0c0f1a;border-bottom:1px solid #1a2540;padding:10px 24px;display:flex;gap:8px;}
.kpi{flex:1;background:#111827;border:1px solid #1e2d45;border-radius:10px;padding:10px 14px;text-align:center;}
.kpi-val{font-size:22px;font-weight:900;color:#8A9BA8;line-height:1;}
.kpi-lbl{font-size:9px;color:#475569;text-transform:uppercase;letter-spacing:0.1em;margin-top:4px;}
/* MAIN AREA */
.main{overflow-y:auto;padding:20px 24px;background:#080a0f;}
.main::-webkit-scrollbar{width:4px;} .main::-webkit-scrollbar-thumb{background:#1e2d45;border-radius:4px;}
/* AGENT GRID */
.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;}
/* AGENT CARD */
.card{background:#0c0f1a;border:1px solid #1a2540;border-radius:16px;padding:18px;transition:border-color .3s,box-shadow .3s;cursor:default;}
.card.working{border-color:#1a3a6b;box-shadow:0 0 24px rgba(37,99,168,0.2);}
.card.alert{border-color:#7f1d1d;box-shadow:0 0 24px rgba(220,38,38,0.15);}
.card-top{display:flex;align-items:flex-start;gap:12px;margin-bottom:14px;}
.avatar{width:44px;height:44px;border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:15px;font-weight:900;color:#fff;flex-shrink:0;}
.card-info{flex:1;min-width:0;}
.card-name{font-size:14px;font-weight:800;color:#f1f5f9;}
.card-role{font-size:10px;color:#475569;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.status-row{display:flex;align-items:center;gap:6px;margin-bottom:10px;}
.dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
.dot-idle{background:#374151;}
.dot-working{background:#22c55e;animation:pulse-green 1.5s infinite;}
.dot-alert{background:#ef4444;animation:pulse-red .8s infinite;}
@keyframes pulse-green{0%,100%{box-shadow:0 0 0 0 rgba(34,197,94,.4);}50%{box-shadow:0 0 0 5px rgba(34,197,94,0);}}
@keyframes pulse-red{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,.4);}50%{box-shadow:0 0 0 5px rgba(239,68,68,0);}}
.status-text{font-size:11px;color:#94a3b8;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.task-text{font-size:11px;color:#64748b;line-height:1.4;min-height:28px;margin-bottom:12px;}
.chips{display:flex;flex-wrap:wrap;gap:5px;}
.chip{font-size:9px;background:#111827;border:1px solid #1e2d45;color:#64748b;border-radius:100px;padding:3px 8px;white-space:nowrap;}
.chip-icon{margin-right:3px;}
/* SIDEBAR */
.sidebar{background:#0c0f1a;border-left:1px solid #1a2540;display:flex;flex-direction:column;overflow:hidden;}
.sidebar-top{flex:1;overflow:hidden;display:flex;flex-direction:column;border-bottom:1px solid #1a2540;}
.sidebar-bot{height:220px;display:flex;flex-direction:column;}
.s-hdr{padding:12px 16px;border-bottom:1px solid #111827;font-size:10px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:0.1em;display:flex;align-items:center;gap:8px;}
.s-hdr .ct{background:#1e2d45;color:#8A9BA8;font-size:9px;padding:2px 7px;border-radius:100px;font-weight:700;}
.feed-list{flex:1;overflow-y:auto;padding:8px 0;}
.feed-list::-webkit-scrollbar{width:3px;} .feed-list::-webkit-scrollbar-thumb{background:#1e2d45;}
.feed-item{padding:8px 14px;border-left:3px solid #1e2d45;margin:2px 0;animation:fadeIn .4s ease;}
@keyframes fadeIn{from{opacity:0;transform:translateY(-6px);}to{opacity:1;transform:translateY(0);}}
.fi-top{display:flex;align-items:center;gap:6px;margin-bottom:3px;}
.fi-agent{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:0.08em;}
.fi-time{font-size:9px;color:#374151;margin-left:auto;}
.fi-msg{font-size:11px;color:#94a3b8;line-height:1.4;}
.chat-list{flex:1;overflow-y:auto;padding:6px 0;}
.chat-list::-webkit-scrollbar{width:3px;} .chat-list::-webkit-scrollbar-thumb{background:#1e2d45;}
.chat-item{padding:7px 14px;margin:1px 0;}
.ci-top{display:flex;align-items:center;gap:4px;margin-bottom:2px;}
.ci-from{font-size:9px;font-weight:800;text-transform:uppercase;}
.ci-arrow{font-size:9px;color:#374151;}
.ci-to{font-size:9px;font-weight:700;color:#475569;text-transform:uppercase;}
.ci-time{font-size:9px;color:#374151;margin-left:auto;}
.ci-msg{font-size:10px;color:#64748b;line-height:1.4;}
/* TYPE COLORS */
.t-success{background:rgba(22,163,74,.06);}
.t-alert{background:rgba(239,68,68,.06);}
.t-collab{background:rgba(26,58,107,.12);}
.t-info{background:transparent;}
.t-action{background:transparent;}
</style>
</head>
<body>
<div class="office">

<!-- HEADER -->
<div class="hdr">
  <div class="hdr-left">
    <img class="hdr-logo" src="https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png" alt="JRZ"/>
    <div>
      <div class="hdr-title">JRZ Marketing HQ</div>
      <div class="hdr-sub">AI Team Operations Center</div>
    </div>
    <div class="live-dot"></div>
  </div>
  <div class="hdr-time" id="clock"></div>
</div>

<!-- KPI BAR -->
<div class="kpi-bar">
  <div class="kpi"><div class="kpi-val" id="k-dms">0</div><div class="kpi-lbl">DMs Handled</div></div>
  <div class="kpi"><div class="kpi-val" id="k-leads">0</div><div class="kpi-lbl">Leads Captured</div></div>
  <div class="kpi"><div class="kpi-val" id="k-posts">0</div><div class="kpi-lbl">Posts Published</div></div>
  <div class="kpi"><div class="kpi-val" id="k-sites">0</div><div class="kpi-lbl">Sites Monitored</div></div>
  <div class="kpi"><div class="kpi-val" id="k-deals">0</div><div class="kpi-lbl">Deals Tracked</div></div>
  <div class="kpi"><div class="kpi-val" id="k-emails">0</div><div class="kpi-lbl">Emails Sent</div></div>
</div>

<!-- MAIN: AGENT GRID -->
<div class="main">
  <div class="grid" id="agent-grid">
    ${Object.entries(AGENT_META).map(([id, m]) => `
    <div class="card" id="card-${id}" data-agent="${id}">
      <div class="card-top">
        <div class="avatar" style="background:linear-gradient(135deg,${m.color}cc,${m.color})">${m.initials}</div>
        <div class="card-info">
          <div class="card-name">${m.label}</div>
          <div class="card-role">${m.role}</div>
        </div>
      </div>
      <div class="status-row">
        <div class="dot dot-idle" id="dot-${id}"></div>
        <div class="status-text" id="status-${id}">Idle</div>
      </div>
      <div class="task-text" id="task-${id}">Standing by...</div>
      <div class="chips" id="chips-${id}">
        ${(SUB_AGENTS[id] || []).map(sa => `<div class="chip"><span class="chip-icon">${sa.icon}</span>${sa.name}</div>`).join('')}
      </div>
    </div>`).join('')}
  </div>
</div>

<!-- SIDEBAR -->
<div class="sidebar">
  <div class="sidebar-top">
    <div class="s-hdr">Live Activity <span class="ct" id="feed-count">0</span></div>
    <div class="feed-list" id="feed-list"></div>
  </div>
  <div class="sidebar-bot">
    <div class="s-hdr">Agent Chat <span class="ct" id="chat-count">0</span></div>
    <div class="chat-list" id="chat-list"></div>
  </div>
</div>

</div><!-- /office -->

<script>
const AGENT_COLORS = ${JSON.stringify(Object.fromEntries(Object.entries(AGENT_META).map(([k,v]) => [k, v.color])))};
const TYPE_ICON = { success:'✅', alert:'🚨', collab:'💬', info:'ℹ️', action:'⚡' };

function timeAgo(ts) {
  const s = Math.floor((Date.now() - new Date(ts)) / 1000);
  if (s < 60) return s + 's ago';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm ago';
  return Math.floor(m/60) + 'h ago';
}

function updateClock() {
  document.getElementById('clock').textContent = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true, weekday: 'short', month: 'short', day: 'numeric' }) + ' EST';
}

function updateKPIs(kpi) {
  document.getElementById('k-dms').textContent    = kpi.dmsHandled;
  document.getElementById('k-leads').textContent  = kpi.leadsCapture;
  document.getElementById('k-posts').textContent  = kpi.postsPublished;
  document.getElementById('k-sites').textContent  = kpi.sitesMonitored;
  document.getElementById('k-deals').textContent  = kpi.dealsTracked;
  document.getElementById('k-emails').textContent = kpi.emailsSent;
}

function updateAgents(agents) {
  Object.entries(agents).forEach(([id, a]) => {
    const card   = document.getElementById('card-' + id);
    const dot    = document.getElementById('dot-' + id);
    const status = document.getElementById('status-' + id);
    const task   = document.getElementById('task-' + id);
    if (!card) return;
    card.className = 'card ' + (a.status || 'idle');
    dot.className  = 'dot dot-' + (a.status || 'idle');
    status.textContent = a.status === 'working' ? '● Working' : a.status === 'alert' ? '⚠ Alert' : '○ Idle';
    status.style.color = a.status === 'working' ? '#22c55e' : a.status === 'alert' ? '#ef4444' : '#475569';
    task.textContent = a.task || 'Standing by...';
  });
}

let lastFeedId = null, lastChatTs = null;

function renderFeed(feed) {
  const list = document.getElementById('feed-list');
  document.getElementById('feed-count').textContent = feed.length;
  const html = feed.map(f => {
    const color = AGENT_COLORS[f.agent] || '#475569';
    return \`<div class="feed-item t-\${f.type}" style="border-left-color:\${color}">
      <div class="fi-top">
        <span class="fi-agent" style="color:\${color}">\${f.agent}</span>
        <span style="font-size:9px;color:#374151">\${TYPE_ICON[f.type]||'•'}</span>
        <span class="fi-time">\${timeAgo(f.ts)}</span>
      </div>
      <div class="fi-msg">\${f.message}</div>
    </div>\`;
  }).join('');
  if (feed[0]?.id !== lastFeedId) { list.innerHTML = html; lastFeedId = feed[0]?.id; }
}

function renderChat(chat) {
  const list = document.getElementById('chat-list');
  document.getElementById('chat-count').textContent = chat.length;
  const html = chat.map(c => {
    const fc = AGENT_COLORS[c.from] || '#475569';
    const tc = AGENT_COLORS[c.to]   || '#475569';
    return \`<div class="chat-item">
      <div class="ci-top">
        <span class="ci-from" style="color:\${fc}">\${c.from}</span>
        <span class="ci-arrow">→</span>
        <span class="ci-to" style="color:\${tc}">\${c.to}</span>
        <span class="ci-time">\${timeAgo(c.ts)}</span>
      </div>
      <div class="ci-msg">\${c.message}</div>
    </div>\`;
  }).join('');
  if (chat[0]?.ts !== lastChatTs) { list.innerHTML = html; lastChatTs = chat[0]?.ts; }
}

async function refresh() {
  try {
    const r = await fetch('/office/status');
    const d = await r.json();
    updateKPIs(d.kpi);
    updateAgents(d.agents);
    renderFeed(d.feed);
    renderChat(d.chat);
  } catch(e) { console.warn('Office poll failed', e); }
}

setInterval(updateClock, 1000);
setInterval(refresh, 5000);
updateClock();
refresh();
</script>
</body></html>`);
});

// Status check: GET /social/status
app.get('/social/status', (_req, res) => {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const { script, index } = getTodaysScript();
  res.json({
    status: 'Social Media Automation — ACTIVE',
    currentTime_EST: now,
    todaysScript: { index: index + 1, title: script.title },
    totalPrewrittenScripts: CAROUSEL_SCRIPTS.length,
    dailyPostTime: '8:00 AM EST',
    dailyStoryTime: '7:00 PM EST',
    platforms: Object.keys(SOCIAL_ACCOUNTS),
    storyPlatforms: ['instagram', 'facebook'],
  });
});

app.get('/', (_req, res) => {
  res.json({
    status: 'Armando is online 🤖',
    name: 'Armando Rivas',
    age: 22,
    from: 'Caracas, Venezuela 🇻🇪',
    agency: 'JRZ Marketing',
    mission: 'DM lead capture + autonomous social media posting 7 days/week',
    socialMedia: 'Instagram · Facebook · LinkedIn · YouTube · Google Business',
    postsPerDay: '1 carousel (8am EST) + 1 story (7pm EST)',
    office: 'https://armando-bot-1.onrender.com/office',
    health: 'https://armando-bot-1.onrender.com/health',
    status: 'https://armando-bot-1.onrender.com/status',
  });
});

// GET /site/jrz — JRZ Marketing website
app.get('/site/jrz', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'jrz-site.html'));
});

// GET /office — 2D anime AI team office
app.get('/office', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JRZ Marketing — AI Headquarters</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;overflow-x:hidden;min-height:100vh}

.header{background:linear-gradient(135deg,#16213e,#0f3460);padding:14px 30px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #e94560}
.header h1{color:#fff;font-size:1.3rem;letter-spacing:1px}
.header .sub{color:#4ecca3;font-size:0.8rem;margin-top:3px}
.clock{color:#fff;font-size:1.1rem;font-weight:bold;background:rgba(233,69,96,0.2);padding:6px 14px;border-radius:20px;border:1px solid #e94560}

.stats-bar{background:#16213e;padding:10px 30px;display:flex;gap:25px;flex-wrap:wrap;border-bottom:1px solid #0f3460}
.stat{color:#aaa;font-size:0.8rem}.stat strong{color:#4ecca3}

/* OFFICE ROOM */
.office-room{
  background:linear-gradient(180deg,#c8d8e8 0%,#dce8f0 35%,#e8e8ee 35%,#e0ddd8 60%,#c8b99a 60%,#b5a585 100%);
  min-height:480px;position:relative;padding:20px 10px 90px;
  display:flex;align-items:flex-end;gap:10px;justify-content:center;overflow:hidden
}

/* ceiling */
.ceil-light{position:absolute;top:0;width:18px;height:7px;background:#fffbe6;border-radius:0 0 4px 4px;box-shadow:0 0 40px 20px rgba(255,252,200,0.25)}

/* window */
.window{position:absolute;top:18px;left:35px;width:110px;height:130px;background:linear-gradient(160deg,#b8e4f9,#e0f7fa);border:7px solid #7a5c14;border-radius:4px}
.window::before{content:'';position:absolute;left:50%;top:0;bottom:0;width:3px;background:#7a5c14;transform:translateX(-50%)}
.window::after{content:'';position:absolute;top:50%;left:0;right:0;height:3px;background:#7a5c14}

/* office sign */
.office-sign{position:absolute;top:14px;left:50%;transform:translateX(-50%);background:#e94560;color:#fff;padding:6px 18px;border-radius:4px;font-weight:900;font-size:1rem;letter-spacing:3px;white-space:nowrap;box-shadow:0 2px 10px rgba(233,69,96,0.5)}

/* plant */
.plant{position:absolute;bottom:85px;right:25px}
.plant-pot{width:28px;height:18px;background:#c0632b;clip-path:polygon(10% 0%,90% 0%,100% 100%,0% 100%);margin:0 auto}
.plant-leaf{position:absolute;width:18px;height:28px;background:#2d8a3e;border-radius:0 50% 0 50%}

/* DESK STATION */
.station{display:flex;flex-direction:column;align-items:center;position:relative;width:130px;flex-shrink:0}
.station-label{font-size:0.65rem;font-weight:900;color:#fff;background:rgba(0,0,0,0.65);padding:2px 9px;border-radius:10px;margin-bottom:4px;text-transform:uppercase;letter-spacing:1px}
.role-tag{font-size:0.55rem;color:#4ecca3;text-align:center;margin-bottom:4px}

.monitor{width:96px;height:68px;background:#111;border:3px solid #444;border-radius:5px;position:relative;overflow:hidden;flex-shrink:0}
.monitor::after{content:'';position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);width:28px;height:14px;background:#555;clip-path:polygon(20% 0%,80% 0%,100% 100%,0% 100%)}
.monitor-screen{width:100%;height:100%;padding:4px 5px;font-size:0.48rem;color:#4ecca3;font-family:monospace;overflow:hidden;line-height:1.4}
.scroll-text{animation:scrollUp 10s linear infinite}
@keyframes scrollUp{0%{transform:translateY(0)}100%{transform:translateY(-50%)}}

.keyboard{width:76px;height:18px;background:linear-gradient(180deg,#ddd,#bbb);border-radius:3px;border:1px solid #999;margin-top:16px;position:relative}
.keyboard::after{content:'';position:absolute;top:3px;left:5px;right:5px;height:2px;background:repeating-linear-gradient(90deg,#aaa 0,#aaa 5px,transparent 5px,transparent 8px)}

.desk{width:125px;height:22px;background:linear-gradient(180deg,#d4a574,#b8864e);border-radius:4px 4px 0 0;border:2px solid #8B6914;margin-top:4px}
.desk-legs{width:105px;height:36px;display:flex;justify-content:space-between;padding:0 10px}
.desk-leg{width:9px;height:36px;background:#8B6914;border-radius:0 0 3px 3px}

/* CHARACTER — chibi anime */
.char-wrap{position:absolute;bottom:60px;left:50%;transform:translateX(-50%)}
.chibi{width:58px;height:88px;position:relative}
.chibi.anim-idle{animation:idle 2.5s ease-in-out infinite}
.chibi.anim-type{animation:typeAnim 0.6s ease-in-out infinite}
.chibi.anim-active{animation:activeAnim 1.8s ease-in-out infinite}
.chibi.anim-sleep{animation:idle 4s ease-in-out infinite;opacity:0.65}

@keyframes idle{0%,100%{transform:translateY(0)}50%{transform:translateY(-4px)}}
@keyframes typeAnim{0%,100%{transform:translateY(0) rotate(-1deg)}50%{transform:translateY(-3px) rotate(1deg)}}
@keyframes activeAnim{0%,100%{transform:translateY(0) scale(1)}50%{transform:translateY(-7px) scale(1.03)}}

/* head */
.c-head{width:42px;height:42px;border-radius:50%;position:absolute;top:0;left:8px;z-index:3}
/* hair top */
.c-hair{position:absolute;top:-4px;left:4px;width:50px;height:24px;border-radius:50% 50% 0 0;z-index:4}
/* hair sides */
.c-hair-l{position:absolute;top:12px;left:3px;width:8px;height:20px;border-radius:0 0 50% 50%;z-index:2}
.c-hair-r{position:absolute;top:12px;right:3px;width:8px;height:20px;border-radius:0 0 50% 50%;z-index:2}
/* eyes */
.c-eyes{position:absolute;top:16px;left:9px;width:24px;display:flex;gap:5px;z-index:5}
.c-eye{width:7px;height:9px;border-radius:50%;position:relative}
.c-eye::after{content:'';position:absolute;top:1px;right:1px;width:2px;height:2px;border-radius:50%;background:#fff}
/* blush */
.c-blush-l{position:absolute;top:24px;left:5px;width:8px;height:4px;border-radius:50%;background:rgba(255,140,140,0.5);z-index:5}
.c-blush-r{position:absolute;top:24px;right:5px;width:8px;height:4px;border-radius:50%;background:rgba(255,140,140,0.5);z-index:5}
/* glasses (Sofia) */
.c-glasses{position:absolute;top:15px;left:7px;width:28px;height:9px;border:2px solid #555;border-radius:3px;z-index:6}
/* body */
.c-body{width:38px;height:30px;border-radius:9px 9px 4px 4px;position:absolute;top:38px;left:10px;z-index:2}
/* arms */
.c-arm-l{position:absolute;width:11px;height:22px;border-radius:6px;top:42px;left:1px;z-index:1;transform:rotate(20deg)}
.c-arm-r{position:absolute;width:11px;height:22px;border-radius:6px;top:42px;right:1px;z-index:1;transform:rotate(-20deg)}
.chibi.anim-type .c-arm-l{animation:al 0.6s ease-in-out infinite}
.chibi.anim-type .c-arm-r{animation:ar 0.6s ease-in-out infinite}
@keyframes al{0%,100%{transform:rotate(20deg)}50%{transform:rotate(32deg) translateY(3px)}}
@keyframes ar{0%,100%{transform:rotate(-20deg)}50%{transform:rotate(-32deg) translateY(3px)}}

/* thought bubble */
.bubble{position:absolute;top:-46px;left:50%;transform:translateX(-50%);background:#fff;border:2px solid #e94560;border-radius:10px;padding:3px 8px;font-size:0.52rem;white-space:nowrap;z-index:10;box-shadow:0 2px 8px rgba(0,0,0,0.2);max-width:120px;text-align:center}
.bubble::after{content:'';position:absolute;bottom:-8px;left:50%;transform:translateX(-50%);border:4px solid transparent;border-top-color:#e94560}

/* TICKER */
.ticker-wrap{background:#0f3460;padding:9px 0;overflow:hidden;border-top:2px solid #e94560;display:flex;align-items:center}
.ticker-label{color:#e94560;font-weight:900;font-size:0.75rem;padding:0 15px;white-space:nowrap;flex-shrink:0}
.ticker-track{overflow:hidden;flex:1}
.ticker{display:flex;animation:tick 35s linear infinite;white-space:nowrap}
.ticker-item{color:#4ecca3;font-size:0.78rem;padding:0 28px}
@keyframes tick{0%{transform:translateX(0)}100%{transform:translateX(-50%)}}
</style>
</head>
<body>

<div class="header">
  <div>
    <h1>🏢 JRZ Marketing — AI Headquarters</h1>
    <div class="sub">● 5 AI agents online · 31 clients · fully autonomous</div>
  </div>
  <div class="clock" id="clock">--:-- EST</div>
</div>

<div class="stats-bar">
  <div class="stat">🤖 Agents: <strong>5 online</strong></div>
  <div class="stat">🏢 Clients: <strong>31 active</strong></div>
  <div class="stat">📱 Daily posts: <strong>1 carousel + 1 story</strong></div>
  <div class="stat">✍️ SEO blogs: <strong>daily per client</strong></div>
  <div class="stat">🏙️ City pages: <strong>348 Railing Max · 128 Cooney</strong></div>
  <div class="stat">📊 Reports: <strong>weekly + monthly</strong></div>
</div>

<div class="office-room" id="office">
  <!-- Lights -->
  <div class="ceil-light" style="left:18%"></div>
  <div class="ceil-light" style="left:38%"></div>
  <div class="ceil-light" style="left:58%"></div>
  <div class="ceil-light" style="left:78%"></div>

  <!-- Window -->
  <div class="window"></div>

  <!-- Sign -->
  <div class="office-sign">JRZ MARKETING</div>

  <!-- Plant -->
  <div class="plant">
    <div class="plant-leaf" style="left:4px;bottom:18px;transform:rotate(-30deg)"></div>
    <div class="plant-leaf" style="right:4px;bottom:18px;transform:rotate(30deg) scaleX(-1)"></div>
    <div class="plant-leaf" style="left:7px;bottom:32px;transform:rotate(-10deg)"></div>
    <div class="plant-pot"></div>
  </div>

  <!-- ─── ARMANDO ─── -->
  <div class="station">
    <div class="station-label">Armando</div>
    <div class="role-tag">Community Manager</div>
    <div class="monitor">
      <div class="monitor-screen"><div class="scroll-text">
        📨 New DM @user123<br>💬 Generating reply...<br>✅ Reply sent<br>🔔 Comment detected<br>📊 Lead captured!<br>🏷️ Tag: hot_lead<br>📨 New DM @user456<br>💬 Generating reply...<br>✅ Reply sent<br>🔔 Comment detected<br>📊 Lead captured!<br>🏷️ Tag: hot_lead<br>
      </div></div>
    </div>
    <div class="keyboard"></div>
    <div class="desk"></div>
    <div class="desk-legs"><div class="desk-leg"></div><div class="desk-leg"></div></div>
    <div class="char-wrap">
      <div class="chibi anim-type" id="chibi-armando">
        <div class="bubble" id="bub-armando">24/7 DM guard 🛡️</div>
        <div class="c-hair" style="background:#1a1010"></div>
        <div class="c-hair-l" style="background:#1a1010"></div>
        <div class="c-hair-r" style="background:#1a1010"></div>
        <div class="c-head" style="background:#C68642"></div>
        <div class="c-eyes"><div class="c-eye" style="background:#3d2314"></div><div class="c-eye" style="background:#3d2314"></div></div>
        <div class="c-blush-l"></div><div class="c-blush-r"></div>
        <div class="c-body" style="background:#3a7bd5"></div>
        <div class="c-arm-l" style="background:#C68642"></div>
        <div class="c-arm-r" style="background:#C68642"></div>
      </div>
    </div>
  </div>

  <!-- ─── ELENA ─── -->
  <div class="station">
    <div class="station-label">Elena</div>
    <div class="role-tag">Client Success</div>
    <div class="monitor">
      <div class="monitor-screen"><div class="scroll-text">
        📋 Escobar Kitchen<br>✅ Health: Excellent<br>📈 Growth: +12%<br>📋 Railing Max<br>✅ 348 city pages<br>📋 Cooney Homes<br>✅ Health: Good<br>📋 USA CPA<br>✅ Health: Excellent<br>📈 Growth: +12%<br>📋 Railing Max<br>✅ 348 city pages<br>
      </div></div>
    </div>
    <div class="keyboard"></div>
    <div class="desk"></div>
    <div class="desk-legs"><div class="desk-leg"></div><div class="desk-leg"></div></div>
    <div class="char-wrap">
      <div class="chibi anim-idle" id="chibi-elena">
        <div class="bubble" id="bub-elena">Client reports 📋</div>
        <div class="c-hair" style="background:#2c1810;border-radius:50% 50% 0 0;height:28px"></div>
        <div class="c-hair-l" style="background:#2c1810;height:30px"></div>
        <div class="c-hair-r" style="background:#2c1810;height:30px"></div>
        <div class="c-head" style="background:#FDBCB4"></div>
        <div class="c-eyes"><div class="c-eye" style="background:#2c2c2c"></div><div class="c-eye" style="background:#2c2c2c"></div></div>
        <div class="c-blush-l"></div><div class="c-blush-r"></div>
        <div class="c-body" style="background:#e91e8c"></div>
        <div class="c-arm-l" style="background:#FDBCB4"></div>
        <div class="c-arm-r" style="background:#FDBCB4"></div>
      </div>
    </div>
  </div>

  <!-- ─── DIEGO ─── -->
  <div class="station">
    <div class="station-label">Diego</div>
    <div class="role-tag">Project Manager</div>
    <div class="monitor">
      <div class="monitor-screen"><div class="scroll-text">
        📊 Scorecard: A<br>🗓️ Sprint: Week 12<br>✅ Tasks: 24/28<br>📌 KPIs: 94%<br>🗣️ Standup done<br>📊 Q1 on track<br>📊 Scorecard: A<br>🗓️ Sprint: Week 12<br>✅ Tasks: 24/28<br>📌 KPIs: 94%<br>🗣️ Standup done<br>📊 Q1 on track<br>
      </div></div>
    </div>
    <div class="keyboard"></div>
    <div class="desk"></div>
    <div class="desk-legs"><div class="desk-leg"></div><div class="desk-leg"></div></div>
    <div class="char-wrap">
      <div class="chibi anim-idle" id="chibi-diego">
        <div class="bubble" id="bub-diego">Weekly report 📊</div>
        <div class="c-hair" style="background:#6B3A2A;height:20px;border-radius:50% 50% 0 0"></div>
        <div class="c-hair-l" style="background:#6B3A2A;height:14px"></div>
        <div class="c-hair-r" style="background:#6B3A2A;height:14px"></div>
        <div class="c-head" style="background:#D4A270"></div>
        <div class="c-eyes"><div class="c-eye" style="background:#4a2c17"></div><div class="c-eye" style="background:#4a2c17"></div></div>
        <div class="c-blush-l"></div><div class="c-blush-r"></div>
        <div class="c-body" style="background:#e67e22"></div>
        <div class="c-arm-l" style="background:#D4A270"></div>
        <div class="c-arm-r" style="background:#D4A270"></div>
      </div>
    </div>
  </div>

  <!-- ─── MARCO ─── -->
  <div class="station">
    <div class="station-label">Marco</div>
    <div class="role-tag">Content Director</div>
    <div class="monitor">
      <div class="monitor-screen"><div class="scroll-text">
        ✍️ Blog: Railing Max<br>🎨 Content brief<br>📱 Reel script done<br>🔥 Trend: #local SEO<br>📝 Caption crafted<br>🎯 A/B test ready<br>✍️ Blog: Escobar<br>🎨 Content brief<br>📱 Reel script done<br>🔥 Trend: #local SEO<br>📝 Caption crafted<br>🎯 A/B test ready<br>
      </div></div>
    </div>
    <div class="keyboard"></div>
    <div class="desk"></div>
    <div class="desk-legs"><div class="desk-leg"></div><div class="desk-leg"></div></div>
    <div class="char-wrap">
      <div class="chibi anim-type" id="chibi-marco">
        <div class="bubble" id="bub-marco">Writing content ✍️</div>
        <div class="c-hair" style="background:#1a3a2a;height:22px;border-radius:60% 40% 0 0"></div>
        <div class="c-hair-l" style="background:#1a3a2a;height:16px"></div>
        <div class="c-hair-r" style="background:#1a3a2a;height:16px"></div>
        <div class="c-head" style="background:#C8956C"></div>
        <div class="c-eyes"><div class="c-eye" style="background:#2c2c2c"></div><div class="c-eye" style="background:#2c2c2c"></div></div>
        <div class="c-blush-l"></div><div class="c-blush-r"></div>
        <div class="c-body" style="background:#27ae60"></div>
        <div class="c-arm-l" style="background:#C8956C"></div>
        <div class="c-arm-r" style="background:#C8956C"></div>
      </div>
    </div>
  </div>

  <!-- ─── SOFIA ─── -->
  <div class="station">
    <div class="station-label">Sofia</div>
    <div class="role-tag">Web Designer / SEO</div>
    <div class="monitor">
      <div class="monitor-screen"><div class="scroll-text">
        🌐 Auditing sites...<br>📈 PageSpeed: 94<br>🔍 SEO: all good<br>🏙️ City page ✅<br>⚡ Uptime: 100%<br>🔗 Backlinks OK<br>🌐 Auditing sites...<br>📈 PageSpeed: 94<br>🔍 SEO: all good<br>🏙️ City page ✅<br>⚡ Uptime: 100%<br>🔗 Backlinks OK<br>
      </div></div>
    </div>
    <div class="keyboard"></div>
    <div class="desk"></div>
    <div class="desk-legs"><div class="desk-leg"></div><div class="desk-leg"></div></div>
    <div class="char-wrap">
      <div class="chibi anim-type" id="chibi-sofia">
        <div class="bubble" id="bub-sofia">Website audit 🌐</div>
        <div class="c-hair" style="background:#1a6a7a;height:20px;border-radius:50% 50% 0 0"></div>
        <div class="c-hair-l" style="background:#1a6a7a;width:10px;height:14px"></div>
        <div class="c-hair-r" style="background:#1a6a7a;width:10px;height:14px"></div>
        <div class="c-head" style="background:#FDBCB4"></div>
        <div class="c-glasses"></div>
        <div class="c-eyes"><div class="c-eye" style="background:#2c2c2c"></div><div class="c-eye" style="background:#2c2c2c"></div></div>
        <div class="c-blush-l"></div><div class="c-blush-r"></div>
        <div class="c-body" style="background:#00bcd4"></div>
        <div class="c-arm-l" style="background:#FDBCB4"></div>
        <div class="c-arm-r" style="background:#FDBCB4"></div>
      </div>
    </div>
  </div>

</div><!-- /office-room -->

<!-- CLIENT TICKER -->
<div class="ticker-wrap">
  <span class="ticker-label">📡 ACTIVE CLIENTS:</span>
  <div class="ticker-track">
    <div class="ticker">
      <span class="ticker-item">⭐ JRZ Marketing</span>
      <span class="ticker-item">🍽️ The Escobar Kitchen</span>
      <span class="ticker-item">🏗️ Railing Max</span>
      <span class="ticker-item">🏠 Cooney Homes</span>
      <span class="ticker-item">💰 USA Latino CPA</span>
      <span class="ticker-item">💈 Le Varon Barbershop</span>
      <span class="ticker-item">🥑 Guaca-Mole</span>
      <span class="ticker-item">🏢 Rental Spaces</span>
      <span class="ticker-item">📐 Railing Max — 348 city pages</span>
      <span class="ticker-item">🏘️ Cooney Homes — 128 city pages</span>
      <span class="ticker-item">⭐ JRZ Marketing</span>
      <span class="ticker-item">🍽️ The Escobar Kitchen</span>
      <span class="ticker-item">🏗️ Railing Max</span>
      <span class="ticker-item">🏠 Cooney Homes</span>
      <span class="ticker-item">💰 USA Latino CPA</span>
      <span class="ticker-item">💈 Le Varon Barbershop</span>
      <span class="ticker-item">🥑 Guaca-Mole</span>
      <span class="ticker-item">🏢 Rental Spaces</span>
      <span class="ticker-item">📐 Railing Max — 348 city pages</span>
      <span class="ticker-item">🏘️ Cooney Homes — 128 city pages</span>
    </div>
  </div>
</div>

<script>
// Clock
function tick(){
  const d=new Date();
  document.getElementById('clock').textContent=d.toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',second:'2-digit',timeZone:'America/New_York'})+' EST';
}
setInterval(tick,1000);tick();

// Determine active agents based on EST hour
const nowEST=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'}));
const h=nowEST.getHours();
const dow=nowEST.getDay(); // 0=Sun,1=Mon
const dom=nowEST.getDate();

const schedule={
  armando:{anim:'anim-type',bubble:'24/7 DM guard 🛡️'},
  elena:{
    anim: (h>=8&&h<=17)?'anim-type':'anim-idle',
    bubble: h===9&&dom===1?'Monthly reports 📋':h>=8&&h<=10?'Health check 💊':'Client success 🤝'
  },
  diego:{
    anim:(h>=8&&h<=10)&&dow===1?'anim-active':(h>=8&&h<=17?'anim-type':'anim-sleep'),
    bubble:h===8&&dow===1?'Standup time! 🗣️':h===9&&dow===1?'Weekly report 📊':'Project tracking 📌'
  },
  marco:{
    anim:(h>=9&&h<=11)?'anim-type':(h===10&&dow===3?'anim-active':'anim-idle'),
    bubble:h===9&&dow===1?'Content brief 📝':h===10&&dow===3?'Trend alert 🔥':'Content creating ✍️'
  },
  sofia:{
    anim:(h===7||h===9||h===10||h===16)?'anim-active':'anim-type',
    bubble:h===7?'Daily post time! 📱':h===9?'Website audit 🌐':h===16?'Reel time 🎬':'SEO monitoring 🔍'
  }
};

Object.entries(schedule).forEach(([name,data])=>{
  const c=document.getElementById('chibi-'+name);
  const b=document.getElementById('bub-'+name);
  if(c){c.className='chibi '+data.anim;}
  if(b){b.textContent=data.bubble;}
});

// Random event bubbles
const events=[
  ['armando','New lead! 🎯'],['armando','DM replied ✅'],['armando','Comment liked 👍'],
  ['elena','Client happy 😊'],['elena','Report sent 📋'],['elena','A+ grade! 🏆'],
  ['diego','Sprint done! 🏁'],['diego','Goal met ✅'],['diego','KPI: 97% 📊'],
  ['marco','Blog live! 🎉'],['marco','Reel posted 🎬'],['marco','Trend caught 🔥'],
  ['sofia','Audit done ✅'],['sofia','City page live 🏙️'],['sofia','PageSpeed 95 ⚡']
];
function randomEvent(){
  const [name,text]=events[Math.floor(Math.random()*events.length)];
  const b=document.getElementById('bub-'+name);
  const orig=schedule[name].bubble;
  if(b){b.textContent=text;setTimeout(()=>b.textContent=orig,2500);}
}
setInterval(randomEvent,8000);
</script>
</body>
</html>`);
});

// GET /office/standup — daily AI team meeting room
app.get('/office/standup', async (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  let standup;
  try {
    const r = await axios.get(STANDUP_URL, { timeout: 8000, headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
    standup = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
  } catch (_e) { standup = null; }

  const agentColors = { armando: '#3a7bd5', elena: '#e91e8c', diego: '#e67e22', marco: '#27ae60', sofia: '#00bcd4' };
  const agentEmoji  = { armando: '🛡️', elena: '📋', diego: '📊', marco: '✍️', sofia: '🌐' };
  const agentRole   = { armando: 'Community Manager', elena: 'Client Success', diego: 'Project Manager', marco: 'Content Director', sofia: 'Web Designer / SEO' };

  const messagesHtml = standup?.messages?.map((m, i) => `
    <div class="msg" style="animation-delay:${i * 0.15}s">
      <div class="msg-avatar" style="background:${agentColors[m.agent] || '#555'}">${agentEmoji[m.agent] || '🤖'}</div>
      <div class="msg-body">
        <div class="msg-name" style="color:${agentColors[m.agent] || '#aaa'}">${m.agent.charAt(0).toUpperCase()+m.agent.slice(1)} <span class="msg-role">${agentRole[m.agent] || ''}</span></div>
        <div class="msg-text">${m.message}</div>
      </div>
    </div>`).join('') || '<div class="no-standup">⏳ Standup not yet generated today — runs at 6:50am EST.<br><br>Trigger it now: <code>POST /cron/standup</code></div>';

  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>JRZ AI Team — Daily Standup</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:'Segoe UI',sans-serif;background:#1a1a2e;color:#fff;min-height:100vh}
.header{background:linear-gradient(135deg,#16213e,#0f3460);padding:14px 30px;display:flex;align-items:center;justify-content:space-between;border-bottom:3px solid #e94560}
.header h1{font-size:1.3rem;letter-spacing:1px}
.header .meta{font-size:0.8rem;color:#4ecca3;margin-top:3px}
.back{color:#e94560;text-decoration:none;font-size:0.85rem;border:1px solid #e94560;padding:5px 12px;border-radius:15px}
.back:hover{background:#e94560;color:#fff}
.meeting-room{max-width:820px;margin:30px auto;padding:0 20px}
.room-header{background:linear-gradient(135deg,#0f3460,#16213e);border:1px solid #e94560;border-radius:12px;padding:20px 25px;margin-bottom:24px;display:flex;align-items:center;gap:20px}
.room-icon{font-size:2.5rem}
.room-title{font-size:1.2rem;font-weight:700;color:#fff}
.room-sub{color:#4ecca3;font-size:0.85rem;margin-top:4px}
.room-stats{margin-left:auto;display:flex;gap:16px;flex-wrap:wrap}
.rstat{background:rgba(233,69,96,0.15);border:1px solid rgba(233,69,96,0.3);border-radius:8px;padding:8px 14px;text-align:center}
.rstat strong{color:#e94560;display:block;font-size:1.1rem}
.rstat span{font-size:0.7rem;color:#aaa}
.messages{display:flex;flex-direction:column;gap:16px}
.msg{display:flex;gap:14px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:12px;padding:16px;animation:fadeIn 0.4s ease both}
@keyframes fadeIn{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}
.msg-avatar{width:46px;height:46px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:1.3rem;flex-shrink:0}
.msg-name{font-weight:700;font-size:0.95rem;margin-bottom:4px}
.msg-role{font-weight:400;font-size:0.72rem;color:#888;margin-left:6px}
.msg-text{color:#ddd;font-size:0.9rem;line-height:1.6}
.no-standup{text-align:center;padding:50px 20px;color:#888;font-size:0.95rem;line-height:2}
.no-standup code{background:rgba(255,255,255,0.1);padding:3px 8px;border-radius:4px;color:#4ecca3}
.apis{background:rgba(15,52,96,0.5);border:1px solid rgba(78,204,163,0.2);border-radius:12px;padding:20px 25px;margin-top:24px}
.apis h3{color:#4ecca3;font-size:0.9rem;margin-bottom:14px;text-transform:uppercase;letter-spacing:1px}
.api-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}
.api-tag{background:rgba(78,204,163,0.1);border:1px solid rgba(78,204,163,0.25);border-radius:6px;padding:6px 10px;font-size:0.75rem;color:#4ecca3;display:flex;align-items:center;gap:6px}
.api-dot{width:7px;height:7px;border-radius:50%;background:#4ecca3;flex-shrink:0;box-shadow:0 0 6px #4ecca3}
.trigger{text-align:center;margin-top:20px}
.trigger a{background:#e94560;color:#fff;padding:10px 22px;border-radius:20px;text-decoration:none;font-size:0.85rem;font-weight:600}
.trigger a:hover{background:#c73652}
</style>
</head>
<body>
<div class="header">
  <div>
    <h1>🗓️ Daily AI Team Standup</h1>
    <div class="meta">${standup ? `${standup.dayName}, ${standup.date} · Generated ${new Date(standup.generatedAt).toLocaleTimeString('en-US',{hour:'2-digit',minute:'2-digit',timeZone:'America/New_York'})} EST` : 'Pending generation'}</div>
  </div>
  <a href="/office" class="back">← Back to Office</a>
</div>

<div class="meeting-room">
  <div class="room-header">
    <div class="room-icon">🏢</div>
    <div>
      <div class="room-title">JRZ Marketing — Morning Meeting</div>
      <div class="room-sub">All 5 AI agents · 24/7 operations · ${standup?.clientCount || 0} active clients</div>
    </div>
    <div class="room-stats">
      <div class="rstat"><strong>${standup?.clientCount || '—'}</strong><span>Clients</span></div>
      <div class="rstat"><strong>${standup?.railingCount || '—'}/348</strong><span>Railing Pages</span></div>
      <div class="rstat"><strong>${standup?.cooneyCount || '—'}/128</strong><span>Cooney Pages</span></div>
    </div>
  </div>

  <div class="messages">${messagesHtml}</div>

  <div class="apis">
    <h3>🔌 Active API Connections</h3>
    <div class="api-grid">
      <div class="api-tag"><div class="api-dot"></div>GHL LeadConnector API</div>
      <div class="api-tag"><div class="api-dot"></div>Anthropic Claude API</div>
      <div class="api-tag"><div class="api-dot"></div>DataForSEO API</div>
      <div class="api-tag"><div class="api-dot"></div>ElevenLabs Voice API</div>
      <div class="api-tag"><div class="api-dot"></div>Cloudinary Storage</div>
      <div class="api-tag"><div class="api-dot"></div>NewsAPI</div>
      <div class="api-tag"><div class="api-dot"></div>Apollo.io Enrichment</div>
      <div class="api-tag"><div class="api-dot"></div>Google PageSpeed API</div>
      <div class="api-tag"><div class="api-dot"></div>Google Search Console</div>
      <div class="api-tag"><div class="api-dot"></div>Bland AI Calls</div>
      <div class="api-tag"><div class="api-dot"></div>Pexels / GHL Media</div>
      <div class="api-tag"><div class="api-dot"></div>Render (auto-deploy)</div>
    </div>
  </div>

  <div class="trigger">
    <a href="#" onclick="triggerStandup();return false;">🔄 Regenerate Today's Standup</a>
  </div>
</div>

<script>
async function triggerStandup(){
  const btn=event.target;
  btn.textContent='Generating...';
  btn.style.background='#555';
  try{
    await fetch('/cron/standup',{method:'POST'});
    btn.textContent='✅ Generating — refresh in 30s';
    setTimeout(()=>location.reload(),32000);
  }catch(e){btn.textContent='❌ Error — try again';}
}
const h=new Date(new Date().toLocaleString('en-US',{timeZone:'America/New_York'})).getHours();
if(!${!!standup}||h<7){document.querySelector('.trigger').style.display='block';}
</script>
</body>
</html>`);
});

// POST /cron/standup — generate today's team standup now
app.post('/cron/standup', (_req, res) => {
  res.json({ status: 'started', message: 'Generating standup — check GET /status in ~30s' });
  runDailyTeamStandup()
    .then(r => logCron('standup', 'ok', r))
    .catch(e => { logCron('standup', 'error', e.message); console.error('[Standup] Manual error:', e.message); });
});

// ═══════════════════════════════════════════════════════════
// APOLLO ENRICHMENT — runs Monday 9am EST
// Finds GHL contacts tagged needs_email, hits Apollo People
// Match API to get their email, updates GHL, swaps tag to
// outbound_pending so the bot picks them up at 10am.
// Free plan = 50 credits/month → limit 50 per run.
// ═══════════════════════════════════════════════════════════

async function enrichProspectEmails() {
  console.log('[Apollo] Starting email enrichment...');
  try {
    const res = await axios.get(
      `https://services.leadconnectorhq.com/contacts/?locationId=${GHL_LOCATION_ID}&tags=needs_email&limit=50`,
      { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' } }
    );
    const contacts = res.data?.contacts || [];
    if (!contacts.length) {
      console.log('[Apollo] No contacts need enrichment.');
      return { enriched: 0 };
    }

    let enriched = 0;
    for (const contact of contacts) {
      const firstName = contact.firstName || '';
      const lastName  = contact.lastName  || '';
      const domain    = contact.website?.replace(/https?:\/\//, '').split('/')[0] || '';
      const company   = contact.companyName || '';

      if (!firstName || (!domain && !company)) continue;

      try {
        const apollo = await axios.post(
          'https://api.apollo.io/api/v1/people/match',
          { api_key: APOLLO_API_KEY, first_name: firstName, last_name: lastName, domain, organization_name: company },
          { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' } }
        );

        const email = apollo.data?.person?.email;
        if (!email || email.includes('email_not_found')) {
          console.log(`[Apollo] No email found for ${firstName} ${lastName}`);
          continue;
        }

        // Update GHL contact with real email + swap tags
        await axios.put(
          `https://services.leadconnectorhq.com/contacts/${contact.id}`,
          { email },
          { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
        );
        await axios.post(
          `https://services.leadconnectorhq.com/contacts/${contact.id}/tags`,
          { tags: ['outbound_pending'] },
          { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
        );
        await axios.delete(
          `https://services.leadconnectorhq.com/contacts/${contact.id}/tags`,
          { data: { tags: ['needs_email'] }, headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
        );
        await tagContact(contact.id, ['nurture-sequence']);

        enriched++;
        console.log(`[Apollo] ✅ Enriched ${firstName} ${lastName} → ${email}`);
        await new Promise(r => setTimeout(r, 1000)); // gentle rate limit
      } catch (err) {
        console.error(`[Apollo] ❌ Failed for ${firstName} ${lastName}:`, err?.response?.data || err.message);
      }
    }

    console.log(`[Apollo] Done — ${enriched}/${contacts.length} emails found`);
    return { enriched, total: contacts.length };
  } catch (err) {
    console.error('[Apollo] ❌ Enrichment run failed:', err.message);
    return { enriched: 0, error: err.message };
  }
}

// Manual trigger: POST /cron/enrich-prospects
app.post('/cron/enrich-prospects', async (_req, res) => {
  try {
    const result = await enrichProspectEmails();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Manual trigger: GET /ab-test/results — view current A/B test standings
app.get('/ab-test/results', async (_req, res) => {
  try {
    const data = await loadABTestData();
    const results = Object.entries(data.variants).map(([v, s]) => ({
      variant: v,
      name: CLOSING_VARIANTS[v].name,
      description: CLOSING_VARIANTS[v].description,
      sent: s.sent,
      conversions: s.conversions,
      rate: s.sent > 0 ? `${((s.conversions / s.sent) * 100).toFixed(1)}%` : '—',
      weight: `${data.weights[v]}%`,
    }));
    res.json({ lastOptimized: data.lastOptimized, results, history: data.history.slice(-5) });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// Manual trigger: POST /cron/ab-test-analysis — force A/B analysis now
app.post('/cron/ab-test-analysis', async (_req, res) => {
  try {
    const result = await runABTestAnalysis();
    res.json({ status: 'ok', ...result });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE 1 — LEAD SCORING
// ═══════════════════════════════════════════════════════════

function calculateLeadScore({ leadQuality, sentiment, foundPhone, foundEmail, historyCount, channel }) {
  let score = 0;
  if (foundPhone && foundEmail) score += 4;
  else if (foundPhone || foundEmail) score += 2;
  if (leadQuality === 'hot') score += 3;
  else if (leadQuality === 'qualified') score += 2;
  else if (leadQuality === 'interested') score += 1;
  if (sentiment === 'positive') score += 2;
  else if (sentiment === 'annoyed') score -= 1;
  if (channel === 'Live_Chat') score += 2;
  if (historyCount >= 3) score += 1;
  return Math.max(0, Math.min(10, score));
}

const leadScoreAlertSent = new Set();

async function sendLeadScoreAlert(contactId, contactName, score, channel, foundPhone, foundEmail) {
  const logoUrl = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
  const subject = `🎯 Lead Score ${score}/10 — ${contactName} está listo`;
  const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lead Score Alert — JRZ Marketing</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .week-badge { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .week-badge span { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; border-bottom:3px solid #ffffff; }
    .email-hero h1 { font-size:28px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:16px; }
    .email-hero p { font-size:15px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .email-body { padding:40px 40px 32px; }
    .email-body p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:20px; }
    .email-body strong { color:#0a0a0a; font-weight:700; }
    .lead-card { background:#f9f9f9; border-radius:12px; overflow:hidden; margin:24px 0; }
    .lead-row { padding:12px 20px; border-bottom:1px solid #eeeeee; font-size:14px; color:#333333; }
    .lead-row:last-child { border-bottom:none; }
    .lead-label { font-weight:700; color:#0a0a0a; display:inline-block; width:80px; }
    .score-bar { background:#eeeeee; border-radius:999px; height:10px; margin:8px 0 0; overflow:hidden; }
    .score-fill { background:#0a0a0a; height:10px; border-radius:999px; width:${score * 10}%; }
    .divider { height:1px; background:#f0f0f0; margin:32px 40px; }
    .cta-section { padding:0 40px 40px; text-align:center; }
    .cta-label { font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:16px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; }
    .signature { padding:32px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:16px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="week-badge"><span>🎯 Lead Score Alert</span></div>
  <div class="email-hero">
    <h1>${contactName}<br />Score: ${score}/10</h1>
    <p>Armando detectó un lead de alta intención. Actúa ahora.</p>
  </div>
  <div class="email-body">
    <p>Este lead alcanzó un puntaje de <strong>${score}/10</strong> basado en su comportamiento e información proporcionada:</p>
    <div class="lead-card">
      <div class="lead-row"><span class="lead-label">Nombre</span>${contactName}</div>
      <div class="lead-row"><span class="lead-label">Canal</span>${channel || 'DM'}</div>
      <div class="lead-row"><span class="lead-label">Teléfono</span>${foundPhone || '—'}</div>
      <div class="lead-row"><span class="lead-label">Email</span>${foundEmail || '—'}</div>
      <div class="lead-row"><span class="lead-label">Score</span>${score}/10 <div class="score-bar"><div class="score-fill"></div></div></div>
      <div class="lead-row"><span class="lead-label">Hora</span>${new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })}</div>
    </div>
    <p>Este lead está listo para cerrar. Contáctalo directamente o agenda una llamada.</p>
  </div>
  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">¿Listo para cerrar?</p>
    <a href="${BOOKING_URL}" class="cta-button">Agenda llamada &rarr;</a>
  </div>
  <div class="signature">
    <div class="signature-name">Armando Rivas</div>
    <div class="signature-title">AI Community Manager &middot; JRZ Marketing</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.<br />Alerta automática generada por Armando.</p>
  </div>
</div></div>
</body></html>`;

  try {
    await sendEmail(OWNER_CONTACT_ID, subject, html);
    console.log(`[LeadScore] Alert sent for ${contactName} (${score}/10)`);
  } catch (err) {
    console.error('[LeadScore] Failed to send alert:', err?.response?.data || err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE 2 — NEW CLIENT ONBOARDING
// ═══════════════════════════════════════════════════════════

const onboardedContacts = new Set();

async function sendClientOnboarding(contactId, contactName, businessName, loginEmail) {
  const firstName  = (contactName || 'Cliente').split(' ')[0];
  const logoUrl    = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
  const appStoreUrl   = 'https://apps.apple.com/us/app/lead-connector/id1564153400';
  const playStoreUrl  = 'https://play.google.com/store/apps/details?id=com.gohighlevel.mobileapp';
  const subject    = `Your marketing system is ready, ${firstName} 🚀`;
  const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your system is ready</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .badge-wrap { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .badge { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; }
    .email-hero h1 { font-size:26px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:12px; }
    .email-hero p { font-size:14px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .body-section { padding:36px 40px 28px; }
    .body-section p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:16px; }
    .body-section strong { color:#0a0a0a; font-weight:700; }
    .login-box { background:#0a0a0a; border-radius:12px; padding:24px 28px; margin:20px 0; }
    .login-box .lbl { color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; margin-bottom:4px; }
    .login-box .val { color:#ffffff; font-size:14px; font-weight:600; margin-bottom:14px; }
    .login-box .val:last-child { margin-bottom:0; }
    .steps { margin:16px 0; }
    .step { display:flex; align-items:flex-start; padding:12px 0; border-bottom:1px solid #f0f0f0; }
    .step:last-child { border-bottom:none; }
    .step-num { background:#0a0a0a; color:#ffffff; font-size:12px; font-weight:800; min-width:26px; height:26px; border-radius:50%; display:flex; align-items:center; justify-content:center; margin-right:14px; flex-shrink:0; margin-top:2px; }
    .step-text { font-size:14px; color:#333333; line-height:1.6; }
    .step-text strong { color:#0a0a0a; }
    .setup-grid { background:#f9f9f9; border-radius:12px; padding:20px 24px; margin:16px 0; }
    .setup-item { font-size:13px; color:#333333; padding:7px 0; border-bottom:1px solid #eeeeee; display:flex; align-items:center; gap:10px; }
    .setup-item:last-child { border-bottom:none; }
    .check { color:#0a0a0a; font-weight:700; }
    .app-row { display:flex; gap:10px; justify-content:center; margin:14px 0; flex-wrap:wrap; }
    .app-btn { display:inline-block; background:#f4f4f4; border:1px solid #e0e0e0; color:#0a0a0a !important; font-size:12px; font-weight:600; text-decoration:none; padding:9px 18px; border-radius:8px; }
    .divider { height:1px; background:#f0f0f0; margin:28px 40px; }
    .cta-section { padding:0 40px 36px; text-align:center; }
    .cta-label { font-size:11px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:14px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; margin-bottom:10px; }
    .cta-note { font-size:12px; color:#aaaaaa; }
    .signature { padding:28px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:14px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="badge-wrap"><span class="badge">Sub-account Active &middot; ${businessName || firstName + "'s Business"}</span></div>
  <div class="email-hero">
    <h1>${firstName}, your system is ready ✅</h1>
    <p>Your CRM, automations, and sales pipeline are configured and ready to capture clients today.</p>
  </div>

  <div class="body-section">
    <p>Hi <strong>${firstName}</strong>,</p>
    <p>Your sub-account on our marketing platform is now active. Here are your login credentials:</p>
    <div class="login-box">
      <div class="lbl">Platform</div>
      <div class="val">app.gohighlevel.com</div>
      <div class="lbl">Login Email</div>
      <div class="val">${loginEmail || 'Your registered email'}</div>
      <div class="lbl">Password</div>
      <div class="val">You'll receive a separate email from GoHighLevel to set your password.</div>
    </div>
    <p><strong>What's already set up in your system:</strong></p>
    <div class="setup-grid">
      <div class="setup-item"><span class="check">✓</span> CRM with your organized sales pipeline</div>
      <div class="setup-item"><span class="check">✓</span> AI chatbot — auto-responds to leads 24/7</div>
      <div class="setup-item"><span class="check">✓</span> 13-email nurture sequence (6 months of follow-up)</div>
      <div class="setup-item"><span class="check">✓</span> Booking calendar integrated</div>
      <div class="setup-item"><span class="check">✓</span> Weekly performance reports dashboard</div>
      <div class="setup-item"><span class="check">✓</span> Social media integrations</div>
    </div>
    <p><strong>Your first 3 steps:</strong></p>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-text"><strong>Log in</strong> at app.gohighlevel.com and set your password.</div></div>
      <div class="step"><div class="step-num">2</div><div class="step-text"><strong>Download the app</strong> "Lead Connector" on your phone to manage leads anywhere.</div></div>
      <div class="step"><div class="step-num">3</div><div class="step-text"><strong>Book your onboarding call</strong> — 30 minutes and we'll walk you through everything live.</div></div>
    </div>
    <p style="text-align:center;font-size:14px;"><strong>Download the mobile app:</strong></p>
    <div class="app-row">
      <a href="${appStoreUrl}" class="app-btn">📱 App Store (iPhone)</a>
      <a href="${playStoreUrl}" class="app-btn">🤖 Google Play (Android)</a>
    </div>
    <p style="font-size:14px;">Questions? Reply to this email or reach us directly at (407) 844-6376. We're here to make sure your system runs at 100%.</p>
  </div>

  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">Next Step</p>
    <a href="${BOOKING_URL}" class="cta-button">Book Your Onboarding Call &rarr;</a>
    <p class="cta-note">30 min &middot; Free &middot; We walk you through everything live</p>
  </div>
  <div class="signature">
    <div class="signature-name">Jose Rivas</div>
    <div class="signature-title">CEO &middot; JRZ Marketing &middot; (407) 844-6376</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.<br />jrzmarketing.com</p>
  </div>
</div></div>
</body></html>`;

  try {
    await sendEmail(contactId, subject, html);
    console.log(`[Onboarding] Welcome email sent to ${contactName} (${contactId})`);
  } catch (err) {
    console.error('[Onboarding] Failed to send welcome email:', err?.response?.data || err.message);
  }
}

app.post('/webhook/new-client', async (req, res) => {
  res.json({ ok: true });
  try {
    const payload = req.body;
    const contactId   = payload.contactId || payload.contact_id || payload.contact?.id || payload.customData?.contactId || '';
    const contactName = payload.fullName || payload.full_name || payload.contactName || payload.firstName || payload.first_name || payload.customData?.fullName || '';
    const businessName = payload.businessName || payload.companyName || payload.customData?.businessName || '';
    const loginEmail  = payload.email || payload.contact?.email || payload.customData?.email || '';
    if (!contactId) { console.log('[Onboarding] Missing contactId, skipping.'); return; }
    if (onboardedContacts.has(contactId)) { console.log(`[Onboarding] Already onboarded ${contactId}, skipping.`); return; }
    onboardedContacts.add(contactId);
    // Mark any pending objection responses as converted — this is a real booking
    markObjectionConverted(contactId); // fire-and-forget
    logWeeklyWin(contactId, 'booked', 'booking'); // fire-and-forget
    await sendClientOnboarding(contactId, contactName, businessName, loginEmail);
  } catch (err) {
    console.error('[Onboarding] Webhook error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE 3 — PROPOSAL GENERATOR
// ═══════════════════════════════════════════════════════════

const proposalsSent = new Set();

async function generateAndSendProposal(contactId, contactName, businessType, email) {
  const logoUrl = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
  try {
    const promptText = `Generate a professional proposal for a ${businessType} business wanting JRZ Marketing services. Return ONLY valid JSON: { "challenge": "main pain point", "solution": "how JRZ solves it", "services": ["service1", "service2", "service3"], "timeline": "expected timeline", "investment": "Starting at $497/month" }`;
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: promptText }],
    });
    const proposal = JSON.parse(msg.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);

    const subject = `Propuesta JRZ Marketing — ${contactName}`;
    const servicesHtml = (proposal.services || []).map(s => `<li style="padding:10px 0 10px 28px;position:relative;border-bottom:1px solid #f0f0f0;font-size:15px;color:#333333;"><span style="position:absolute;left:0;font-weight:700;color:#0a0a0a;">✓</span>${s}</li>`).join('');
    const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Propuesta JRZ Marketing</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .week-badge { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .week-badge span { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; border-bottom:3px solid #ffffff; }
    .email-hero h1 { font-size:28px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:16px; }
    .email-hero p { font-size:15px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .email-body { padding:40px 40px 32px; }
    .email-body p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:20px; }
    .email-body strong { color:#0a0a0a; font-weight:700; }
    .section-title { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:#999999; margin:28px 0 10px; }
    .section-box { background:#f9f9f9; border-radius:12px; padding:20px 24px; margin-bottom:20px; font-size:15px; color:#333333; line-height:1.7; }
    .services-list { list-style:none; padding:0; margin:0; }
    .investment-box { background:#0a0a0a; border-radius:12px; padding:24px; text-align:center; margin:24px 0; }
    .investment-amount { font-size:28px; font-weight:800; color:#ffffff; }
    .investment-label { font-size:12px; color:rgba(255,255,255,0.4); margin-top:4px; letter-spacing:0.08em; text-transform:uppercase; }
    .divider { height:1px; background:#f0f0f0; margin:32px 40px; }
    .cta-section { padding:0 40px 40px; text-align:center; }
    .cta-label { font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:16px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; }
    .signature { padding:32px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:16px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="week-badge"><span>Propuesta Personalizada</span></div>
  <div class="email-hero">
    <h1>Propuesta para<br />${contactName}</h1>
    <p>Solución de marketing digital diseñada específicamente para tu negocio de ${businessType}.</p>
  </div>
  <div class="email-body">
    <p class="section-title">El reto</p>
    <div class="section-box">${proposal.challenge || ''}</div>
    <p class="section-title">Nuestra solución</p>
    <div class="section-box">${proposal.solution || ''}</div>
    <p class="section-title">Servicios incluidos</p>
    <ul class="services-list">${servicesHtml}</ul>
    <p class="section-title">Timeline</p>
    <div class="section-box">${proposal.timeline || ''}</div>
    <p class="section-title">Inversión</p>
    <div class="investment-box">
      <div class="investment-amount">${proposal.investment || 'Starting at $497/month'}</div>
      <div class="investment-label">Inversión mensual personalizada</div>
    </div>
  </div>
  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">¿Listo para arrancar?</p>
    <a href="${BOOKING_URL}" class="cta-button">Agenda tu llamada de inicio &rarr;</a>
  </div>
  <div class="signature">
    <div class="signature-name">Jose Rivas</div>
    <div class="signature-title">CEO &middot; JRZ Marketing</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.<br />Propuesta generada por el equipo de JRZ Marketing.</p>
  </div>
</div></div>
</body></html>`;

    await sendEmail(contactId, subject, html);
    console.log(`[Proposal] Sent proposal to ${contactName} (${contactId})`);
  } catch (err) {
    console.error('[Proposal] Failed:', err?.response?.data || err.message);
  }
}

app.post('/webhook/hot-lead', async (req, res) => {
  res.json({ ok: true });
  try {
    const payload = req.body;
    const contactId = payload.contactId || payload.contact_id || payload.contact?.id || payload.customData?.contactId || '';
    const contactName = payload.fullName || payload.full_name || payload.contactName || payload.firstName || payload.first_name || payload.customData?.fullName || '';
    const businessType = payload.customData?.businessType || payload.businessType || 'negocio';
    const email = payload.email || payload.contact?.email || payload.customData?.email || '';
    if (!contactId) { console.log('[Proposal] Missing contactId, skipping.'); return; }
    if (proposalsSent.has(contactId)) { console.log(`[Proposal] Already sent proposal for ${contactId}, skipping.`); return; }
    proposalsSent.add(contactId);
    await generateAndSendProposal(contactId, contactName, businessType, email);
  } catch (err) {
    console.error('[Proposal] Webhook error:', err.message);
  }
});

// ═══════════════════════════════════════════════════════════
// FEATURE 4 — CLIENT CHECK-INS (30-day rolling)
// ═══════════════════════════════════════════════════════════

const CHECKIN_URL    = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/client_checkins.json';
const CHECKIN_PUB_ID = 'jrz/client_checkins';

async function loadCheckInData() {
  try {
    const res = await axios.get(CHECKIN_URL, { timeout: 8000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch {
    return {};
  }
}

async function saveCheckInData(data) {
  try {
    const ts      = Math.floor(Date.now() / 1000);
    const sigStr  = `overwrite=true&public_id=${CHECKIN_PUB_ID}&resource_type=raw&timestamp=${ts}${CLOUDINARY_API_SECRET}`;
    const sig     = crypto.createHash('sha1').update(sigStr).digest('hex');
    const form    = new FormData();
    const buf     = Buffer.from(JSON.stringify(data, null, 2));
    form.append('file',          buf,  { filename: 'client_checkins.json', contentType: 'application/json' });
    form.append('public_id',     CHECKIN_PUB_ID);
    form.append('resource_type', 'raw');
    form.append('timestamp',     String(ts));
    form.append('api_key',       CLOUDINARY_API_KEY);
    form.append('signature',     sig);
    form.append('overwrite',     'true');
    await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`,
      form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 30000 }
    );
  } catch (err) {
    console.error('[CheckIn] Failed to save check-in data:', err.message);
  }
}

async function getActiveClients() {
  const res = await axios.get(
    `https://services.leadconnectorhq.com/contacts/`,
    { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28' },
      params: { locationId: GHL_LOCATION_ID, query: 'active-client', limit: 100 } }
  );
  return res.data?.contacts || [];
}

async function runClientCheckIns() {
  console.log('[CheckIn] Running 30-day client check-ins...');
  try {
    const [clients, checkInData] = await Promise.all([getActiveClients(), loadCheckInData()]);
    const thirtyDays = 30 * 24 * 60 * 60 * 1000;
    const now = Date.now();
    for (const client of clients) {
      try {
        const lastCheckIn = checkInData[client.id];
        if (lastCheckIn && (now - lastCheckIn) < thirtyDays) continue;
        const contactName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'amigo';
        const msgResp = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 150,
          messages: [{ role: 'user', content: `You are Armando from JRZ Marketing. Write a short, warm 2-sentence check-in message in Spanish to ${contactName} asking how their business is going and if there's anything the team can help with. Sound like a real person, not a template.` }],
        });
        const message = msgResp.content[0].text.trim();
        await sendGHLReply(client.id, message, 'SMS');
        checkInData[client.id] = Date.now();
        console.log(`[CheckIn] Sent check-in to ${contactName} (${client.id})`);
      } catch (err) {
        console.error(`[CheckIn] Failed for client ${client.id}:`, err.message);
      }
    }
    await saveCheckInData(checkInData);
    console.log('[CheckIn] Done.');
  } catch (err) {
    console.error('[CheckIn] Error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE 5 — MONTHLY CLIENT REPORTS
// ═══════════════════════════════════════════════════════════

async function sendMonthlyClientReports() {
  console.log('[MonthlyReport] Generating monthly client reports...');
  try {
    const logoUrl = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
    const nowDate = new Date();
    const month = nowDate.toLocaleString('es-ES', { month: 'long', year: 'numeric' });
    const [clients, stats] = await Promise.all([getActiveClients(), getWeeklyStats().catch(() => null)]);
    const statsSnap = stats ? JSON.stringify(stats).slice(0, 400) : 'Sin datos disponibles';

    for (const client of clients) {
      try {
        const contactName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Cliente';
        const firstName = (contactName).split(' ')[0];
        const businessType = (client.tags || []).find(t => t !== 'active-client') || 'negocio';

        const reportMsg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 500,
          messages: [{ role: 'user', content: `You are JRZ Marketing's reporting AI. Generate a personalized monthly report for client: ${contactName}, business type: ${businessType}, month: ${month}. Social stats snapshot: ${statsSnap}. Return ONLY valid JSON: { "headline": "...", "wins": ["win1", "win2", "win3"], "nextMonth": "focus for next month", "personalNote": "personal note for this client from Jose" }` }],
        });
        const report = JSON.parse(reportMsg.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);
        const winsHtml = (report.wins || []).map(w => `<li style="padding:10px 0 10px 28px;position:relative;border-bottom:1px solid #f0f0f0;font-size:15px;color:#333333;"><span style="position:absolute;left:0;font-weight:700;color:#0a0a0a;">✓</span>${w}</li>`).join('');

        const subject = `📊 Tu Reporte Mensual — ${month} | JRZ Marketing`;
        const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reporte Mensual JRZ Marketing</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .week-badge { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .week-badge span { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; border-bottom:3px solid #ffffff; }
    .email-hero h1 { font-size:28px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:16px; }
    .email-hero p { font-size:15px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .email-body { padding:40px 40px 32px; }
    .email-body p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:20px; }
    .email-body strong { color:#0a0a0a; font-weight:700; }
    .section-title { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:#999999; margin:28px 0 10px; }
    .wins-list { list-style:none; padding:0; margin:0 0 20px; }
    .section-box { background:#f9f9f9; border-radius:12px; padding:20px 24px; margin-bottom:20px; font-size:15px; color:#333333; line-height:1.7; }
    .note-box { background:#0a0a0a; border-radius:12px; padding:24px; margin:24px 0; font-size:15px; color:rgba(255,255,255,0.8); line-height:1.7; font-style:italic; }
    .divider { height:1px; background:#f0f0f0; margin:32px 40px; }
    .cta-section { padding:0 40px 40px; text-align:center; }
    .cta-label { font-size:12px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:16px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; }
    .signature { padding:32px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:16px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="week-badge"><span>Reporte Mensual — ${month}</span></div>
  <div class="email-hero">
    <h1>${firstName},<br />este fue tu mes. 📊</h1>
    <p>${report.headline || 'Resumen de tus resultados con JRZ Marketing.'}</p>
  </div>
  <div class="email-body">
    <p>Hola <strong>${firstName}</strong>,</p>
    <p>Aquí está tu reporte mensual de resultados. Estos son los logros más importantes de este mes:</p>
    <p class="section-title">Logros del mes</p>
    <ul class="wins-list">${winsHtml}</ul>
    <p class="section-title">Enfoque del próximo mes</p>
    <div class="section-box">${report.nextMonth || ''}</div>
    <p class="section-title">Nota personal de Jose</p>
    <div class="note-box">${report.personalNote || ''}</div>
  </div>
  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">¿Tienes preguntas?</p>
    <a href="${BOOKING_URL}" class="cta-button">Habla con el equipo &rarr;</a>
  </div>
  <div class="signature">
    <div class="signature-name">Jose Rivas</div>
    <div class="signature-title">CEO &middot; JRZ Marketing</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.</p>
  </div>
</div></div>
</body></html>`;

        await sendEmail(client.id, subject, html);
        console.log(`[MonthlyReport] Sent to ${contactName} (${client.id})`);
      } catch (err) {
        console.error(`[MonthlyReport] Failed for client ${client.id}:`, err.message);
      }
    }
    console.log('[MonthlyReport] Done.');
  } catch (err) {
    console.error('[MonthlyReport] Error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE 6b — MONTHLY SUB-ACCOUNT CHECK-IN EMAIL
//   Runs last Friday of every month @ 10am EST
//   Sends English email to every contact tagged active-client
//   with GHL news, updates, and a personal check-in note
// ═══════════════════════════════════════════════════════════

async function sendSubAccountCheckInEmails() {
  console.log('[SubCheckIn] Running monthly sub-account check-in emails...');
  try {
    const logoUrl   = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
    const nowDate   = new Date();
    const monthName = nowDate.toLocaleString('en-US', { month: 'long', year: 'numeric' });

    // Fetch latest GHL news via NewsAPI
    let newsItems = [];
    try {
      const newsRes = await axios.get(
        'https://newsapi.org/v2/everything?q=Go+High+Level+CRM+update+feature&language=en&sortBy=publishedAt&pageSize=6&apiKey=' + NEWS_API_KEY,
        { timeout: 10000 }
      );
      newsItems = (newsRes.data?.articles || []).slice(0, 5).map(a => `- ${a.title}: ${(a.description || '').slice(0, 120)}`);
    } catch (_) {}

    // Claude generates the GHL update section + tip of the month
    const aiRes = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{
        role: 'user',
        content: `You are JRZ Marketing's client success AI. Write a friendly, professional monthly check-in email body for sub-account clients. Month: ${monthName}. Recent GHL news/articles:\n${newsItems.join('\n') || 'No articles available.'}\n\nReturn ONLY valid JSON:\n{"subject_suffix": "one short subject line suffix (max 50 chars)", "intro": "1-2 sentence warm intro (English)", "ghl_updates": ["update 1", "update 2", "update 3"], "tip": "one actionable marketing tip they can apply this month", "closing": "1 sentence warm closing from Jose"}`,
      }],
    });
    const aiText = aiRes.content[0].text.trim().match(/\{[\s\S]*\}/)?.[0] || '{}';
    const ai = JSON.parse(aiText);

    const updatesHtml = (ai.ghl_updates || ['Platform improvements rolling out', 'New automation features available', 'Performance enhancements deployed'])
      .map(u => `<div class="update-item"><span class="check">✓</span>${u}</div>`).join('');

    const clients = await getActiveClients();
    let sent = 0;

    for (const client of clients) {
      try {
        const contactName = `${client.firstName || ''} ${client.lastName || ''}`.trim() || 'Client';
        const firstName   = contactName.split(' ')[0];
        const subject     = `${monthName} Update — Your Marketing System ${ai.subject_suffix || '| JRZ Marketing'}`;

        const html = `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${subject}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .badge-wrap { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .badge { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; }
    .email-hero h1 { font-size:26px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:12px; }
    .email-hero p { font-size:14px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .body-section { padding:36px 40px 28px; }
    .body-section p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:16px; }
    .body-section strong { color:#0a0a0a; font-weight:700; }
    .section-label { font-size:10px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; color:#999999; margin:24px 0 12px; }
    .updates-box { background:#f9f9f9; border-radius:12px; padding:20px 24px; margin:16px 0; }
    .update-item { font-size:14px; color:#333333; padding:8px 0; border-bottom:1px solid #eeeeee; display:flex; align-items:flex-start; gap:10px; line-height:1.5; }
    .update-item:last-child { border-bottom:none; }
    .check { color:#0a0a0a; font-weight:700; flex-shrink:0; }
    .tip-box { background:#0a0a0a; border-radius:12px; padding:24px 28px; margin:20px 0; }
    .tip-label { color:rgba(255,255,255,0.45); font-size:10px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; margin-bottom:10px; }
    .tip-text { color:#ffffff; font-size:15px; line-height:1.7; }
    .divider { height:1px; background:#f0f0f0; margin:28px 40px; }
    .cta-section { padding:0 40px 36px; text-align:center; }
    .cta-label { font-size:11px; font-weight:600; letter-spacing:0.08em; text-transform:uppercase; color:#999999; margin-bottom:14px; }
    .cta-button { display:inline-block; background:#0a0a0a; color:#ffffff !important; font-size:15px; font-weight:700; text-decoration:none; padding:16px 40px; border-radius:10px; margin-bottom:10px; }
    .cta-note { font-size:12px; color:#aaaaaa; }
    .signature { padding:28px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:14px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="badge-wrap"><span class="badge">Monthly Update &middot; ${monthName}</span></div>
  <div class="email-hero">
    <h1>${firstName}, here's what's new 🚀</h1>
    <p>Your monthly platform update + what we're seeing in the market right now.</p>
  </div>
  <div class="body-section">
    <p>Hi <strong>${firstName}</strong>,</p>
    <p>${ai.intro || "We're checking in to share what's new on your platform and a quick tip to help you get more out of your system this month."}</p>
    <p class="section-label">GoHighLevel Platform Updates</p>
    <div class="updates-box">${updatesHtml}</div>
    <p class="section-label">Tip of the Month</p>
    <div class="tip-box">
      <div class="tip-label">💡 Action Item for You</div>
      <div class="tip-text">${ai.tip || 'Make sure your booking calendar is linked to your main CTA button — this one change alone can double your booked calls.'}</div>
    </div>
    <p>${ai.closing || "As always, if you have questions or want us to look at something in your account, we're one message away."}</p>
    <p>— <strong>Jose Rivas</strong> &amp; the JRZ Marketing team</p>
  </div>
  <div class="divider"></div>
  <div class="cta-section">
    <p class="cta-label">Need help with your system?</p>
    <a href="${BOOKING_URL}" class="cta-button">Book a Call with Jose &rarr;</a>
    <p class="cta-note">30 min &middot; Free &middot; We'll review your account live</p>
  </div>
  <div class="signature">
    <div class="signature-name">Jose Rivas</div>
    <div class="signature-title">CEO &middot; JRZ Marketing &middot; (407) 844-6376</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.<br />jrzmarketing.com</p>
  </div>
</div></div>
</body></html>`;

        await sendEmail(client.id, subject, html);
        sent++;
        console.log(`[SubCheckIn] Sent to ${contactName} (${client.id})`);
        await new Promise(r => setTimeout(r, 500)); // rate limit
      } catch (err) {
        console.error(`[SubCheckIn] Failed for ${client.id}:`, err.message);
      }
    }
    console.log(`[SubCheckIn] Done. Sent to ${sent}/${clients.length} clients.`);
  } catch (err) {
    console.error('[SubCheckIn] Error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// FEATURE 6 — COMPETITOR MONITORING
// ═══════════════════════════════════════════════════════════

async function runCompetitorMonitoring() {
  console.log('[Competitor] Running weekly competitor monitoring...');
  try {
    const logoUrl = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
    const date = new Date().toLocaleDateString('es-ES', { timeZone: 'America/New_York', day: '2-digit', month: 'long', year: 'numeric' });

    const [res1, res2, res3] = await Promise.all([
      axios.get('https://newsapi.org/v2/everything?q=marketing+digital+hispano+peque%C3%B1os+negocios&language=es&sortBy=publishedAt&pageSize=5&apiKey=dff54f64e9eb4087aa7c215a1c674644', { timeout: 10000 }).catch(() => null),
      axios.get('https://newsapi.org/v2/everything?q=AI+marketing+automation+small+business&language=en&sortBy=publishedAt&pageSize=5&apiKey=dff54f64e9eb4087aa7c215a1c674644', { timeout: 10000 }).catch(() => null),
      axios.get('https://newsapi.org/v2/everything?q=Go+High+Level+CRM+agency&language=en&sortBy=publishedAt&pageSize=5&apiKey=dff54f64e9eb4087aa7c215a1c674644', { timeout: 10000 }).catch(() => null),
    ]);

    const articles = [
      ...(res1?.data?.articles || []),
      ...(res2?.data?.articles || []),
      ...(res3?.data?.articles || []),
    ];
    const summary = articles.map(a => `- ${a.title}: ${a.description || ''}`).join('\n').slice(0, 3000);

    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: `Analyze these digital marketing news articles and return ONLY valid JSON: { "trendingSince": "what's trending in digital marketing this week", "opportunity": "biggest opportunity for JRZ Marketing based on these trends", "contentIdea": "one specific content idea for JRZ's social media based on trends", "competitorMove": "what agencies/competitors seem to be focusing on", "actionItem": "one specific action Jose should take this week" }\n\nArticles:\n${summary}` }],
    });
    const insights = JSON.parse(msg.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);

    const subject = `🔍 Radar Semanal — Tendencias + Competencia (${date})`;
    const html = `<!DOCTYPE html>
<html lang="es" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Radar Semanal JRZ Marketing</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background-color:#f4f4f4; color:#0a0a0a; -webkit-font-smoothing:antialiased; }
    .email-wrapper { background-color:#f4f4f4; padding:40px 20px; }
    .email-container { max-width:600px; margin:0 auto; background:#ffffff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .email-header { background:#0a0a0a; padding:32px 40px; text-align:center; }
    .email-header img { height:48px; width:auto; }
    .week-badge { background:#0a0a0a; padding:0 40px 24px; text-align:center; }
    .week-badge span { display:inline-block; background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.15); color:rgba(255,255,255,0.5); font-size:11px; font-weight:600; letter-spacing:0.1em; text-transform:uppercase; padding:6px 16px; border-radius:100px; }
    .email-hero { background:#0a0a0a; padding:40px 40px 48px; border-bottom:3px solid #ffffff; }
    .email-hero h1 { font-size:28px; font-weight:800; color:#ffffff; line-height:1.2; letter-spacing:-0.02em; margin-bottom:16px; }
    .email-hero p { font-size:15px; color:rgba(255,255,255,0.55); line-height:1.7; }
    .email-body { padding:40px 40px 32px; }
    .email-body p { font-size:15px; color:#333333; line-height:1.8; margin-bottom:20px; }
    .email-body strong { color:#0a0a0a; font-weight:700; }
    .insight-row { display:flex; align-items:flex-start; padding:20px 0; border-bottom:1px solid #f0f0f0; }
    .insight-row:last-child { border-bottom:none; }
    .insight-icon { font-size:22px; min-width:36px; margin-right:16px; }
    .insight-content { flex:1; }
    .insight-label { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:#999999; margin-bottom:6px; }
    .insight-text { font-size:15px; color:#333333; line-height:1.6; }
    .action-box { background:#0a0a0a; border-radius:12px; padding:24px; margin:24px 0; }
    .action-label { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:rgba(255,255,255,0.4); margin-bottom:10px; }
    .action-text { font-size:16px; font-weight:700; color:#ffffff; line-height:1.5; }
    .divider { height:1px; background:#f0f0f0; margin:32px 40px; }
    .signature { padding:32px 40px; background:#f9f9f9; border-top:1px solid #eeeeee; }
    .signature-name { font-size:16px; font-weight:700; color:#0a0a0a; margin-bottom:4px; }
    .signature-title { font-size:13px; color:#777777; }
    .email-footer { background:#0a0a0a; padding:28px 40px; text-align:center; }
    .email-footer img { height:28px; width:auto; margin-bottom:16px; opacity:0.7; }
    .footer-copy { font-size:11px; color:rgba(255,255,255,0.2); line-height:1.6; }
  </style>
</head>
<body>
<div class="email-wrapper"><div class="email-container">
  <div class="email-header"><img src="${logoUrl}" alt="JRZ Marketing" /></div>
  <div class="week-badge"><span>Radar Semanal — ${date}</span></div>
  <div class="email-hero">
    <h1>Tendencias + Competencia<br />esta semana. 🔍</h1>
    <p>Análisis automático de ${articles.length} artículos del mercado digital.</p>
  </div>
  <div class="email-body">
    <div class="insight-row">
      <div class="insight-icon">📈</div>
      <div class="insight-content"><div class="insight-label">Tendencia de la semana</div><div class="insight-text">${insights.trendingSince || ''}</div></div>
    </div>
    <div class="insight-row">
      <div class="insight-icon">💡</div>
      <div class="insight-content"><div class="insight-label">Oportunidad para JRZ</div><div class="insight-text">${insights.opportunity || ''}</div></div>
    </div>
    <div class="insight-row">
      <div class="insight-icon">🎯</div>
      <div class="insight-content"><div class="insight-label">Idea de contenido</div><div class="insight-text">${insights.contentIdea || ''}</div></div>
    </div>
    <div class="insight-row">
      <div class="insight-icon">🏢</div>
      <div class="insight-content"><div class="insight-label">Movimiento de competidores</div><div class="insight-text">${insights.competitorMove || ''}</div></div>
    </div>
    <div class="action-box">
      <div class="action-label">Accion de esta semana</div>
      <div class="action-text">${insights.actionItem || ''}</div>
    </div>
  </div>
  <div class="divider"></div>
  <div class="signature">
    <div class="signature-name">Armando Rivas</div>
    <div class="signature-title">AI Community Manager &middot; JRZ Marketing</div>
  </div>
  <div class="email-footer">
    <img src="${logoUrl}" alt="JRZ Marketing" />
    <p class="footer-copy">&copy; 2026 JRZ Marketing. Orlando, Florida.<br />Radar semanal automático generado por Armando.</p>
  </div>
</div></div>
</body></html>`;

    await sendEmail(OWNER_CONTACT_ID, subject, html);
    console.log('[Competitor] Weekly radar email sent to Jose.');
    // Persist insights for Armando's voice scripts
    await saveCompetitorInsights({ ...insights, updatedAt: new Date().toISOString() });
  } catch (err) {
    console.error('[Competitor] Error:', err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// MANUAL TRIGGER ENDPOINTS — new features
// ═══════════════════════════════════════════════════════════

app.post('/cron/competitor-monitoring', async (_req, res) => {
  try {
    await runCompetitorMonitoring();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/review-mining', async (_req, res) => {
  try {
    await runReviewMining();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// GOOGLE CALENDAR — Armando books directly into JRZ Calendar
// Every day 7am–9pm EST, 15-min slots
// ═══════════════════════════════════════════════════════════

async function getJRZCalendarId() {
  if (jrzCalendarId) return jrzCalendarId;
  const token = await getGoogleAccessToken();
  const res   = await axios.get('https://www.googleapis.com/calendar/v3/users/me/calendarList', { headers: { Authorization: `Bearer ${token}` } });
  const cal   = (res.data.items || []).find(c => c.summary && (c.summary.includes('JRZ') || c.summary === 'JRZ Calendar'));
  jrzCalendarId = cal ? cal.id : 'primary';
  console.log(`[Calendar] Using calendar: ${jrzCalendarId}`);
  return jrzCalendarId;
}

async function getAvailableSlots(daysAhead = 3) {
  const token  = await getGoogleAccessToken();
  const calId  = await getJRZCalendarId();
  const slots  = [];
  const nowEST = new Date(new Date().toLocaleString('en-US', { timeZone: BOOKING_TZ }));

  for (let d = 0; d <= daysAhead && slots.length < 3; d++) {
    const dayStart = new Date(nowEST);
    dayStart.setDate(dayStart.getDate() + d);
    dayStart.setHours(BOOKING_START_HOUR, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(BOOKING_END_HOUR, 0, 0, 0);

    // Today: start from next 30-min boundary + 1hr buffer
    if (d === 0) {
      const buffer = new Date(nowEST.getTime() + 60 * 60 * 1000);
      buffer.setMinutes(Math.ceil(buffer.getMinutes() / 30) * 30, 0, 0);
      if (buffer > dayStart) dayStart.setTime(buffer.getTime());
    }
    if (dayStart >= dayEnd) continue;

    const freeBusy = await axios.post('https://www.googleapis.com/calendar/v3/freeBusy', {
      timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(),
      timeZone: BOOKING_TZ, items: [{ id: calId }],
    }, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });

    const busy = (freeBusy.data.calendars?.[calId]?.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));

    let cursor = new Date(dayStart);
    while (cursor < dayEnd && slots.length < 3) {
      const slotEnd = new Date(cursor.getTime() + BOOKING_DURATION * 60 * 1000);
      const isBusy  = busy.some(b => cursor < b.end && slotEnd > b.start);
      if (!isBusy) slots.push({ start: new Date(cursor), end: slotEnd });
      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    }
  }
  return slots;
}

function formatSlot(slot) {
  return slot.start.toLocaleString('en-US', { timeZone: BOOKING_TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }) + ' EST';
}

async function createCalendarEvent(contactName, contactEmail, slot) {
  const token = await getGoogleAccessToken();
  const calId = await getJRZCalendarId();
  const event = {
    summary:     `📞 15-min Strategy Call — ${contactName}`,
    description: `Free 15-min strategy call booked by Armando (JRZ Marketing AI).\nContact: ${contactName}\nEmail: ${contactEmail || 'N/A'}`,
    start: { dateTime: slot.start.toISOString(), timeZone: BOOKING_TZ },
    end:   { dateTime: slot.end.toISOString(),   timeZone: BOOKING_TZ },
    attendees: contactEmail ? [{ email: contactEmail }] : [],
    reminders: { useDefault: false, overrides: [{ method: 'email', minutes: 60 }, { method: 'popup', minutes: 15 }] },
  };
  const res = await axios.post(
    `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?sendUpdates=all`,
    event, { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
  console.log(`[Calendar] ✅ Booked: ${contactName} at ${formatSlot(slot)}`);
  return res.data;
}

// ═══════════════════════════════════════════════════════════
// GMAIL — Armando monitors info@jrzmarketing.com
// Runs every 10 minutes — classifies, replies, creates GHL contacts
// ═══════════════════════════════════════════════════════════

async function getGoogleAccessToken() {
  if (googleAccessToken && Date.now() < googleTokenExpiry - 60000) return googleAccessToken;
  const res = await axios.post('https://oauth2.googleapis.com/token', {
    client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET,
    refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token',
  });
  googleAccessToken = res.data.access_token;
  googleTokenExpiry = Date.now() + (res.data.expires_in * 1000);
  return googleAccessToken;
}

function parseEmailHeaders(headers) {
  const get = (name) => (headers || []).find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';
  return { from: get('From'), subject: get('Subject'), messageId: get('Message-ID'), references: get('References') };
}

function getEmailBody(payload) {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data)
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' && part.body?.data)
        return Buffer.from(part.body.data, 'base64').toString('utf-8');
    }
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body?.data)
        return Buffer.from(part.body.data, 'base64').toString('utf-8').replace(/<[^>]*>/g, ' ');
    }
  }
  return '';
}

function buildRawEmail(to, subject, body, inReplyTo, references) {
  const lines = [
    `From: Armando — JRZ Marketing <${GMAIL_ADDRESS}>`,
    `To: ${to}`,
    `Subject: ${subject.startsWith('Re:') ? subject : 'Re: ' + subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
  ];
  if (inReplyTo)  lines.push(`In-Reply-To: ${inReplyTo}`);
  if (references) lines.push(`References: ${references} ${inReplyTo}`.trim());
  lines.push('', body);
  return Buffer.from(lines.join('\r\n')).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sendGmailReply(threadId, to, subject, body, inReplyTo, references) {
  const token = await getGoogleAccessToken();
  const raw   = buildRawEmail(to, subject, body, inReplyTo, references);
  await axios.post(
    'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
    { raw, threadId },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

async function markEmailRead(emailId) {
  const token = await getGoogleAccessToken();
  await axios.post(
    `https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}/modify`,
    { removeLabelIds: ['UNREAD'] },
    { headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } }
  );
}

async function processGmailEmail(emailId, token) {
  const res     = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${emailId}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
  const email   = res.data;
  const headers = parseEmailHeaders(email.payload?.headers);
  const body    = getEmailBody(email.payload);

  if (!headers.from || headers.from.includes(GMAIL_ADDRESS)) { await markEmailRead(emailId); return; }
  if (!body.trim()) { await markEmailRead(emailId); return; }

  console.log(`[Gmail] Processing: "${headers.subject}" from ${headers.from}`);

  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 600,
    messages: [{ role: 'user', content: `You are Armando, bilingual AI manager for JRZ Marketing (Orlando, FL). Analyze this email and return ONLY valid JSON:\n{"category":"lead|client|vendor|partnership|spam|other","language":"es|en","shouldReply":true,"reply":"warm reply max 120 words","contactName":"first name or empty","isUrgent":false,"summary":"one line for Jose"}\n\nFrom: ${headers.from}\nSubject: ${headers.subject}\nBody: ${body.slice(0, 1500)}\n\nCategories: lead=asking about JRZ services/pricing, client=existing client, vendor=selling to JRZ, partnership=collab offer, spam=bulk/unsolicited, other=everything else. Reply in same language as sender. Spam=shouldReply false.` }],
  });
  const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);

  // Send reply
  if (parsed.shouldReply && parsed.reply) {
    await sendGmailReply(email.threadId, headers.from, headers.subject, parsed.reply, headers.messageId, headers.references);
    console.log(`[Gmail] ✅ Replied to ${headers.from} (${parsed.category})`);
  }

  // Create GHL contact for leads
  if (parsed.category === 'lead') {
    const emailMatch = headers.from.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (emailMatch) {
      try {
        await axios.post(
          'https://services.leadconnectorhq.com/contacts/',
          { locationId: GHL_LOCATION_ID, email: emailMatch[0], firstName: parsed.contactName || '', tags: ['email-lead', 'armando-gmail'], source: 'Gmail' },
          { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' } }
        );
        console.log(`[Gmail] ✅ GHL contact created: ${emailMatch[0]}`);
      } catch { /* contact may already exist */ }
    }
  }

  // Alert Jose on urgent or partnership emails
  if (parsed.isUrgent || parsed.category === 'partnership') {
    await sendEmail(OWNER_CONTACT_ID,
      `${parsed.isUrgent ? '🚨 Urgente' : '🤝 Partnership'} — ${headers.subject}`,
      `<p><strong>De:</strong> ${headers.from}</p><p><strong>Categoría:</strong> ${parsed.category}</p><p><strong>Resumen:</strong> ${parsed.summary}</p><p><strong>Armando respondió:</strong> ${parsed.shouldReply ? parsed.reply : 'Sin respuesta'}</p>`
    );
  }

  await markEmailRead(emailId);
}

async function runGmailCheck() {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return;
  try {
    console.log('[Gmail] Checking inbox...');
    const token   = await getGoogleAccessToken();
    const cutoff  = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const res     = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      params:  { q: `is:unread in:inbox after:${cutoff}`, maxResults: 20 },
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = res.data.messages || [];
    if (!messages.length) { console.log('[Gmail] No new emails'); return; }
    console.log(`[Gmail] ${messages.length} unread emails found`);
    for (const { id } of messages) {
      try { await processGmailEmail(id, token); } catch (err) { console.error(`[Gmail] Failed ${id}:`, err.message); }
      await new Promise(r => setTimeout(r, 1000));
    }
  } catch (err) { console.error('[Gmail] Check failed:', err?.response?.data || err.message); }
}

app.get('/cron/calendar-slots', async (_req, res) => {
  try {
    const slots = await getAvailableSlots(3);
    res.json({ total: slots.length, slots: slots.map((s, i) => ({ option: i + 1, time: formatSlot(s), iso: s.start.toISOString() })) });
  } catch (err) { res.status(500).json({ error: err?.response?.data || err.message }); }
});

app.post('/cron/gmail-check', async (_req, res) => {
  try { await runGmailCheck(); res.json({ status: 'ok' }); }
  catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// Dry-run: classify emails but don't reply or create contacts
app.post('/cron/gmail-preview', async (_req, res) => {
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    return res.status(400).json({ error: 'Google credentials not set' });
  }
  try {
    const token  = await getGoogleAccessToken();
    const cutoff = Math.floor((Date.now() - 48 * 60 * 60 * 1000) / 1000);
    const r      = await axios.get('https://gmail.googleapis.com/gmail/v1/users/me/messages', {
      params: { q: `is:unread in:inbox after:${cutoff}`, maxResults: 20 },
      headers: { Authorization: `Bearer ${token}` },
    });
    const messages = r.data.messages || [];
    const results  = [];
    for (const { id } of messages) {
      const detail  = await axios.get(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`, { headers: { Authorization: `Bearer ${token}` } });
      const headers = parseEmailHeaders(detail.data.payload?.headers);
      const body    = getEmailBody(detail.data.payload);
      if (!headers.from || headers.from.includes(GMAIL_ADDRESS) || !body.trim()) continue;
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 400,
        messages: [{ role: 'user', content: `Classify this email for JRZ Marketing. Return ONLY valid JSON:\n{"category":"lead|client|vendor|partnership|spam|other","language":"es|en","shouldReply":true,"proposedReply":"what Armando would say (max 100 words)","contactName":"","isUrgent":false,"summary":"one line"}\n\nFrom: ${headers.from}\nSubject: ${headers.subject}\nBody: ${body.slice(0, 1000)}` }],
      });
      const parsed = JSON.parse(msg.content[0].text.match(/\{[\s\S]*\}/)[0]);
      results.push({ from: headers.from, subject: headers.subject, ...parsed });
      await new Promise(r => setTimeout(r, 800));
    }
    res.json({ total: results.length, emails: results });
  } catch (err) {
    res.status(500).json({ error: err?.response?.data || err.message });
  }
});

// ── Bland.ai post-call webhook ────────────────────────────────────────────────
app.post('/webhook/bland', async (req, res) => {
  res.json({ ok: true }); // respond fast
  try {
    await parseBlandTranscript(req.body);
  } catch (err) {
    console.error('[Bland] Webhook error:', err.message);
  }
});

app.post('/cron/engagement-learning', async (_req, res) => {
  try {
    await runEngagementLearning();
    await updateWinningVoicePatterns();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/objection-learning', async (_req, res) => {
  try {
    await runObjectionLearning();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/self-update-rules', async (_req, res) => {
  try {
    await runSelfUpdateRules();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/client-checkins', async (_req, res) => {
  try {
    await runClientCheckIns();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/monthly-reports', async (_req, res) => {
  try {
    await sendMonthlyClientReports();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/subaccount-checkin', async (_req, res) => {
  try {
    await sendSubAccountCheckInEmails();
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/cron/proposal', async (req, res) => {
  try {
    const { contactId, contactName, businessType } = req.body;
    if (!contactId) return res.status(400).json({ status: 'error', message: 'contactId required' });
    await generateAndSendProposal(contactId, contactName || 'Cliente', businessType || 'negocio', '');
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ═══════════════════════════════════════════════════════════
// ELENA — CLIENT SUCCESS MANAGER → modules/agents/elena.js
// ═══════════════════════════════════════════════════════════
const {
  getElenaClients,
  elenaHealthCheck,
  elenaMonthlyReports,
  elenaMidMonthCheckIn,
  elenaQuarterlyReport,
} = require('./modules/agents/elena')({
  app,
  anthropic, axios, crypto, FormData,
  sendEmail, logActivity,
  GHL_API_KEY, GHL_LOCATION_ID,
  GHL_AGENCY_KEY, GHL_COMPANY_ID,
  OWNER_CONTACT_ID, BOOKING_URL,
  CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
});

// ═══════════════════════════════════════════════════════════
// DIEGO — PROJECT MANAGER → modules/agents/diego.js
// ═══════════════════════════════════════════════════════════
const {
  runDiegoWeeklyReport,
  runDiegoScorecard,
  runDiegoStandup,
} = require('./modules/agents/diego')({
  app,
  anthropic, axios, crypto, FormData,
  sendEmail, logActivity, setAgentBusy, setAgentIdle, agentChat,
  getElenaClients, saveCloudinaryJSON,
  GHL_API_KEY, GHL_LOCATION_ID,
  OWNER_CONTACT_ID,
  CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
  STALE_DAYS, OFFICE_KPI,
});

// ═══════════════════════════════════════════════════════════
// MARCO — CONTENT DIRECTOR → modules/agents/marco.js
// ═══════════════════════════════════════════════════════════
const {
  runMarcoContentBrief,
  runMarcoTrendAlert,
} = require('./modules/agents/marco')({
  app,
  anthropic, axios,
  sendEmail, logActivity, setAgentBusy, setAgentIdle, agentChat,
  getWeeklyStats, loadContentStrategy, saveCloudinaryJSON,
  OWNER_CONTACT_ID, NEWS_API_KEY, OFFICE_KPI,
});


// ═══════════════════════════════════════════════════════════
// SOFIA — WEB DESIGNER / AUDITOR → modules/agents/sofia.js
// ═══════════════════════════════════════════════════════════
const {
  checkWebsite,
  runSofiaWeeklyCheck,
  runSofiaWeeklySEOPlan,
  runSofiaContentLearning,
  runSofiaBacklinkAudit,
  runSofiaCitationAudit,
  runSofiaBacklinkProspector,
  runSofiaPressRelease,
  runSofiaCitationBuilder,
  runWeeklyRankTracking,
  runWeeklyBacklinkCheck,
  runBacklinkProspecting,
  runClientDailySeoBlog,
  runAllClientsDailyBlog,
} = require('./modules/agents/sofia')({
  anthropic, axios, crypto, FormData,
  sendEmail, logActivity, setAgentBusy, setAgentIdle, agentChat,
  getElenaClients, saveCloudinaryJSON,
  GHL_API_KEY, GHL_LOCATION_ID, GHL_AGENCY_KEY, GHL_COMPANY_ID,
  OWNER_CONTACT_ID, BOOKING_URL,
  CLOUDINARY_CLOUD, CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET,
  DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD, DATAFORSEO_BASE,
  GOOGLE_PLACES_API_KEY, GOOGLE_PLACES_BASE,
  APOLLO_API_KEY, NEWS_API_KEY,
  OFFICE_KPI, SEO_CLIENTS,
});

app.post('/sofia/website-check', async (_req, res) => {
  try {
    runSofiaWeeklyCheck();
    res.json({ status: 'ok', message: 'Sofia is checking all client websites' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// ─── Sofia: Google PageSpeed Insights ────────────────────

async function getPageSpeedData(url) {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) return null;
  const cleanUrl = url.startsWith('http') ? url : `https://${url}`;
  try {
    const [mobile, desktop] = await Promise.all([
      axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', {
        params: { url: cleanUrl, key, strategy: 'mobile', category: ['performance','seo','accessibility','best-practices'] },
        timeout: 30000,
      }),
      axios.get('https://www.googleapis.com/pagespeedonline/v5/runPagespeed', {
        params: { url: cleanUrl, key, strategy: 'desktop', category: ['performance','seo','accessibility','best-practices'] },
        timeout: 30000,
      }),
    ]);

    const extract = (data) => {
      const cats  = data.data?.lighthouseResult?.categories || {};
      const audits = data.data?.lighthouseResult?.audits || {};
      return {
        performance:    Math.round((cats.performance?.score || 0) * 100),
        seo:            Math.round((cats.seo?.score || 0) * 100),
        accessibility:  Math.round((cats.accessibility?.score || 0) * 100),
        bestPractices:  Math.round((cats['best-practices']?.score || 0) * 100),
        lcp:   audits['largest-contentful-paint']?.displayValue || null,
        cls:   audits['cumulative-layout-shift']?.displayValue || null,
        fid:   audits['total-blocking-time']?.displayValue || null,
        fcp:   audits['first-contentful-paint']?.displayValue || null,
        ttfb:  audits['server-response-time']?.displayValue || null,
        opportunities: Object.values(audits)
          .filter(a => a.details?.type === 'opportunity' && a.score !== null && a.score < 0.9)
          .map(a => a.title)
          .slice(0, 5),
      };
    };

    return { mobile: extract(mobile), desktop: extract(desktop) };
  } catch (err) {
    console.error('[Sofia] PageSpeed API error:', err.response?.data?.error?.message || err.message);
    return null;
  }
}

// ─── Sofia: Google Search Console API ────────────────────

let _googleAccessToken   = null;
let _googleAccessExpires = 0;

// Build a signed JWT for Google service account auth (no extra packages — uses built-in crypto)
function _buildServiceAccountJWT(scope = 'https://www.googleapis.com/auth/webmasters.readonly') {
  const email = process.env.GOOGLE_SA_EMAIL;
  const rawKey = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!email || !rawKey) return null;
  const privateKey = rawKey.replace(/\\n/g, '\n'); // Render stores \n as literal \\n
  const now = Math.floor(Date.now() / 1000);
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss:   email,
    scope,
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  })).toString('base64url');
  const sigInput = `${header}.${payload}`;
  const sign = crypto.createSign('RSA-SHA256');
  sign.update(sigInput);
  const sig = sign.sign(privateKey, 'base64url');
  return `${sigInput}.${sig}`;
}

// Get a valid Google access token for Search Console
// Priority: service account JWT (GOOGLE_SA_EMAIL + GOOGLE_SA_PRIVATE_KEY) → OAuth2 refresh token fallback
async function getGoogleAccessToken() {
  if (_googleAccessToken && Date.now() < _googleAccessExpires) return _googleAccessToken;
  try {
    const jwt = _buildServiceAccountJWT();
    if (jwt) {
      // Service account path — preferred, never expires, no user consent needed
      const res = await axios.post('https://oauth2.googleapis.com/token', null, {
        params: { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt },
        timeout: 10000,
      });
      _googleAccessToken   = res.data.access_token;
      _googleAccessExpires = Date.now() + (res.data.expires_in - 60) * 1000;
      return _googleAccessToken;
    }
    // Fallback: legacy OAuth2 refresh token
    const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = process.env;
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) return null;
    const res = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: { client_id: GOOGLE_CLIENT_ID, client_secret: GOOGLE_CLIENT_SECRET, refresh_token: GOOGLE_REFRESH_TOKEN, grant_type: 'refresh_token' },
      timeout: 10000,
    });
    _googleAccessToken   = res.data.access_token;
    _googleAccessExpires = Date.now() + (res.data.expires_in - 60) * 1000;
    return _googleAccessToken;
  } catch (err) {
    console.error('[Sofia] Google token error:', err.response?.data?.error || err.message);
    return null;
  }
}

async function getSearchConsoleData(siteUrl) {
  const token = await getGoogleAccessToken();
  if (!token) return null;

  const cleanUrl = siteUrl.startsWith('http') ? siteUrl : `https://${siteUrl}`;
  // Search Console accepts either https://domain.com/ or sc-domain:domain.com
  const encodedSite = encodeURIComponent(cleanUrl.replace(/\/$/, '') + '/');
  const today       = new Date();
  const endDate     = today.toISOString().split('T')[0];
  const startDate   = new Date(today - 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0]; // last 28 days

  try {
    const [keywordsRes, pagesRes] = await Promise.all([
      // Top 10 queries by clicks
      axios.post(
        `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
        { startDate, endDate, dimensions: ['query'], rowLimit: 10, orderBy: [{ fieldName: 'clicks', sortOrder: 'DESCENDING' }] },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      ),
      // Top 5 pages by impressions
      axios.post(
        `https://www.googleapis.com/webmasters/v3/sites/${encodedSite}/searchAnalytics/query`,
        { startDate, endDate, dimensions: ['page'], rowLimit: 5, orderBy: [{ fieldName: 'impressions', sortOrder: 'DESCENDING' }] },
        { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }
      ),
    ]);

    const rows      = keywordsRes.data?.rows || [];
    const pageRows  = pagesRes.data?.rows   || [];

    const totals = rows.reduce((acc, r) => ({
      clicks:      acc.clicks      + (r.clicks      || 0),
      impressions: acc.impressions + (r.impressions || 0),
    }), { clicks: 0, impressions: 0 });

    const avgPosition = rows.length
      ? (rows.reduce((s, r) => s + (r.position || 0), 0) / rows.length).toFixed(1)
      : null;
    const avgCtr = totals.impressions
      ? ((totals.clicks / totals.impressions) * 100).toFixed(2) + '%'
      : null;

    return {
      period:      `${startDate} → ${endDate}`,
      totalClicks: totals.clicks,
      totalImpressions: totals.impressions,
      avgPosition,
      avgCtr,
      topKeywords: rows.slice(0, 5).map(r => ({
        keyword:     r.keys[0],
        clicks:      r.clicks,
        impressions: r.impressions,
        ctr:         ((r.ctr || 0) * 100).toFixed(1) + '%',
        position:    (r.position || 0).toFixed(1),
      })),
      topPages: pageRows.map(r => ({
        page:        r.keys[0],
        impressions: r.impressions,
        clicks:      r.clicks,
        position:    (r.position || 0).toFixed(1),
      })),
    };
  } catch (err) {
    const status = err.response?.status;
    if (status === 403 || status === 404) {
      // Site not verified in Search Console — normal, not an error
      console.log(`[Sofia] Search Console: ${cleanUrl} not verified in GSC (${status})`);
    } else {
      console.error('[Sofia] Search Console error:', err.response?.data?.error?.message || err.message);
    }
    return null;
  }
}

// ─── Sofia: Full SEO + PageSpeed + Mobile + Copy Audit ───

async function runSofiaFullAudit(url, clientName, industry) {
  const base = await checkWebsite(url);
  if (!base) return null;

  // Fetch HTML, PageSpeed, and Search Console in parallel
  const [rawHtml, pageSpeed, searchConsole] = await Promise.all([
    base.up ? axios.get(url.startsWith('http') ? url : `https://${url}`, {
      timeout: 12000, headers: { 'User-Agent': 'Mozilla/5.0' }, validateStatus: () => true,
    }).then(r => typeof r.data === 'string' ? r.data : '').catch(() => '') : Promise.resolve(''),
    getPageSpeedData(url),
    getSearchConsoleData(url),
  ]);

  const html = rawHtml;

  // SEO checks
  const h1s      = (html.match(/<h1[^>]*>([^<]+)<\/h1>/gi) || []).map(h => h.replace(/<[^>]+>/g, '').trim());
  const h2s      = (html.match(/<h2[^>]*>([^<]+)<\/h2>/gi) || []).length;
  const imgs     = (html.match(/<img[^>]+>/gi) || []);
  const alts     = imgs.filter(i => /alt=["'][^"']+["']/i.test(i)).length;
  const hasCanon = /<link[^>]+rel=["']canonical["']/i.test(html);
  const hasView  = /<meta[^>]+name=["']viewport["']/i.test(html);
  const hasOG    = /<meta[^>]+property=["']og:/i.test(html);

  // Score 0-100 — PageSpeed performance replaces our manual response time if available
  let score = 0;
  if (base.up)   score += 20;
  if (base.ssl)  score += 10;
  // Speed: use PageSpeed mobile performance score if available, else fallback to response time
  if (pageSpeed) {
    const perf = pageSpeed.mobile.performance;
    if (perf >= 90) score += 15; else if (perf >= 70) score += 10; else if (perf >= 50) score += 5;
  } else {
    if (base.responseTime < 2000) score += 10; else if (base.responseTime < 4000) score += 5;
  }
  if (base.title)              score += 8;
  if (base.description)        score += 8;
  if (h1s.length === 1)        score += 8;
  if (h2s >= 2)                score += 5;
  if (imgs.length && alts === imgs.length) score += 5;
  if (hasCanon)                score += 5;
  if (hasView)                 score += 4;
  if (base.hasCTA)             score += 4;
  if (base.hasPhone)           score += 4;
  // Bonus from PageSpeed SEO score
  if (pageSpeed && pageSpeed.mobile.seo >= 90) score += 4;
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 50 ? 'C' : score >= 30 ? 'D' : 'F';

  // Claude: copy analysis + rewrites
  let copyAnalysis = null;
  if (base.up && (base.title || h1s.length)) {
    try {
      const psSummary = pageSpeed
        ? `Mobile Performance: ${pageSpeed.mobile.performance}/100, LCP: ${pageSpeed.mobile.lcp}, CLS: ${pageSpeed.mobile.cls}, SEO: ${pageSpeed.mobile.seo}/100`
        : 'PageSpeed: unavailable';
      const gscSummary = searchConsole
        ? `GSC (last 28 days): ${searchConsole.totalClicks} clicks, ${searchConsole.totalImpressions} impressions, avg position ${searchConsole.avgPosition}, CTR ${searchConsole.avgCtr}. Top keyword: "${searchConsole.topKeywords[0]?.keyword || 'none'}" (pos ${searchConsole.topKeywords[0]?.position || '?'})`
        : 'Google Search Console: not verified or no data';
      const aiRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: `You are Sofia, Web Designer at JRZ Marketing. Analyze this website for "${clientName}" (${industry}).

Title: ${base.title || 'missing'}
H1: ${h1s[0] || 'missing'}
Description: ${base.description || 'missing'}
Has CTA: ${base.hasCTA} | Has Phone: ${base.hasPhone}
${psSummary}
${pageSpeed?.mobile.opportunities?.length ? 'PageSpeed issues: ' + pageSpeed.mobile.opportunities.join(', ') : ''}
${gscSummary}

Reply ONLY with JSON: {"headlineRewrite":"improved H1","ctaRewrite":"better CTA for their industry","descriptionRewrite":"improved meta description (max 155 chars)","topIssue":"single most important problem in one sentence"}` }],
      });
      copyAnalysis = JSON.parse(aiRes.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);
    } catch { /* skip */ }
  }

  return { ...base, h1s, h2Count: h2s, imgCount: imgs.length, altCount: alts, hasCanon, hasViewport: hasView, hasOG, score, grade, pageSpeed, searchConsole, copyAnalysis };
}

// ─── Sofia: Monthly CRO Report ────────────────────────────

async function runSofiaCROReport() {
  console.log('[Sofia] Building monthly CRO report...');
  const logoUrl  = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';
  const month    = new Date().toLocaleString('es-ES', { month: 'long', year: 'numeric' });
  const clients  = await getElenaClients();
  const results  = [];

  for (const client of clients) {
    try {
      const locRes = await axios.get(`https://services.leadconnectorhq.com/locations/${client.locationId}`, {
        headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28' }, timeout: 8000,
      });
      const loc = locRes.data?.location || locRes.data;
      const url = loc?.website || loc?.business?.website;
      if (!url) { results.push({ name: client.name, url: null, score: null, grade: 'N/A', noSite: true }); continue; }

      const audit = await runSofiaFullAudit(url, client.name, client.industry);
      if (audit) results.push({ name: client.name, url, ...audit });
      await new Promise(r => setTimeout(r, 1200));
    } catch (err) {
      console.error(`[Sofia CRO] Error for ${client.name}:`, err.message);
    }
  }

  const graded  = results.filter(r => r.grade && r.grade !== 'N/A');
  const noSite  = results.filter(r => r.noSite);
  const avgScore = graded.length ? Math.round(graded.reduce((s, r) => s + r.score, 0) / graded.length) : 0;

  const gradeColor = { A: '#16a34a', B: '#4ade80', C: '#d97706', D: '#f97316', F: '#dc2626', 'N/A': '#bbb' };
  const gradeBg    = { A: '#f0fdf4', B: '#f0fdf4', C: '#fff8f0', D: '#fff4ee', F: '#fef2f2', 'N/A': '#f9f9f9' };

  const rows = results.sort((a, b) => (a.score || 0) - (b.score || 0)).map(r => {
    if (r.noSite) return `<tr style="border-bottom:1px solid #f9f9f9;"><td style="padding:10px 14px;font-size:13px;color:#0a0a0a;">${r.name}</td><td colspan="7" style="padding:10px 14px;font-size:12px;color:#bbb;">No website on file</td></tr>`;
    const copy = r.copyAnalysis;
    const ps   = r.pageSpeed?.mobile;
    const perfColor = ps ? (ps.performance >= 90 ? '#16a34a' : ps.performance >= 70 ? '#d97706' : '#dc2626') : '#bbb';
    const seoColor  = ps ? (ps.seo >= 90 ? '#16a34a' : ps.seo >= 70 ? '#d97706' : '#dc2626') : '#bbb';
    return `<tr style="border-bottom:1px solid #f5f5f5;">
      <td style="padding:11px 14px;font-size:13px;font-weight:600;color:#0a0a0a;">${r.name}</td>
      <td style="padding:11px 14px;text-align:center;"><span style="background:${gradeBg[r.grade]};color:${gradeColor[r.grade]};font-weight:800;font-size:14px;padding:2px 10px;border-radius:8px;">${r.grade}</span></td>
      <td style="padding:11px 14px;text-align:center;font-size:13px;color:#555;">${r.score}/100</td>
      <td style="padding:11px 14px;text-align:center;font-size:13px;font-weight:700;color:${perfColor};">${ps ? ps.performance : '—'}</td>
      <td style="padding:11px 14px;text-align:center;font-size:12px;color:#666;">${ps ? `LCP ${ps.lcp || '?'} · CLS ${ps.cls || '?'}` : '—'}</td>
      <td style="padding:11px 14px;text-align:center;font-size:13px;font-weight:700;color:${seoColor};">${ps ? ps.seo : '—'}</td>
      <td style="padding:11px 14px;font-size:12px;color:#555;font-style:italic;">${copy?.topIssue || ps?.opportunities?.[0] || '—'}</td>
    </tr>`;
  }).join('');

  const html = `<!DOCTYPE html>
<html lang="es"><head>
  <meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap');
    * { margin:0; padding:0; box-sizing:border-box; }
    body { font-family:'Inter',sans-serif; background:#f4f4f4; }
    .wrap { padding:40px 20px; }
    .card { max-width:760px; margin:0 auto; background:#fff; border-radius:16px; overflow:hidden; box-shadow:0 4px 24px rgba(0,0,0,0.08); }
    .hdr { background:#0a0a0a; padding:26px 36px; display:flex; align-items:center; justify-content:space-between; }
    .hdr img { height:36px; } .hdr span { background:rgba(255,255,255,0.08); border:1px solid rgba(255,255,255,0.12); color:rgba(255,255,255,0.45); font-size:10px; font-weight:700; letter-spacing:0.12em; text-transform:uppercase; padding:5px 12px; border-radius:100px; }
    .hero { background:#0a0a0a; padding:28px 36px 36px; border-bottom:3px solid #fff; }
    .hero h1 { font-size:22px; font-weight:800; color:#fff; margin-bottom:6px; }
    .hero p { font-size:12px; color:rgba(255,255,255,0.35); text-transform:uppercase; letter-spacing:0.08em; }
    .stats { display:flex; border-bottom:1px solid #f0f0f0; }
    .stat { flex:1; padding:16px 12px; text-align:center; border-right:1px solid #f0f0f0; } .stat:last-child { border-right:none; }
    .stat-num { font-size:26px; font-weight:800; color:#0a0a0a; } .stat-lbl { font-size:10px; font-weight:700; color:#bbb; text-transform:uppercase; letter-spacing:0.06em; margin-top:3px; }
    .body { padding:28px 36px 36px; }
    .sec-title { font-size:11px; font-weight:700; letter-spacing:0.1em; text-transform:uppercase; color:#999; margin-bottom:14px; }
    table { width:100%; border-collapse:collapse; }
    .ftr { background:#0a0a0a; padding:22px 36px; display:flex; align-items:center; justify-content:space-between; }
    .ftr img { height:22px; opacity:0.45; } .ftr p { font-size:11px; color:rgba(255,255,255,0.25); }
  </style>
</head>
<body><div class="wrap"><div class="card">
  <div class="hdr"><img src="${logoUrl}"/><span>Sofia · CRO Report ${month}</span></div>
  <div class="hero"><h1>Reporte CRO Mensual</h1><p>Conversión · SEO · Copy · Mobile — ${month}</p></div>
  <div class="stats">
    <div class="stat"><div class="stat-num">${graded.length}</div><div class="stat-lbl">Sitios Auditados</div></div>
    <div class="stat"><div class="stat-num">${avgScore}</div><div class="stat-lbl">Score Promedio</div></div>
    <div class="stat"><div class="stat-num" style="color:#16a34a;">${graded.filter(r=>r.grade==='A'||r.grade==='B').length}</div><div class="stat-lbl">A / B Grade</div></div>
    <div class="stat"><div class="stat-num" style="color:#dc2626;">${graded.filter(r=>r.grade==='D'||r.grade==='F').length}</div><div class="stat-lbl">D / F Urgente</div></div>
    <div class="stat"><div class="stat-num">${noSite.length}</div><div class="stat-lbl">Sin Sitio</div></div>
  </div>
  <div class="body">
    <p class="sec-title">Todos los clientes — ordenados por score (peor → mejor)</p>
    <table>
      <thead><tr style="background:#f9f9f9;">
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#999;text-transform:uppercase;">Client</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#999;text-transform:uppercase;">Grade</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#999;text-transform:uppercase;">Score</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#999;text-transform:uppercase;">⚡ Perf</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#999;text-transform:uppercase;">Core Web Vitals</th>
        <th style="padding:10px 14px;text-align:center;font-size:11px;color:#999;text-transform:uppercase;">🔍 SEO</th>
        <th style="padding:10px 14px;text-align:left;font-size:11px;color:#999;text-transform:uppercase;">Top Issue</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  </div>
  <div class="ftr"><img src="${logoUrl}"/><p>Sofia — JRZ Marketing AI Web Designer</p></div>
</div></div></body></html>`;

  await sendEmail(OWNER_CONTACT_ID, `🏆 Sofia: CRO Report ${month} — Score Promedio: ${avgScore}/100`, html);
  console.log(`[Sofia] ✅ CRO report sent. Avg score: ${avgScore}. D/F sites: ${graded.filter(r=>r.grade==='D'||r.grade==='F').length}`);
}

// ─── Sofia: GHL Landing Page Creator ─────────────────────

// ─── Sofia: AI Content Generator for Landing Pages ───────
async function generateLandingContent(clientName, industry, city) {
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Create professional landing page content for "${clientName}", a ${industry} company in ${city}, FL.
Return ONLY valid JSON — no markdown, no explanation:
{
  "heroTitle": "Powerful 6-8 word headline",
  "heroSubtitle": "One compelling sentence value proposition",
  "ctaText": "Action-oriented CTA button text",
  "tagline": "Short company tagline under 8 words",
  "aboutText": "2-3 sentences describing the company's mission, experience, and commitment to ${city} community.",
  "stats": [{"num":"500+","label":"Jobs Completed"},{"num":"15+","label":"Years Experience"},{"num":"98%","label":"Satisfaction Rate"}],
  "services": [
    {"name":"Primary Service Name","desc":"2 sentences describing this service and its benefits.","icon":"🔧"},
    {"name":"Secondary Service Name","desc":"2 sentences describing this service and its benefits.","icon":"⚡"},
    {"name":"Third Service Name","desc":"2 sentences describing this service and its benefits.","icon":"🏆"}
  ],
  "trustItems": ["Licensed & Certified","Fully Insured","24/7 Available","Free Estimates","5-Star Rated"],
  "whyCards": [
    {"title":"Why Reason 1","desc":"Short 1-sentence explanation."},
    {"title":"Why Reason 2","desc":"Short 1-sentence explanation."},
    {"title":"Why Reason 3","desc":"Short 1-sentence explanation."},
    {"title":"Why Reason 4","desc":"Short 1-sentence explanation."}
  ],
  "processSteps": [
    {"num":"01","title":"Step One","desc":"Short description of this step."},
    {"num":"02","title":"Step Two","desc":"Short description of this step."},
    {"num":"03","title":"Step Three","desc":"Short description of this step."},
    {"num":"04","title":"Step Four","desc":"Short description of this step."}
  ],
  "reviews": [
    {"name":"Maria G.","stars":5,"text":"Two sentences of glowing review about this ${industry} company."},
    {"name":"John D.","stars":5,"text":"Two sentences of glowing review about this ${industry} company."},
    {"name":"Ana R.","stars":5,"text":"Two sentences of glowing review about this ${industry} company."}
  ],
  "faqs": [
    {"q":"Common question about ${industry}?","a":"Clear helpful answer."},
    {"q":"Another common question?","a":"Clear helpful answer."},
    {"q":"Pricing or timeline question?","a":"Clear helpful answer."},
    {"q":"Service area or availability question?","a":"Clear helpful answer."}
  ],
  "areas": ["${city}","Orlando","Kissimmee","Sanford","Daytona Beach","Deltona","Lake Mary","Ocoee"]
}`
      }]
    });
    const raw = msg.content[0].text;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON found in Claude response');
    return JSON.parse(match[0]);
  } catch (err) {
    console.error('[Sofia] Content generation error:', err.message);
    // Fallback defaults
    return {
      heroTitle: `${clientName} — Trusted ${industry} Experts`,
      heroSubtitle: `Professional ${industry} services in ${city} and surrounding areas.`,
      ctaText: 'Get Free Estimate',
      tagline: `${city}'s Most Trusted ${industry}`,
      aboutText: `${clientName} has been serving ${city} and the surrounding communities with top-quality ${industry} services. Our experienced team is committed to delivering exceptional results with every project.`,
      stats: [{ num: '500+', label: 'Projects Done' }, { num: '10+', label: 'Years Experience' }, { num: '5★', label: 'Google Rating' }],
      services: [
        { name: 'Premium Service', desc: 'We deliver industry-leading quality with every job. Your satisfaction is our top priority.', icon: '🔧' },
        { name: 'Expert Team', desc: 'Our certified professionals bring years of experience. We handle every detail with care.', icon: '⚡' },
        { name: 'Fast Response', desc: 'We respond quickly and work efficiently. Get the help you need when you need it.', icon: '🏆' },
      ],
      trustItems: ['Licensed & Certified', 'Fully Insured', '24/7 Available', 'Free Estimates', '5-Star Rated'],
      whyCards: [
        { title: 'Local Experts', desc: 'Proudly serving the ' + city + ' area for over a decade.' },
        { title: 'Transparent Pricing', desc: 'No hidden fees — honest quotes upfront.' },
        { title: 'Guaranteed Work', desc: 'We stand behind every job we do.' },
        { title: '24/7 Support', desc: 'Always available when you need us most.' },
      ],
      processSteps: [
        { num: '01', title: 'Contact Us', desc: 'Call or fill out our form — we respond fast.' },
        { num: '02', title: 'Free Assessment', desc: 'We evaluate your needs at no cost.' },
        { num: '03', title: 'We Get to Work', desc: 'Our team handles everything professionally.' },
        { num: '04', title: 'You Enjoy Results', desc: '100% satisfaction, guaranteed.' },
      ],
      reviews: [
        { name: 'Maria G.', stars: 5, text: 'Incredible service from start to finish. Highly recommend!' },
        { name: 'John D.', stars: 5, text: 'Fast, professional, and affordable. These guys are the best.' },
        { name: 'Ana R.', stars: 5, text: 'I called them in an emergency and they were there within the hour. Amazing team.' },
      ],
      faqs: [
        { q: 'Do you offer free estimates?', a: 'Yes! We offer free no-obligation estimates for all services.' },
        { q: 'How quickly can you respond?', a: 'We typically respond within 1-2 hours and can schedule same-day service.' },
        { q: 'Are you licensed and insured?', a: 'Absolutely. We are fully licensed and carry comprehensive insurance.' },
        { q: 'What areas do you serve?', a: `We serve ${city} and surrounding Central Florida communities.` },
      ],
      areas: [city, 'Orlando', 'Kissimmee', 'Sanford', 'Daytona Beach', 'Deltona', 'Lake Mary', 'Ocoee'],
    };
  }
}

async function buildLandingHTML(clientName, phone, email, city, industry, logoUrl, formId) {
  city   = city   || 'Orlando';
  formId = formId || '5XhL0vWCuJ59HWHQoHGG';
  const c = await generateLandingContent(clientName, industry, city);
  const stars = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  const phoneClean = (phone || '').replace(/\D/g, '');
  const logoSrc = logoUrl || 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<meta name="description" content="${c.heroSubtitle}"/>
<title>${clientName} | ${industry} in ${city}, FL</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Montserrat:wght@400;600;700;800;900&family=Open+Sans:wght@400;500;600&display=swap" rel="stylesheet"/>
<style>
:root{--blue-dark:#1a3a6b;--blue-mid:#2563a8;--blue-light:#3b82f6;--orange:#f97316;--gray-bg:#f8fafc;--gray-dark:#1e293b;--text:#374151;--white:#ffffff;}
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:'Open Sans',sans-serif;color:var(--text);background:#fff;}
/* TOPBAR */
.topbar{background:var(--blue-dark);padding:9px 24px;display:flex;align-items:center;justify-content:space-between;}
.topbar-left{font-size:12px;color:rgba(255,255,255,0.75);letter-spacing:0.02em;}
.topbar-right a{display:inline-flex;align-items:center;gap:6px;background:var(--orange);color:#fff;font-size:12px;font-weight:700;padding:6px 16px;border-radius:20px;text-decoration:none;letter-spacing:0.03em;}
/* NAVBAR */
.navbar{background:#fff;border-bottom:1px solid #e5e7eb;padding:0 24px;position:sticky;top:0;z-index:100;box-shadow:0 2px 8px rgba(0,0,0,0.06);}
.nav-inner{max-width:1200px;margin:0 auto;display:flex;align-items:center;justify-content:space-between;height:70px;}
.nav-logo{display:flex;align-items:center;gap:10px;}
.nav-logo img{height:40px;object-fit:contain;}
.nav-logo span{font-family:'Montserrat',sans-serif;font-size:18px;font-weight:800;color:var(--blue-dark);}
.nav-links{display:flex;gap:28px;}
.nav-links a{font-size:13px;font-weight:600;color:var(--gray-dark);text-decoration:none;transition:color .2s;}
.nav-links a:hover{color:var(--blue-mid);}
.nav-cta a{background:var(--blue-dark);color:#fff;font-size:13px;font-weight:700;padding:10px 22px;border-radius:6px;text-decoration:none;white-space:nowrap;}
/* HERO */
.hero{background:linear-gradient(135deg,var(--blue-dark) 0%,var(--blue-mid) 60%,#1d4ed8 100%);min-height:580px;display:flex;align-items:center;padding:60px 24px;}
.hero-inner{max-width:1200px;margin:0 auto;display:grid;grid-template-columns:1fr 420px;gap:60px;align-items:center;}
.hero-left{}
.hero-eyebrow{display:inline-block;background:rgba(249,115,22,0.15);border:1px solid rgba(249,115,22,0.4);color:var(--orange);font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:5px 14px;border-radius:20px;margin-bottom:20px;}
.hero h1{font-family:'Montserrat',sans-serif;font-size:46px;font-weight:900;color:#fff;line-height:1.1;margin-bottom:16px;}
.hero-sub{font-size:17px;color:rgba(255,255,255,0.8);line-height:1.6;margin-bottom:28px;max-width:480px;}
.hero-badges{display:flex;flex-wrap:wrap;gap:10px;margin-bottom:32px;}
.hero-badge{display:flex;align-items:center;gap:6px;background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.2);color:rgba(255,255,255,0.9);font-size:12px;font-weight:600;padding:6px 14px;border-radius:20px;}
.hero-phone a{display:inline-flex;align-items:center;gap:8px;background:rgba(255,255,255,0.15);border:2px solid rgba(255,255,255,0.3);color:#fff;font-size:20px;font-weight:800;padding:14px 28px;border-radius:8px;text-decoration:none;font-family:'Montserrat',sans-serif;}
/* FORM CARD */
.form-card{background:#fff;border-radius:16px;padding:32px 28px;box-shadow:0 24px 60px rgba(0,0,0,0.25);}
.form-card h3{font-family:'Montserrat',sans-serif;font-size:20px;font-weight:800;color:var(--blue-dark);margin-bottom:6px;}
.form-card p{font-size:13px;color:#6b7280;margin-bottom:20px;}
.form-card iframe{width:100%;border:none;min-height:480px;border-radius:8px;}
/* TRUST STRIP */
.trust-strip{background:var(--blue-dark);padding:16px 24px;}
.trust-inner{max-width:1200px;margin:0 auto;display:flex;justify-content:center;flex-wrap:wrap;gap:24px;}
.trust-item{display:flex;align-items:center;gap:8px;color:#fff;font-size:13px;font-weight:600;}
.trust-icon{width:28px;height:28px;background:var(--orange);border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;flex-shrink:0;}
/* SECTIONS */
.section{padding:80px 24px;}
.section-inner{max-width:1200px;margin:0 auto;}
.section-label{font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--orange);margin-bottom:10px;}
.section-title{font-family:'Montserrat',sans-serif;font-size:36px;font-weight:800;color:var(--blue-dark);line-height:1.2;margin-bottom:16px;}
.section-sub{font-size:16px;color:#6b7280;max-width:600px;line-height:1.6;}
/* ABOUT */
.about-grid{display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;}
.about-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:24px;margin-top:36px;}
.stat-box{text-align:center;padding:24px 16px;background:var(--gray-bg);border-radius:12px;border-top:3px solid var(--orange);}
.stat-num{font-family:'Montserrat',sans-serif;font-size:36px;font-weight:900;color:var(--blue-dark);}
.stat-label{font-size:13px;color:#6b7280;margin-top:4px;}
.about-img{background:linear-gradient(135deg,var(--blue-dark),var(--blue-mid));border-radius:16px;min-height:360px;display:flex;align-items:center;justify-content:center;}
.about-img-inner{text-align:center;padding:40px;}
.about-img-inner .big-icon{font-size:80px;margin-bottom:16px;display:block;}
.about-img-inner p{color:rgba(255,255,255,0.8);font-size:15px;line-height:1.6;}
/* SERVICES */
.section-bg{background:var(--gray-bg);}
.services-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:48px;}
.srv-card{background:#fff;border-radius:14px;padding:32px 28px;box-shadow:0 4px 20px rgba(0,0,0,0.06);border-top:4px solid var(--blue-mid);transition:transform .2s,box-shadow .2s;}
.srv-card:hover{transform:translateY(-4px);box-shadow:0 12px 32px rgba(0,0,0,0.1);}
.srv-icon{width:52px;height:52px;background:linear-gradient(135deg,var(--blue-dark),var(--blue-mid));border-radius:12px;display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:20px;}
.srv-card h3{font-family:'Montserrat',sans-serif;font-size:18px;font-weight:700;color:var(--blue-dark);margin-bottom:10px;}
.srv-card p{font-size:14px;color:#6b7280;line-height:1.6;}
/* WHY */
.section-dark{background:var(--gray-dark);padding:80px 24px;}
.why-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:24px;margin-top:48px;}
.why-card{background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:14px;padding:28px 24px;}
.why-icon{font-size:28px;margin-bottom:14px;}
.why-card h3{font-family:'Montserrat',sans-serif;font-size:16px;font-weight:700;color:#fff;margin-bottom:8px;}
.why-card p{font-size:13px;color:rgba(255,255,255,0.6);line-height:1.5;}
/* PROCESS */
.process-steps{display:grid;grid-template-columns:repeat(4,1fr);gap:32px;margin-top:48px;position:relative;}
.process-steps::before{content:'';position:absolute;top:36px;left:calc(12.5% + 12px);right:calc(12.5% + 12px);height:2px;background:linear-gradient(90deg,var(--blue-mid),var(--orange));z-index:0;}
.step{text-align:center;position:relative;z-index:1;}
.step-num{width:72px;height:72px;background:linear-gradient(135deg,var(--blue-dark),var(--blue-mid));border-radius:50%;display:flex;align-items:center;justify-content:center;font-family:'Montserrat',sans-serif;font-size:22px;font-weight:900;color:#fff;margin:0 auto 20px;border:4px solid #fff;box-shadow:0 4px 16px rgba(37,99,168,0.3);}
.step h3{font-family:'Montserrat',sans-serif;font-size:15px;font-weight:700;color:var(--blue-dark);margin-bottom:8px;}
.step p{font-size:13px;color:#6b7280;line-height:1.5;}
/* REVIEWS */
.reviews-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:28px;margin-top:48px;}
.review-card{background:#fff;border-radius:14px;padding:28px 24px;box-shadow:0 4px 20px rgba(0,0,0,0.07);border-left:4px solid var(--orange);}
.review-stars{color:var(--orange);font-size:18px;margin-bottom:12px;}
.review-text{font-size:14px;color:#374151;line-height:1.7;font-style:italic;margin-bottom:16px;}
.review-author{font-size:13px;font-weight:700;color:var(--blue-dark);}
/* FAQ */
.faq-list{margin-top:48px;max-width:800px;}
.faq-item{border-bottom:1px solid #e5e7eb;padding:20px 0;}
.faq-q{font-family:'Montserrat',sans-serif;font-size:16px;font-weight:700;color:var(--blue-dark);cursor:pointer;display:flex;justify-content:space-between;align-items:center;}
.faq-q::after{content:'+';font-size:22px;color:var(--orange);transition:transform .2s;}
.faq-item.open .faq-q::after{content:'−';}
.faq-a{font-size:14px;color:#6b7280;line-height:1.7;padding-top:12px;display:none;}
.faq-item.open .faq-a{display:block;}
/* AREAS */
.areas-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px;margin-top:40px;}
.area-item{background:var(--gray-bg);border:1px solid #e5e7eb;border-radius:10px;padding:14px 18px;font-size:14px;font-weight:600;color:var(--blue-dark);display:flex;align-items:center;gap:8px;}
.area-item::before{content:'📍';font-size:12px;}
/* CTA BANNER */
.cta-banner{background:linear-gradient(135deg,var(--orange) 0%,#ea580c 100%);padding:64px 24px;text-align:center;}
.cta-banner h2{font-family:'Montserrat',sans-serif;font-size:36px;font-weight:900;color:#fff;margin-bottom:12px;}
.cta-banner p{font-size:16px;color:rgba(255,255,255,0.85);margin-bottom:32px;}
.cta-banner a{display:inline-block;background:#fff;color:var(--orange);font-size:16px;font-weight:800;padding:16px 40px;border-radius:8px;text-decoration:none;font-family:'Montserrat',sans-serif;}
/* FOOTER */
footer{background:var(--gray-dark);padding:48px 24px 24px;}
.footer-inner{max-width:1200px;margin:0 auto;}
.footer-top{display:grid;grid-template-columns:2fr 1fr 1fr;gap:48px;margin-bottom:40px;}
.footer-brand img{height:36px;margin-bottom:12px;filter:brightness(0) invert(1);}
.footer-brand p{font-size:13px;color:rgba(255,255,255,0.5);line-height:1.6;margin-top:8px;}
.footer-col h4{font-family:'Montserrat',sans-serif;font-size:14px;font-weight:700;color:#fff;margin-bottom:16px;}
.footer-col a{display:block;font-size:13px;color:rgba(255,255,255,0.5);text-decoration:none;margin-bottom:8px;}
.footer-bottom{border-top:1px solid rgba(255,255,255,0.08);padding-top:20px;display:flex;justify-content:space-between;align-items:center;}
.footer-bottom p{font-size:12px;color:rgba(255,255,255,0.3);}
/* MOBILE CALL BAR */
.mobile-bar{display:none;position:fixed;bottom:0;left:0;right:0;z-index:200;background:var(--orange);}
.mobile-bar a{display:flex;align-items:center;justify-content:center;gap:10px;color:#fff;font-size:16px;font-weight:800;padding:16px;text-decoration:none;font-family:'Montserrat',sans-serif;}
@media(max-width:900px){
  .hero-inner{grid-template-columns:1fr;}
  .about-grid,.footer-top{grid-template-columns:1fr;}
  .services-grid,.why-grid,.reviews-grid,.areas-grid{grid-template-columns:1fr 1fr;}
  .process-steps{grid-template-columns:1fr 1fr;}
  .process-steps::before{display:none;}
  .hero h1{font-size:32px;}
  .section-title{font-size:28px;}
}
@media(max-width:600px){
  .services-grid,.why-grid,.reviews-grid,.areas-grid,.process-steps{grid-template-columns:1fr;}
  .nav-links{display:none;}
  .mobile-bar{display:block;}
  body{padding-bottom:60px;}
  .topbar{display:none;}
  .about-stats{grid-template-columns:1fr 1fr;}
}
</style>
</head>
<body>

<!-- TOPBAR -->
<div class="topbar">
  <span class="topbar-left">Serving ${city} & Central Florida · ${phone || 'Call for Free Estimate'}</span>
  <div class="topbar-right"><a href="#contact">${c.ctaText} →</a></div>
</div>

<!-- NAVBAR -->
<nav class="navbar">
  <div class="nav-inner">
    <div class="nav-logo">
      <img src="${logoSrc}" alt="${clientName}"/>
    </div>
    <div class="nav-links">
      <a href="#services">Services</a>
      <a href="#about">About</a>
      <a href="#reviews">Reviews</a>
      <a href="#faq">FAQ</a>
      <a href="#areas">Areas</a>
    </div>
    <div class="nav-cta"><a href="#contact">${phone || c.ctaText}</a></div>
  </div>
</nav>

<!-- HERO -->
<section class="hero" id="home">
  <div class="hero-inner">
    <div class="hero-left">
      <div class="hero-eyebrow">#1 ${industry} in ${city}, FL</div>
      <h1>${c.heroTitle}</h1>
      <p class="hero-sub">${c.heroSubtitle}</p>
      <div class="hero-badges">
        ${c.trustItems.map(t => `<div class="hero-badge">✓ ${t}</div>`).join('\n        ')}
      </div>
      ${phone ? `<div class="hero-phone"><a href="tel:${phoneClean}">📞 ${phone}</a></div>` : ''}
    </div>
    <div class="form-card" id="contact">
      <h3>Get Your Free Estimate</h3>
      <p>No obligation · Fast response · Serving ${city}</p>
      <iframe src="https://link.msgsndr.com/widget/form/${formId}" title="Contact Form" loading="lazy"></iframe>
    </div>
  </div>
</section>

<!-- TRUST STRIP -->
<div class="trust-strip">
  <div class="trust-inner">
    ${c.trustItems.map((t, i) => `<div class="trust-item"><div class="trust-icon">${['✓','★','⚡','🛡','📞'][i] || '✓'}</div><span>${t}</span></div>`).join('\n    ')}
  </div>
</div>

<!-- ABOUT -->
<section class="section" id="about">
  <div class="section-inner">
    <div class="about-grid">
      <div>
        <div class="section-label">About Us</div>
        <h2 class="section-title">${c.tagline}</h2>
        <p class="section-sub">${c.aboutText}</p>
        <div class="about-stats">
          ${c.stats.map(s => `<div class="stat-box"><div class="stat-num">${s.num}</div><div class="stat-label">${s.label}</div></div>`).join('\n          ')}
        </div>
      </div>
      <div class="about-img">
        <div class="about-img-inner">
          <span class="big-icon">🏆</span>
          <p>Trusted by hundreds of ${city} families and businesses</p>
        </div>
      </div>
    </div>
  </div>
</section>

<!-- SERVICES -->
<section class="section section-bg" id="services">
  <div class="section-inner">
    <div class="section-label">Our Services</div>
    <h2 class="section-title">What We Do Best</h2>
    <div class="services-grid">
      ${c.services.map(s => `
      <div class="srv-card">
        <div class="srv-icon">${s.icon}</div>
        <h3>${s.name}</h3>
        <p>${s.desc}</p>
      </div>`).join('')}
    </div>
  </div>
</section>

<!-- WHY CHOOSE US -->
<section class="section-dark">
  <div class="section-inner">
    <div class="section-label" style="color:var(--orange);">Why Choose Us</div>
    <h2 class="section-title" style="color:#fff;">The ${clientName} Difference</h2>
    <div class="why-grid">
      ${c.whyCards.map((w, i) => `
      <div class="why-card">
        <div class="why-icon">${['🎯','💰','🛡️','📞'][i] || '⭐'}</div>
        <h3>${w.title}</h3>
        <p>${w.desc}</p>
      </div>`).join('')}
    </div>
  </div>
</section>

<!-- PROCESS -->
<section class="section" id="process">
  <div class="section-inner">
    <div style="text-align:center;margin-bottom:0;">
      <div class="section-label" style="text-align:center;">How It Works</div>
      <h2 class="section-title" style="text-align:center;">Simple Process, Exceptional Results</h2>
    </div>
    <div class="process-steps">
      ${c.processSteps.map(s => `
      <div class="step">
        <div class="step-num">${s.num}</div>
        <h3>${s.title}</h3>
        <p>${s.desc}</p>
      </div>`).join('')}
    </div>
  </div>
</section>

<!-- REVIEWS -->
<section class="section section-bg" id="reviews">
  <div class="section-inner">
    <div class="section-label">Client Reviews</div>
    <h2 class="section-title">What Our Clients Say</h2>
    <div class="reviews-grid">
      ${c.reviews.map(r => `
      <div class="review-card">
        <div class="review-stars">${stars(r.stars)}</div>
        <p class="review-text">"${r.text}"</p>
        <div class="review-author">— ${r.name}</div>
      </div>`).join('')}
    </div>
  </div>
</section>

<!-- FAQ -->
<section class="section" id="faq">
  <div class="section-inner">
    <div class="section-label">FAQ</div>
    <h2 class="section-title">Frequently Asked Questions</h2>
    <div class="faq-list">
      ${c.faqs.map((f, i) => `
      <div class="faq-item${i === 0 ? ' open' : ''}">
        <div class="faq-q" onclick="toggleFaq(this.parentElement)">${f.q}</div>
        <div class="faq-a">${f.a}</div>
      </div>`).join('')}
    </div>
  </div>
</section>

<!-- SERVICE AREAS -->
<section class="section section-bg" id="areas">
  <div class="section-inner">
    <div class="section-label">Service Areas</div>
    <h2 class="section-title">Proudly Serving Central Florida</h2>
    <div class="areas-grid">
      ${c.areas.map(a => `<div class="area-item">${a}</div>`).join('\n      ')}
    </div>
  </div>
</section>

<!-- CTA BANNER -->
<section class="cta-banner">
  <h2>Ready to Get Started?</h2>
  <p>Contact ${clientName} today — free estimates, fast response, guaranteed results.</p>
  <a href="#contact">${c.ctaText} →</a>
</section>

<!-- FOOTER -->
<footer>
  <div class="footer-inner">
    <div class="footer-top">
      <div class="footer-brand">
        <img src="${logoSrc}" alt="${clientName}"/>
        <p>${c.tagline}<br/>Serving ${city} and Central Florida.</p>
      </div>
      <div class="footer-col">
        <h4>Services</h4>
        ${c.services.map(s => `<a href="#services">${s.name}</a>`).join('\n        ')}
      </div>
      <div class="footer-col">
        <h4>Contact</h4>
        ${phone ? `<a href="tel:${phoneClean}">${phone}</a>` : ''}
        ${email ? `<a href="mailto:${email}">${email}</a>` : ''}
        <a href="#contact">Get Free Estimate</a>
      </div>
    </div>
    <div class="footer-bottom">
      <p>© 2026 ${clientName}. All rights reserved.</p>
      <p>Powered by <strong>JRZ Marketing</strong> · jrzmarketing.com</p>
    </div>
  </div>
</footer>

<!-- STICKY MOBILE CALL BAR -->
${phone ? `<div class="mobile-bar"><a href="tel:${phoneClean}">📞 Call Now — ${phone}</a></div>` : ''}

<script src="https://link.msgsndr.com/js/form_embed.js"></script>
<script>
function toggleFaq(el){el.classList.toggle('open');}
</script>
</body>
</html>`;
}

async function createGHLLandingPage(locationId, clientName, industry, phone = '', email = '', city = 'Orlando', logoUrl = '', formId = '5XhL0vWCuJ59HWHQoHGG') {
  const headers = { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  console.log(`[Sofia] Generating professional landing page for ${clientName} (${industry}, ${city})...`);
  const pageHTML = await buildLandingHTML(clientName, phone, email, city, industry, logoUrl, formId);

  // Create funnel in the subaccount
  const funnelRes = await axios.post('https://services.leadconnectorhq.com/funnels/', {
    name: `${clientName} — Landing Page`,
    type: 'funnel',
    locationId,
  }, { headers, timeout: 15000 });

  const funnelId = funnelRes.data?.funnel?.id || funnelRes.data?.id;
  if (!funnelId) throw new Error('Funnel creation returned no ID');

  // Add a page step to the funnel
  const stepRes = await axios.post(`https://services.leadconnectorhq.com/funnels/${funnelId}/steps`, {
    name: 'Main Page',
    type: 'optin_page',
    sequence: 0,
    pageContent: pageHTML,
  }, { headers, timeout: 15000 }).catch(() => null); // non-fatal if step API differs

  console.log(`[Sofia] Created GHL funnel for ${clientName}: ${funnelId}`);
  return { funnelId, stepCreated: !!stepRes, pageHTML };
}

// ═══════════════════════════════════════════════════════════
// SOFIA — MULTI-PAGE WEBSITE BUILDER
// Builds: Home, About Us, Services, Contact Us, FAQ
// All pages share nav + footer + design system
// ═══════════════════════════════════════════════════════════

// One Claude call generates all content for all 5 pages
async function generateWebsiteContent(clientName, industry, city) {
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 2000,
    messages: [{ role: 'user', content: `Generate complete website content for a ${industry} business called "${clientName}" in ${city}. Return ONLY valid JSON:
{
  "tagline": "short powerful tagline (under 8 words)",
  "heroHeadline": "compelling H1 (under 12 words)",
  "heroSub": "hero subheadline (1 sentence, benefits-focused)",
  "stats": [{"number":"150+","label":"Happy Clients"},{"number":"5★","label":"Average Rating"},{"number":"3yr","label":"Avg Retention"},{"number":"24/7","label":"Support"}],
  "services": [
    {"title":"Service Name","icon":"🎯","description":"2-sentence description","features":["Feature 1","Feature 2","Feature 3"]},
    {"title":"Service Name","icon":"📈","description":"2-sentence description","features":["Feature 1","Feature 2","Feature 3"]},
    {"title":"Service Name","icon":"🔥","description":"2-sentence description","features":["Feature 1","Feature 2","Feature 3"]},
    {"title":"Service Name","icon":"⚡","description":"2-sentence description","features":["Feature 1","Feature 2","Feature 3"]},
    {"title":"Service Name","icon":"🎨","description":"2-sentence description","features":["Feature 1","Feature 2","Feature 3"]},
    {"title":"Service Name","icon":"📊","description":"2-sentence description","features":["Feature 1","Feature 2","Feature 3"]}
  ],
  "whyUs": [
    {"title":"Reason 1","description":"2-sentence description"},
    {"title":"Reason 2","description":"2-sentence description"},
    {"title":"Reason 3","description":"2-sentence description"},
    {"title":"Reason 4","description":"2-sentence description"}
  ],
  "testimonials": [
    {"name":"Real Name","business":"Business Type","text":"Authentic testimonial 2-3 sentences","rating":5},
    {"name":"Real Name","business":"Business Type","text":"Authentic testimonial 2-3 sentences","rating":5},
    {"name":"Real Name","business":"Business Type","text":"Authentic testimonial 2-3 sentences","rating":5}
  ],
  "aboutStory": "3-4 sentence company story, first person, authentic",
  "founderBio": "2-3 sentences about the founder/owner, their background and passion",
  "values": [
    {"icon":"🏆","title":"Value 1","description":"1 sentence"},
    {"icon":"🤝","title":"Value 2","description":"1 sentence"},
    {"icon":"💡","title":"Value 3","description":"1 sentence"},
    {"icon":"❤️","title":"Value 4","description":"1 sentence"}
  ],
  "processSteps": [
    {"step":"01","title":"Step Name","description":"1-2 sentences"},
    {"step":"02","title":"Step Name","description":"1-2 sentences"},
    {"step":"03","title":"Step Name","description":"1-2 sentences"},
    {"step":"04","title":"Step Name","description":"1-2 sentences"}
  ],
  "faqs": [
    {"q":"Question about pricing?","a":"Detailed answer 1-2 sentences."},
    {"q":"How long does it take?","a":"Detailed answer 1-2 sentences."},
    {"q":"Do you offer guarantees?","a":"Detailed answer 1-2 sentences."},
    {"q":"What areas do you serve?","a":"Detailed answer mentioning ${city}."},
    {"q":"How do I get started?","a":"Detailed answer 1-2 sentences."},
    {"q":"What makes you different?","a":"Detailed answer 1-2 sentences."},
    {"q":"Do you have financing?","a":"Detailed answer 1-2 sentences."},
    {"q":"Are you licensed and insured?","a":"Detailed answer 1-2 sentences."},
    {"q":"Can I see past work?","a":"Detailed answer 1-2 sentences."},
    {"q":"What if I'm not satisfied?","a":"Detailed answer 1-2 sentences."}
  ],
  "areas": ["${city}","Area 2","Area 3","Area 4","Area 5","Area 6","Area 7","Area 8"],
  "contactHours": "Mon–Fri 8am–6pm, Sat 9am–3pm",
  "metaDescription": "SEO meta description under 160 chars"
}` }],
  });
  return JSON.parse(res.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);
}

// Shared CSS design system + nav + footer used on every page
function buildSharedLayout(clientName, industry, city, phone, logoUrl, siteBase = '.') {
  const navLinks = [
    { label: 'Home',       href: siteBase || '/' },
    { label: 'About Us',   href: (siteBase || '') + '/about-us' },
    { label: 'Services',   href: (siteBase || '') + '/services' },
    { label: 'FAQ',        href: (siteBase || '') + '/faq' },
    { label: 'Contact',    href: (siteBase || '') + '/contact-us' },
  ];
  const navItems = navLinks.map(l =>
    `<a href="${l.href}" class="nav-link">${l.label}</a>`
  ).join('');

  const styles = `
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&family=Inter:wght@400;500;600&display=swap');
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    :root{--black:#0a0a0a;--dark:#111827;--gray:#6b7280;--light:#f9fafb;--white:#ffffff;--orange:#f97316;--orange-dark:#ea6c0a;--radius:14px;--shadow:0 4px 24px rgba(0,0,0,0.08)}
    html{scroll-behavior:smooth}
    body{font-family:'Inter',system-ui,sans-serif;color:var(--dark);background:var(--white);line-height:1.6}
    h1,h2,h3,h4{font-family:'Montserrat',sans-serif;font-weight:800;line-height:1.15}
    a{text-decoration:none;color:inherit}
    img{max-width:100%;display:block}
    .container{max-width:1140px;margin:0 auto;padding:0 24px}
    .btn{display:inline-flex;align-items:center;gap:8px;padding:14px 32px;border-radius:10px;font-weight:600;font-size:15px;cursor:pointer;transition:all .2s;border:none}
    .btn-primary{background:var(--orange);color:#fff}.btn-primary:hover{background:var(--orange-dark);transform:translateY(-1px)}
    .btn-outline{background:transparent;color:var(--white);border:2px solid rgba(255,255,255,0.4)}.btn-outline:hover{background:rgba(255,255,255,0.1)}
    .btn-dark{background:var(--black);color:#fff}.btn-dark:hover{background:#222;transform:translateY(-1px)}
    .section{padding:80px 0}
    .section-label{font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:var(--orange);margin-bottom:12px}
    .section-title{font-size:clamp(28px,4vw,42px);color:var(--black);margin-bottom:16px}
    .section-sub{font-size:17px;color:var(--gray);max-width:600px;line-height:1.7}
    .grid-2{display:grid;grid-template-columns:1fr 1fr;gap:40px;align-items:center}
    .grid-3{display:grid;grid-template-columns:repeat(3,1fr);gap:24px}
    .grid-4{display:grid;grid-template-columns:repeat(4,1fr);gap:24px}
    .card{background:var(--white);border-radius:var(--radius);box-shadow:var(--shadow);padding:32px;border:1px solid #f0f0f0;transition:transform .2s,box-shadow .2s}
    .card:hover{transform:translateY(-4px);box-shadow:0 12px 40px rgba(0,0,0,0.12)}
    .badge{display:inline-block;background:rgba(249,115,22,0.1);color:var(--orange);font-size:11px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;padding:6px 14px;border-radius:100px}
    .page-hero{background:var(--black);padding:80px 0 60px;text-align:center}
    .page-hero h1{color:#fff;font-size:clamp(32px,5vw,52px);margin-bottom:16px}
    .page-hero p{color:rgba(255,255,255,0.55);font-size:17px;max-width:560px;margin:0 auto}
    .stars{color:#f59e0b;font-size:14px;letter-spacing:2px}
    @media(max-width:768px){
      .grid-2,.grid-3,.grid-4{grid-template-columns:1fr}
      .section{padding:56px 0}
      .hide-mobile{display:none!important}
      .nav-menu{display:none;flex-direction:column;position:absolute;top:100%;left:0;right:0;background:var(--black);padding:16px 24px;gap:8px;border-top:1px solid rgba(255,255,255,0.08)}
      .nav-menu.open{display:flex}
      .hamburger{display:flex!important}
    }
  `;

  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${clientName}" style="height:40px;width:auto;">`
    : `<span style="font-family:Montserrat,sans-serif;font-weight:900;font-size:18px;color:#fff;">${clientName}</span>`;

  const nav = `
<header style="position:sticky;top:0;z-index:999;background:var(--black);border-bottom:1px solid rgba(255,255,255,0.07);">
  <div class="container" style="display:flex;align-items:center;justify-content:space-between;height:68px;">
    <a href="${navLinks[0].href}" style="display:flex;align-items:center;">${logoHtml}</a>
    <nav class="nav-menu" id="navMenu" style="display:flex;align-items:center;gap:4px;">
      ${navItems}
    </nav>
    <div style="display:flex;align-items:center;gap:12px;">
      <a href="${navLinks[4].href}" class="btn btn-primary" style="padding:10px 22px;font-size:14px;">Get Started</a>
      <button class="hamburger" onclick="document.getElementById('navMenu').classList.toggle('open')" style="display:none;background:none;border:none;cursor:pointer;padding:4px;">
        <svg width="24" height="24" fill="none" stroke="#fff" stroke-width="2"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
      </button>
    </div>
  </div>
</header>
<style>
  .nav-link{color:rgba(255,255,255,0.65);font-size:14px;font-weight:500;padding:8px 14px;border-radius:8px;transition:all .2s}
  .nav-link:hover{color:#fff;background:rgba(255,255,255,0.08)}
</style>`;

  const footer = `
<footer style="background:var(--black);padding:64px 0 32px;">
  <div class="container">
    <div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:48px;padding-bottom:48px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <div>
        ${logoHtml}
        <p style="color:rgba(255,255,255,0.45);font-size:14px;line-height:1.8;margin:16px 0 20px;max-width:280px;">Professional ${industry} services in ${city} and surrounding areas.</p>
        ${phone ? `<p style="color:#fff;font-size:15px;font-weight:600;">${phone}</p>` : ''}
      </div>
      <div>
        <p style="color:rgba(255,255,255,0.3);font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:16px;">Pages</p>
        ${navLinks.map(l => `<a href="${l.href}" style="display:block;color:rgba(255,255,255,0.55);font-size:14px;margin-bottom:10px;transition:color .2s;" onmouseover="this.style.color='#fff'" onmouseout="this.style.color='rgba(255,255,255,0.55)'">${l.label}</a>`).join('')}
      </div>
      <div>
        <p style="color:rgba(255,255,255,0.3);font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:16px;">Services</p>
        <p style="color:rgba(255,255,255,0.45);font-size:14px;line-height:2;">Available 24/7<br/>${city} & Surrounding<br/>Licensed & Insured<br/>Free Estimates</p>
      </div>
      <div>
        <p style="color:rgba(255,255,255,0.3);font-size:11px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;margin-bottom:16px;">Contact</p>
        ${phone ? `<p style="color:rgba(255,255,255,0.55);font-size:14px;margin-bottom:8px;">📞 ${phone}</p>` : ''}
        <p style="color:rgba(255,255,255,0.55);font-size:14px;margin-bottom:8px;">📍 ${city}, FL</p>
        <a href="${navLinks[4].href}" class="btn btn-primary" style="margin-top:16px;padding:10px 20px;font-size:13px;">Get a Free Quote</a>
      </div>
    </div>
    <div style="padding-top:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px;">
      <p style="color:rgba(255,255,255,0.25);font-size:12px;">© ${new Date().getFullYear()} ${clientName}. All rights reserved.</p>
      <p style="color:rgba(255,255,255,0.2);font-size:11px;">Website by <a href="https://jrzmarketing.com" style="color:var(--orange);">JRZ Marketing</a></p>
    </div>
  </div>
</footer>`;

  const scripts = `
<script>
  // Close nav on link click (mobile)
  document.querySelectorAll('.nav-link').forEach(l => l.addEventListener('click', () => {
    document.getElementById('navMenu').classList.remove('open');
  }));
  // Highlight active nav link
  const path = window.location.pathname;
  document.querySelectorAll('.nav-link').forEach(l => {
    if (l.getAttribute('href') === path || (path.endsWith(l.getAttribute('href').split('/').pop()) && l.getAttribute('href') !== '/')) {
      l.style.color = '#fff'; l.style.background = 'rgba(249,115,22,0.15)'; l.style.color = 'var(--orange)';
    }
  });
</script>`;

  return { styles, nav, footer, scripts };
}

function wrapPage(title, metaDesc, industry, city, bodyHtml, layout) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta name="description" content="${metaDesc}">
<meta property="og:title" content="${title}">
<meta property="og:description" content="${metaDesc}">
<title>${title}</title>
<style>${layout.styles}</style>
</head>
<body>
${layout.nav}
${bodyHtml}
${layout.footer}
${layout.scripts}
</body></html>`;
}

function buildHomePage(client, c, layout) {
  const { name, phone, city, industry, formId } = client;
  const serviceCards = c.services.slice(0, 3).map(s => `
    <div class="card">
      <div style="font-size:36px;margin-bottom:16px;">${s.icon}</div>
      <h3 style="font-size:20px;margin-bottom:10px;">${s.title}</h3>
      <p style="color:var(--gray);font-size:15px;line-height:1.7;margin-bottom:16px;">${s.description}</p>
      <ul style="list-style:none;padding:0;">${s.features.map(f => `<li style="font-size:14px;color:var(--gray);padding:4px 0;padding-left:18px;position:relative;"><span style="position:absolute;left:0;color:var(--orange);font-weight:700;">✓</span>${f}</li>`).join('')}</ul>
    </div>`).join('');

  const statItems = c.stats.map(s => `
    <div style="text-align:center;">
      <div style="font-size:36px;font-weight:900;font-family:Montserrat,sans-serif;color:var(--orange);">${s.number}</div>
      <div style="font-size:13px;color:rgba(255,255,255,0.5);text-transform:uppercase;letter-spacing:0.08em;margin-top:4px;">${s.label}</div>
    </div>`).join('');

  const testimonialCards = c.testimonials.map(t => `
    <div class="card">
      <div class="stars">${'★'.repeat(t.rating)}</div>
      <p style="font-size:15px;color:var(--dark);line-height:1.8;margin:14px 0 20px;font-style:italic;">"${t.text}"</p>
      <div style="display:flex;align-items:center;gap:12px;">
        <div style="width:44px;height:44px;border-radius:50%;background:linear-gradient(135deg,var(--orange),#f59e0b);display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:18px;">${t.name[0]}</div>
        <div><div style="font-weight:600;font-size:15px;">${t.name}</div><div style="font-size:12px;color:var(--gray);">${t.business}</div></div>
      </div>
    </div>`).join('');

  const whyItems = c.whyUs.map(w => `
    <div style="display:flex;gap:20px;align-items:flex-start;">
      <div style="width:48px;height:48px;border-radius:12px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <svg width="20" height="20" fill="var(--orange)" viewBox="0 0 20 20"><path d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"/></svg>
      </div>
      <div><h4 style="font-size:17px;margin-bottom:6px;">${w.title}</h4><p style="font-size:15px;color:var(--gray);line-height:1.7;">${w.description}</p></div>
    </div>`).join('');

  const body = `
<section style="background:var(--black);padding:100px 0 80px;overflow:hidden;position:relative;">
  <div style="position:absolute;inset:0;background:radial-gradient(circle at 70% 50%,rgba(249,115,22,0.06) 0%,transparent 60%);pointer-events:none;"></div>
  <div class="container" style="position:relative;">
    <div style="max-width:720px;">
      <div class="badge" style="margin-bottom:20px;">${city} ${industry}</div>
      <h1 style="font-size:clamp(36px,6vw,64px);color:#fff;line-height:1.08;margin-bottom:20px;">${c.heroHeadline}</h1>
      <p style="font-size:18px;color:rgba(255,255,255,0.55);line-height:1.75;margin-bottom:36px;max-width:560px;">${c.heroSub}</p>
      <div style="display:flex;gap:14px;flex-wrap:wrap;">
        <a href="${layout.nav.includes('/contact-us') ? '#contact' : '#'}" class="btn btn-primary" style="font-size:16px;padding:16px 36px;">Get a Free Quote →</a>
        ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}" class="btn btn-outline" style="font-size:16px;padding:16px 32px;">📞 ${phone}</a>` : ''}
      </div>
    </div>
  </div>
</section>

<section style="background:var(--dark);padding:40px 0;">
  <div class="container">
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:24px;">${statItems}</div>
  </div>
</section>

<section class="section" style="background:var(--light);">
  <div class="container">
    <div style="text-align:center;margin-bottom:56px;">
      <p class="section-label">What We Do</p>
      <h2 class="section-title">Our Core Services</h2>
      <p class="section-sub" style="margin:0 auto;">${c.tagline}</p>
    </div>
    <div class="grid-3">${serviceCards}</div>
    <div style="text-align:center;margin-top:40px;">
      <a href="${(client.siteBase||'')}/services" class="btn btn-dark">View All Services →</a>
    </div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="grid-2">
      <div>
        <p class="section-label">Why Choose Us</p>
        <h2 class="section-title" style="margin-bottom:32px;">The ${name} Difference</h2>
        <div style="display:flex;flex-direction:column;gap:28px;">${whyItems}</div>
      </div>
      <div style="background:var(--black);border-radius:20px;padding:48px;text-align:center;">
        <div style="font-size:56px;margin-bottom:16px;">🏆</div>
        <h3 style="color:#fff;font-size:26px;margin-bottom:12px;">Ready to Get Started?</h3>
        <p style="color:rgba(255,255,255,0.5);font-size:15px;line-height:1.7;margin-bottom:28px;">Join hundreds of satisfied customers in ${city}. Get your free consultation today.</p>
        <a href="${(client.siteBase||'')}/contact-us" class="btn btn-primary" style="width:100%;justify-content:center;padding:16px;">Book Free Consultation →</a>
      </div>
    </div>
  </div>
</section>

<section class="section" style="background:var(--light);">
  <div class="container">
    <div style="text-align:center;margin-bottom:56px;">
      <p class="section-label">Client Stories</p>
      <h2 class="section-title">What Our Clients Say</h2>
    </div>
    <div class="grid-3">${testimonialCards}</div>
  </div>
</section>

<section style="background:var(--orange);padding:72px 0;">
  <div class="container" style="text-align:center;">
    <h2 style="font-size:clamp(28px,4vw,44px);color:#fff;margin-bottom:16px;">Ready for Results?</h2>
    <p style="color:rgba(255,255,255,0.8);font-size:17px;margin-bottom:36px;">Get a free, no-obligation consultation with our ${industry} experts.</p>
    <a href="${(client.siteBase||'')}/contact-us" class="btn" style="background:#fff;color:var(--orange);font-size:16px;padding:16px 40px;">Get Started Today →</a>
  </div>
</section>`;

  return wrapPage(`${name} — ${city} ${industry}`, c.metaDescription, industry, city, body, layout);
}

function buildAboutPage(client, c, layout) {
  const { name, phone, city, industry } = client;
  const valueCards = c.values.map(v => `
    <div class="card" style="text-align:center;">
      <div style="font-size:40px;margin-bottom:12px;">${v.icon}</div>
      <h4 style="font-size:18px;margin-bottom:8px;">${v.title}</h4>
      <p style="font-size:14px;color:var(--gray);line-height:1.7;">${v.description}</p>
    </div>`).join('');

  const processHtml = c.processSteps.map((s, i) => `
    <div style="display:flex;gap:24px;align-items:flex-start;position:relative;">
      ${i < c.processSteps.length - 1 ? '<div style="position:absolute;left:27px;top:56px;width:2px;height:calc(100% + 24px);background:linear-gradient(to bottom,var(--orange),rgba(249,115,22,0.1));"></div>' : ''}
      <div style="width:54px;height:54px;border-radius:14px;background:var(--black);display:flex;align-items:center;justify-content:center;flex-shrink:0;">
        <span style="font-family:Montserrat,sans-serif;font-weight:900;font-size:16px;color:var(--orange);">${s.step}</span>
      </div>
      <div style="padding-bottom:32px;">
        <h4 style="font-size:18px;margin-bottom:8px;">${s.title}</h4>
        <p style="font-size:15px;color:var(--gray);line-height:1.7;">${s.description}</p>
      </div>
    </div>`).join('');

  const body = `
<section class="page-hero">
  <div class="container">
    <div class="badge" style="margin-bottom:16px;">About Us</div>
    <h1>The Story Behind ${name}</h1>
    <p>${c.tagline}</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="grid-2">
      <div>
        <p class="section-label">Our Story</p>
        <h2 class="section-title">Built on Trust.<br/>Driven by Results.</h2>
        <p style="font-size:16px;color:var(--gray);line-height:1.8;margin:20px 0 28px;">${c.aboutStory}</p>
        <div style="display:flex;gap:32px;flex-wrap:wrap;">
          ${c.stats.slice(0,3).map(s => `<div><div style="font-size:28px;font-weight:900;font-family:Montserrat,sans-serif;color:var(--orange);">${s.number}</div><div style="font-size:12px;color:var(--gray);text-transform:uppercase;letter-spacing:0.08em;margin-top:4px;">${s.label}</div></div>`).join('')}
        </div>
      </div>
      <div style="background:var(--black);border-radius:20px;padding:48px;">
        <div style="width:72px;height:72px;border-radius:20px;background:rgba(249,115,22,0.15);display:flex;align-items:center;justify-content:center;margin-bottom:20px;font-size:32px;">👤</div>
        <h3 style="color:#fff;font-size:22px;margin-bottom:12px;">${name}</h3>
        <p style="color:var(--orange);font-size:13px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;margin-bottom:16px;">Founder & Owner · ${city}</p>
        <p style="color:rgba(255,255,255,0.55);font-size:15px;line-height:1.8;">${c.founderBio}</p>
        ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}" class="btn btn-primary" style="margin-top:24px;width:100%;justify-content:center;">📞 ${phone}</a>` : ''}
      </div>
    </div>
  </div>
</section>

<section class="section" style="background:var(--light);">
  <div class="container">
    <div style="text-align:center;margin-bottom:56px;">
      <p class="section-label">What We Stand For</p>
      <h2 class="section-title">Our Core Values</h2>
    </div>
    <div class="grid-4">${valueCards}</div>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="grid-2">
      <div>
        <p class="section-label">How It Works</p>
        <h2 class="section-title" style="margin-bottom:40px;">Our Proven Process</h2>
        ${processHtml}
      </div>
      <div style="padding:48px;background:var(--light);border-radius:20px;">
        <h3 style="font-size:26px;margin-bottom:16px;">Serving ${city} & Beyond</h3>
        <p style="font-size:15px;color:var(--gray);line-height:1.8;margin-bottom:24px;">We proudly serve clients across the ${city} area and surrounding communities.</p>
        <div style="display:flex;flex-wrap:wrap;gap:8px;">
          ${c.areas.map(a => `<span style="background:#fff;border:1px solid #e5e7eb;border-radius:100px;padding:6px 16px;font-size:13px;font-weight:500;">${a}</span>`).join('')}
        </div>
        <a href="${(client.siteBase||'')}/contact-us" class="btn btn-primary" style="margin-top:32px;">Work With Us →</a>
      </div>
    </div>
  </div>
</section>`;

  return wrapPage(`About Us — ${name} | ${city} ${industry}`, `Learn about ${name}, a trusted ${industry} company in ${city}.`, industry, city, body, layout);
}

function buildServicesPage(client, c, layout) {
  const { name, phone, city, industry } = client;
  const allServiceCards = c.services.map(s => `
    <div class="card">
      <div style="font-size:40px;margin-bottom:16px;">${s.icon}</div>
      <h3 style="font-size:20px;margin-bottom:10px;">${s.title}</h3>
      <p style="font-size:15px;color:var(--gray);line-height:1.7;margin-bottom:20px;">${s.description}</p>
      <ul style="list-style:none;padding:0;margin-bottom:24px;">${s.features.map(f => `<li style="font-size:14px;color:var(--dark);padding:6px 0;border-bottom:1px solid #f0f0f0;padding-left:20px;position:relative;"><span style="position:absolute;left:0;color:var(--orange);font-weight:700;">✓</span>${f}</li>`).join('')}</ul>
      <a href="${(client.siteBase||'')}/contact-us" class="btn btn-dark" style="width:100%;justify-content:center;">Get a Quote</a>
    </div>`).join('');

  const processHtml = c.processSteps.map(s => `
    <div style="text-align:center;padding:32px 24px;">
      <div style="width:56px;height:56px;border-radius:16px;background:var(--orange);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;"><span style="font-family:Montserrat,sans-serif;font-weight:900;font-size:18px;color:#fff;">${s.step}</span></div>
      <h4 style="font-size:17px;margin-bottom:8px;">${s.title}</h4>
      <p style="font-size:14px;color:var(--gray);line-height:1.7;">${s.description}</p>
    </div>`).join('');

  const body = `
<section class="page-hero">
  <div class="container">
    <div class="badge" style="margin-bottom:16px;">Services</div>
    <h1>Everything We Offer</h1>
    <p>Professional ${industry} solutions for ${city} and surrounding areas</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <div style="text-align:center;margin-bottom:56px;">
      <p class="section-label">Complete Solutions</p>
      <h2 class="section-title">Our Services</h2>
      <p class="section-sub" style="margin:0 auto;">${c.tagline}</p>
    </div>
    <div class="grid-3">${allServiceCards}</div>
  </div>
</section>

<section class="section" style="background:var(--light);">
  <div class="container">
    <div style="text-align:center;margin-bottom:48px;">
      <p class="section-label">The Process</p>
      <h2 class="section-title">How We Work</h2>
    </div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:0;position:relative;">
      <div style="position:absolute;top:28px;left:12.5%;right:12.5%;height:2px;background:linear-gradient(to right,var(--orange),rgba(249,115,22,0.2));z-index:0;"></div>
      ${processHtml}
    </div>
  </div>
</section>

<section style="background:var(--black);padding:72px 0;">
  <div class="container" style="text-align:center;">
    <h2 style="color:#fff;font-size:clamp(26px,4vw,40px);margin-bottom:16px;">Not Sure Which Service You Need?</h2>
    <p style="color:rgba(255,255,255,0.5);font-size:17px;margin-bottom:32px;">Call us or book a free consultation — we'll assess your situation and recommend the best solution.</p>
    <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
      <a href="${(client.siteBase||'')}/contact-us" class="btn btn-primary" style="padding:16px 40px;font-size:16px;">Book Free Consultation →</a>
      ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}" class="btn btn-outline" style="padding:16px 32px;font-size:16px;">📞 ${phone}</a>` : ''}
    </div>
  </div>
</section>`;

  return wrapPage(`Services — ${name} | ${city} ${industry}`, `Explore all ${industry} services offered by ${name} in ${city}.`, industry, city, body, layout);
}

function buildContactPage(client, c, layout) {
  const { name, phone, city, industry, formId } = client;
  const body = `
<section class="page-hero">
  <div class="container">
    <div class="badge" style="margin-bottom:16px;">Contact Us</div>
    <h1>Let's Get Started</h1>
    <p>Fill out the form or call us directly — we respond within 24 hours</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <div class="grid-2" style="gap:56px;">
      <div>
        <p class="section-label">Send Us a Message</p>
        <h2 class="section-title" style="margin-bottom:24px;">Get a Free Quote</h2>
        <p style="color:var(--gray);font-size:16px;line-height:1.7;margin-bottom:32px;">Tell us about your project and we'll get back to you with a detailed, no-obligation quote.</p>
        <div style="background:var(--light);border-radius:var(--radius);padding:32px;">
          <iframe src="https://api.leadconnectorhq.com/widget/form/${formId}" style="width:100%;min-height:520px;border:none;" scrolling="no" id="msgsndr-form"></iframe>
          <script src="https://link.msgsndr.com/js/form_embed.js"></script>
        </div>
      </div>
      <div>
        <p class="section-label">Contact Information</p>
        <h2 class="section-title" style="margin-bottom:32px;">Reach Us Directly</h2>
        <div style="display:flex;flex-direction:column;gap:20px;margin-bottom:40px;">
          ${phone ? `<div style="display:flex;gap:16px;align-items:flex-start;">
            <div style="width:48px;height:48px;border-radius:12px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;">📞</div>
            <div><p style="font-weight:600;font-size:16px;margin-bottom:4px;">Phone</p><a href="tel:${phone.replace(/\D/g,'')}" style="color:var(--gray);font-size:15px;">${phone}</a></div>
          </div>` : ''}
          <div style="display:flex;gap:16px;align-items:flex-start;">
            <div style="width:48px;height:48px;border-radius:12px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;">📍</div>
            <div><p style="font-weight:600;font-size:16px;margin-bottom:4px;">Location</p><p style="color:var(--gray);font-size:15px;">${city}, Florida</p></div>
          </div>
          <div style="display:flex;gap:16px;align-items:flex-start;">
            <div style="width:48px;height:48px;border-radius:12px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;">🕐</div>
            <div><p style="font-weight:600;font-size:16px;margin-bottom:4px;">Hours</p><p style="color:var(--gray);font-size:15px;">${c.contactHours}</p></div>
          </div>
          <div style="display:flex;gap:16px;align-items:flex-start;">
            <div style="width:48px;height:48px;border-radius:12px;background:rgba(249,115,22,0.1);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;">⚡</div>
            <div><p style="font-weight:600;font-size:16px;margin-bottom:4px;">Response Time</p><p style="color:var(--gray);font-size:15px;">We reply within 2 hours during business hours</p></div>
          </div>
        </div>
        <div style="background:var(--black);border-radius:var(--radius);padding:28px;">
          <h4 style="color:#fff;font-size:18px;margin-bottom:12px;">Service Areas</h4>
          <div style="display:flex;flex-wrap:wrap;gap:8px;">${c.areas.map(a => `<span style="background:rgba(255,255,255,0.07);color:rgba(255,255,255,0.6);border-radius:100px;padding:5px 14px;font-size:13px;">${a}</span>`).join('')}</div>
        </div>
      </div>
    </div>
  </div>
</section>`;

  return wrapPage(`Contact Us — ${name} | ${city}`, `Contact ${name} for ${industry} services in ${city}. Free quotes, fast response.`, industry, city, body, layout);
}

function buildFAQPage(client, c, layout) {
  const { name, city, industry, phone } = client;
  const faqItems = c.faqs.map((f, i) => `
    <div style="border-bottom:1px solid #f0f0f0;">
      <button onclick="toggleFaq(${i})" style="width:100%;display:flex;justify-content:space-between;align-items:center;padding:20px 0;background:none;border:none;cursor:pointer;text-align:left;">
        <span style="font-family:Montserrat,sans-serif;font-weight:700;font-size:16px;color:var(--dark);padding-right:16px;">${f.q}</span>
        <span id="faq-icon-${i}" style="color:var(--orange);font-size:24px;flex-shrink:0;transition:transform .2s;">+</span>
      </button>
      <div id="faq-body-${i}" style="display:none;padding:0 0 20px;">
        <p style="font-size:15px;color:var(--gray);line-height:1.8;">${f.a}</p>
      </div>
    </div>`).join('');

  const body = `
<section class="page-hero">
  <div class="container">
    <div class="badge" style="margin-bottom:16px;">FAQ</div>
    <h1>Frequently Asked Questions</h1>
    <p>Everything you need to know about our ${industry} services in ${city}</p>
  </div>
</section>

<section class="section">
  <div class="container">
    <div style="max-width:760px;margin:0 auto;">
      <div style="background:var(--light);border-radius:14px;padding:16px 24px;display:flex;align-items:center;gap:12px;margin-bottom:40px;">
        <span style="font-size:20px;">🔍</span>
        <input type="text" placeholder="Search questions..." oninput="filterFaqs(this.value)" style="background:none;border:none;outline:none;font-size:15px;color:var(--dark);width:100%;" />
      </div>
      <div id="faq-list">${faqItems}</div>
    </div>
  </div>
</section>

<section style="background:var(--light);padding:72px 0;">
  <div class="container" style="text-align:center;">
    <h2 style="font-size:clamp(26px,4vw,40px);margin-bottom:16px;">Still Have Questions?</h2>
    <p style="color:var(--gray);font-size:17px;margin-bottom:32px;">We're happy to help. Reach out and we'll answer within a few hours.</p>
    <div style="display:flex;gap:16px;justify-content:center;flex-wrap:wrap;">
      <a href="${(client.siteBase||'')}/contact-us" class="btn btn-primary" style="padding:16px 36px;">Contact Us →</a>
      ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}" class="btn btn-dark" style="padding:16px 32px;">📞 ${phone}</a>` : ''}
    </div>
  </div>
</section>

<script>
function toggleFaq(i) {
  const body = document.getElementById('faq-body-' + i);
  const icon = document.getElementById('faq-icon-' + i);
  const open = body.style.display === 'block';
  document.querySelectorAll('[id^="faq-body-"]').forEach(el => el.style.display = 'none');
  document.querySelectorAll('[id^="faq-icon-"]').forEach(el => { el.textContent = '+'; el.style.transform = ''; });
  if (!open) { body.style.display = 'block'; icon.textContent = '×'; icon.style.transform = 'rotate(45deg)'; }
}
function filterFaqs(q) {
  const term = q.toLowerCase();
  document.querySelectorAll('[id^="faq-body-"]').forEach((el, i) => {
    const row = el.closest ? el.parentElement : el.previousElementSibling?.parentElement;
    if (row) row.style.display = (row.textContent.toLowerCase().includes(term) || !term) ? '' : 'none';
  });
}
</script>`;

  return wrapPage(`FAQ — ${name} | ${city} ${industry}`, `Common questions about ${name}'s ${industry} services in ${city}.`, industry, city, body, layout);
}

// Main orchestrator — generates all 5 pages
async function buildWebsite(clientName, phone, email, city, industry, logoUrl = '', formId = GHL_FORM_ID, siteBase = '.') {
  city = city || 'Orlando';
  formId = formId || GHL_FORM_ID;
  console.log(`[Sofia] Building 5-page website for ${clientName} (${industry}, ${city})...`);
  const content = await generateWebsiteContent(clientName, industry, city);
  const client = { name: clientName, phone, email, city, industry, logoUrl, formId, siteBase };
  const layout = buildSharedLayout(clientName, industry, city, phone, logoUrl, siteBase);
  return {
    home:     buildHomePage(client, content, layout),
    about:    buildAboutPage(client, content, layout),
    services: buildServicesPage(client, content, layout),
    contact:  buildContactPage(client, content, layout),
    faq:      buildFAQPage(client, content, layout),
    content, // expose for debugging
  };
}

// Create GHL funnel with 5 linked page steps
async function createGHLWebsite(locationId, clientName, industry, phone = '', email = '', city = 'Orlando', logoUrl = '', formId = GHL_FORM_ID) {
  const headers = { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  console.log(`[Sofia] Creating GHL 5-page website for ${clientName}...`);

  // Step 1: create funnel container
  const funnelRes = await axios.post('https://services.leadconnectorhq.com/funnels/', {
    name: `${clientName} — Website`,
    type: 'funnel',
    locationId,
  }, { headers, timeout: 15000 });
  const funnelId = funnelRes.data?.funnel?.id || funnelRes.data?.id;
  if (!funnelId) throw new Error('GHL funnel creation returned no ID');

  // Step 2: build all pages (we know funnelId now but not the base URL — use GHL path pattern)
  const siteBase = ''; // relative nav links work within funnel
  const pages = await buildWebsite(clientName, phone, email, city, industry, logoUrl, formId, siteBase);

  // Step 3: add all 5 page steps
  const pageSteps = [
    { name: 'Home',       slug: 'home',       html: pages.home,     sequence: 0 },
    { name: 'About Us',   slug: 'about-us',   html: pages.about,    sequence: 1 },
    { name: 'Services',   slug: 'services',   html: pages.services, sequence: 2 },
    { name: 'Contact Us', slug: 'contact-us', html: pages.contact,  sequence: 3 },
    { name: 'FAQ',        slug: 'faq',        html: pages.faq,      sequence: 4 },
  ];

  const results = [];
  for (const step of pageSteps) {
    const stepRes = await axios.post(`https://services.leadconnectorhq.com/funnels/${funnelId}/steps`, {
      name: step.name, type: 'optin_page', sequence: step.sequence, pageContent: step.html,
    }, { headers, timeout: 15000 }).catch(e => ({ error: e.message }));
    results.push({ page: step.name, created: !stepRes?.error, error: stepRes?.error });
    await new Promise(r => setTimeout(r, 500));
  }

  console.log(`[Sofia] Website created: ${funnelId}. Pages: ${results.filter(r => r.created).length}/5`);
  logActivity('sofia', `Built 5-page website for ${clientName}: ${funnelId}`);
  return { funnelId, pages: results, locationId };
}

// ═══════════════════════════════════════════════════════════
// SOFIA — LEAD FUNNEL BUILDER
// Types: 'consultation' | 'quote' | 'lead-magnet'
// ═══════════════════════════════════════════════════════════

async function generateLeadFunnelContent(type, clientName, industry, city) {
  const typeMap = {
    consultation: 'free consultation booking',
    quote: 'free estimate/quote request',
    'lead-magnet': 'free guide/checklist download',
  };
  const res = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 800,
    messages: [{ role: 'user', content: `Generate lead funnel content for a ${industry} business "${clientName}" in ${city}. Funnel type: ${typeMap[type] || type}. Return ONLY valid JSON:
{
  "optinHeadline": "compelling opt-in headline (action-oriented, under 12 words)",
  "optinSub": "1-sentence value proposition",
  "bulletPoints": ["Benefit 1","Benefit 2","Benefit 3","Benefit 4"],
  "ctaText": "CTA button text (under 6 words)",
  "socialProof": "short social proof line (e.g. '127 homeowners in ${city} already claimed this')",
  "thankYouHeadline": "thank you page headline",
  "thankYouSub": "next steps instruction",
  "urgencyText": "urgency/scarcity line",
  "leadMagnetTitle": "name of the free offer (e.g. 'Free Roof Inspection', 'Free SEO Audit')"
}` }],
  });
  return JSON.parse(res.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);
}

async function buildLeadFunnelHTML(type, clientName, phone, city, industry, logoUrl = '', formId = GHL_FORM_ID) {
  const c = await generateLeadFunnelContent(type, clientName, industry, city);
  const logoHtml = logoUrl
    ? `<img src="${logoUrl}" alt="${clientName}" style="height:44px;">`
    : `<span style="font-family:Montserrat,sans-serif;font-weight:900;font-size:20px;color:#fff;">${clientName}</span>`;

  const bullets = c.bulletPoints.map(b => `
    <div style="display:flex;gap:12px;align-items:flex-start;">
      <div style="width:24px;height:24px;border-radius:50%;background:rgba(249,115,22,0.15);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:2px;">
        <span style="color:var(--orange);font-weight:700;font-size:13px;">✓</span>
      </div>
      <span style="font-size:16px;color:rgba(255,255,255,0.8);line-height:1.6;">${b}</span>
    </div>`).join('');

  const sharedStyles = `
    @import url('https://fonts.googleapis.com/css2?family=Montserrat:wght@700;800;900&family=Inter:wght@400;500;600&display=swap');
    *,*::before,*::after{margin:0;padding:0;box-sizing:border-box}
    :root{--black:#0a0a0a;--orange:#f97316;--white:#fff}
    body{font-family:'Inter',sans-serif;background:var(--black);color:#fff;min-height:100vh}
    h1,h2{font-family:'Montserrat',sans-serif;font-weight:800}
    .btn{display:inline-block;padding:18px 40px;border-radius:12px;font-weight:700;font-size:17px;cursor:pointer;transition:all .2s;text-decoration:none;border:none;text-align:center}
    .btn-cta{background:var(--orange);color:#fff;width:100%}.btn-cta:hover{background:#ea6c0a;transform:translateY(-2px)}
  `;

  const optin = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>${c.leadMagnetTitle} — ${clientName}</title>
<style>${sharedStyles}</style>
</head><body>
<div style="min-height:100vh;display:grid;grid-template-rows:auto 1fr;background:linear-gradient(135deg,#0a0a0a 0%,#1a0a00 100%);">
  <header style="padding:20px 32px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:center;">
    ${logoHtml}
  </header>
  <main style="display:flex;align-items:center;justify-content:center;padding:40px 24px;">
    <div style="max-width:960px;width:100%;display:grid;grid-template-columns:1fr 1fr;gap:64px;align-items:center;">
      <div>
        <div style="display:inline-block;background:rgba(249,115,22,0.12);border:1px solid rgba(249,115,22,0.3);color:var(--orange);font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:7px 16px;border-radius:100px;margin-bottom:20px;">
          ${city} ${industry}
        </div>
        <h1 style="font-size:clamp(32px,5vw,52px);line-height:1.1;margin-bottom:20px;">${c.optinHeadline}</h1>
        <p style="font-size:17px;color:rgba(255,255,255,0.55);line-height:1.7;margin-bottom:32px;">${c.optinSub}</p>
        <div style="display:flex;flex-direction:column;gap:14px;margin-bottom:32px;">${bullets}</div>
        <p style="font-size:13px;color:rgba(255,255,255,0.3);">${c.socialProof}</p>
      </div>
      <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:40px;">
        <p style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:var(--orange);margin-bottom:8px;">FREE — No Obligation</p>
        <h2 style="font-size:24px;margin-bottom:8px;">${c.leadMagnetTitle}</h2>
        <p style="color:rgba(255,255,255,0.4);font-size:14px;margin-bottom:28px;">${c.urgencyText}</p>
        <iframe src="https://api.leadconnectorhq.com/widget/form/${formId}" style="width:100%;min-height:380px;border:none;border-radius:12px;" scrolling="no"></iframe>
        <script src="https://link.msgsndr.com/js/form_embed.js"></script>
        ${phone ? `<p style="text-align:center;margin-top:20px;font-size:14px;color:rgba(255,255,255,0.3);">Or call us: <a href="tel:${phone.replace(/\D/g,'')}" style="color:var(--orange);font-weight:600;">${phone}</a></p>` : ''}
      </div>
    </div>
  </main>
</div>
</body></html>`;

  const thankYou = `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Thank You — ${clientName}</title>
<style>${sharedStyles}</style>
</head><body>
<div style="min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:40px 24px;text-align:center;background:linear-gradient(135deg,#0a0a0a,#0f1a0a);">
  <header style="position:fixed;top:0;left:0;right:0;padding:20px 32px;border-bottom:1px solid rgba(255,255,255,0.06);display:flex;justify-content:center;background:rgba(10,10,10,0.9);backdrop-filter:blur(8px);">${logoHtml}</header>
  <div style="max-width:560px;margin:80px auto 0;">
    <div style="width:80px;height:80px;border-radius:50%;background:rgba(34,197,94,0.15);border:2px solid rgba(34,197,94,0.3);display:flex;align-items:center;justify-content:center;margin:0 auto 28px;font-size:36px;">✅</div>
    <div style="display:inline-block;background:rgba(34,197,94,0.1);color:#22c55e;font-size:12px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:6px 16px;border-radius:100px;margin-bottom:20px;">Confirmed</div>
    <h1 style="font-size:clamp(28px,5vw,48px);line-height:1.15;margin-bottom:16px;">${c.thankYouHeadline}</h1>
    <p style="font-size:17px;color:rgba(255,255,255,0.5);line-height:1.7;margin-bottom:36px;">${c.thankYouSub}</p>
    <div style="background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:16px;padding:28px;margin-bottom:32px;">
      <p style="font-size:13px;font-weight:700;letter-spacing:0.1em;text-transform:uppercase;color:rgba(255,255,255,0.3);margin-bottom:16px;">What Happens Next</p>
      <div style="display:flex;flex-direction:column;gap:12px;text-align:left;">
        <div style="display:flex;gap:12px;align-items:center;"><span style="width:28px;height:28px;border-radius:50%;background:var(--orange);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">1</span><span style="font-size:15px;color:rgba(255,255,255,0.7);">We review your submission</span></div>
        <div style="display:flex;gap:12px;align-items:center;"><span style="width:28px;height:28px;border-radius:50%;background:var(--orange);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">2</span><span style="font-size:15px;color:rgba(255,255,255,0.7);">A specialist contacts you within 2 hours</span></div>
        <div style="display:flex;gap:12px;align-items:center;"><span style="width:28px;height:28px;border-radius:50%;background:var(--orange);display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;">3</span><span style="font-size:15px;color:rgba(255,255,255,0.7);">We schedule your free ${type === 'consultation' ? 'consultation' : 'appointment'}</span></div>
      </div>
    </div>
    ${phone ? `<a href="tel:${phone.replace(/\D/g,'')}" class="btn btn-cta">📞 Call Us Now: ${phone}</a>` : ''}
  </div>
</div>
</body></html>`;

  return { optin, thankYou, content: c };
}

async function createGHLLeadFunnel(locationId, clientName, industry, funnelType = 'consultation', phone = '', city = 'Orlando', logoUrl = '', formId = GHL_FORM_ID) {
  const headers = { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const typeLabel = { consultation: 'Free Consultation', quote: 'Free Quote', 'lead-magnet': 'Lead Magnet' }[funnelType] || funnelType;
  console.log(`[Sofia] Building ${typeLabel} funnel for ${clientName}...`);

  const { optin, thankYou, content: fc } = await buildLeadFunnelHTML(funnelType, clientName, phone, city, industry, logoUrl, formId);

  const funnelRes = await axios.post('https://services.leadconnectorhq.com/funnels/', {
    name: `${clientName} — ${typeLabel} Funnel`,
    type: 'funnel', locationId,
  }, { headers, timeout: 15000 });
  const funnelId = funnelRes.data?.funnel?.id || funnelRes.data?.id;
  if (!funnelId) throw new Error('Funnel creation returned no ID');

  const steps = [
    { name: typeLabel, type: 'optin_page', sequence: 0, pageContent: optin },
    { name: 'Thank You', type: 'optin_page', sequence: 1, pageContent: thankYou },
  ];
  const results = [];
  for (const step of steps) {
    const r = await axios.post(`https://services.leadconnectorhq.com/funnels/${funnelId}/steps`, step, { headers, timeout: 15000 }).catch(e => ({ error: e.message }));
    results.push({ page: step.name, created: !r?.error });
    await new Promise(r2 => setTimeout(r2, 500));
  }

  console.log(`[Sofia] Lead funnel created: ${funnelId} (${typeLabel})`);
  logActivity('sofia', `Built ${typeLabel} funnel for ${clientName}: ${funnelId}`);
  return { funnelId, funnelType: typeLabel, leadMagnetTitle: fc.leadMagnetTitle, pages: results };
}

// ═══════════════════════════════════════════════════════════
// SOFIA — FORMS, SURVEYS & A2P COMPLIANCE
// ═══════════════════════════════════════════════════════════

// A2P-compliant SMS opt-in language — required on every form
const A2P_CONSENT_EN = (bizName) =>
  `By submitting this form, you consent to receive SMS messages and emails from ${bizName} regarding your inquiry. Msg frequency varies. Reply STOP to unsubscribe, HELP for help. Msg &amp; data rates may apply.`;
const A2P_CONSENT_ES = (bizName) =>
  `Al enviar este formulario, acepta recibir mensajes de texto y correos electrónicos de ${bizName}. La frecuencia varía. Responda STOP para cancelar, HELP para ayuda. Pueden aplicar tarifas de mensajes y datos.`;

// GHL form field definitions per form type
function getFormFields(formType) {
  const base = [
    { id: 'full_name',  label: 'Full Name',     dataType: 'TEXT',       isRequired: true,  position: 0 },
    { id: 'phone',      label: 'Phone Number',  dataType: 'PHONE',      isRequired: true,  position: 1 },
    { id: 'email',      label: 'Email Address', dataType: 'EMAIL',      isRequired: true,  position: 2 },
  ];
  const sets = {
    contact: [
      ...base,
      { id: 'message', label: 'How can we help you?', dataType: 'LARGE_TEXT', isRequired: false, position: 3 },
    ],
    lead: [
      ...base,
      { id: 'business_name', label: 'Business Name', dataType: 'TEXT', isRequired: false, position: 3 },
      { id: 'message', label: 'What are you looking for?', dataType: 'LARGE_TEXT', isRequired: false, position: 4 },
    ],
    quote: [
      ...base,
      { id: 'business_name', label: 'Business Name', dataType: 'TEXT', isRequired: false, position: 3 },
      { id: 'service_needed', label: 'Service Needed', dataType: 'TEXT', isRequired: false, position: 4 },
      { id: 'budget', label: 'Monthly Budget', dataType: 'DROPDOWN', isRequired: false, position: 5,
        picklistOptions: ['Under $500', '$500–$1,000', '$1,000–$2,500', '$2,500–$5,000', '$5,000+'] },
      { id: 'timeline', label: 'When to start?', dataType: 'DROPDOWN', isRequired: false, position: 6,
        picklistOptions: ['Immediately', 'Within 1 month', '1–3 months', 'Just exploring'] },
      { id: 'message', label: 'Tell us about your business', dataType: 'LARGE_TEXT', isRequired: false, position: 7 },
    ],
    'survey-nps': [
      ...base,
      { id: 'nps_score', label: 'How likely are you to recommend us? (1–10)', dataType: 'DROPDOWN', isRequired: true, position: 3,
        picklistOptions: ['1','2','3','4','5','6','7','8','9','10'] },
      { id: 'did_well', label: 'What did we do well?', dataType: 'LARGE_TEXT', isRequired: false, position: 4 },
      { id: 'improve',  label: 'What can we improve?',  dataType: 'LARGE_TEXT', isRequired: false, position: 5 },
      { id: 'overall',  label: 'Overall experience', dataType: 'DROPDOWN', isRequired: false, position: 6,
        picklistOptions: ['Excellent','Good','Average','Below average','Poor'] },
    ],
    'survey-qualify': [
      ...base,
      { id: 'business_type', label: 'Type of Business', dataType: 'TEXT', isRequired: true, position: 3 },
      { id: 'monthly_revenue', label: 'Current Monthly Revenue', dataType: 'DROPDOWN', isRequired: false, position: 4,
        picklistOptions: ['Under $5K','$5K–$15K','$15K–$50K','$50K–$100K','$100K+'] },
      { id: 'biggest_challenge', label: 'Biggest Marketing Challenge', dataType: 'DROPDOWN', isRequired: true, position: 5,
        picklistOptions: ['Getting new clients','Retaining current clients','Online presence','Ad ROI','Brand awareness','Other'] },
      { id: 'current_marketing', label: 'What marketing are you doing now?', dataType: 'LARGE_TEXT', isRequired: false, position: 6 },
      { id: 'goal', label: 'Main Goal for Next 90 Days', dataType: 'LARGE_TEXT', isRequired: false, position: 7 },
    ],
  };
  return sets[formType] || sets.contact;
}

async function createGHLForm(locationId, formType = 'contact', clientName = '', industry = '') {
  const headers = { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };
  const labels = { contact: 'Contact Us', lead: 'Lead Capture', quote: 'Get a Free Quote', 'survey-nps': 'Satisfaction Survey', 'survey-qualify': 'Qualification Survey' };
  const name = `${clientName ? clientName + ' — ' : ''}${labels[formType] || 'Contact Form'}`;
  const thankYouMessage = formType.startsWith('survey')
    ? 'Thank you for your feedback! We value your input.'
    : 'Thank you! Our team will reach out within 24 hours.';

  const formRes = await axios.post('https://services.leadconnectorhq.com/forms/', {
    locationId, name,
    fields: getFormFields(formType),
    submitType: 'ThankYouMessage',
    thankYouMessage,
  }, { headers, timeout: 15000 });

  const formId = formRes.data?.form?.id || formRes.data?.id;
  console.log(`[Sofia] Form created: "${name}" (${formId}) for ${locationId}`);
  logActivity('sofia', `Created ${formType} form for ${clientName || locationId}`);
  return { formId, formType, name, fieldCount: getFormFields(formType).length };
}

async function createGHLSurvey(locationId, surveyType = 'qualify', clientName = '', industry = '') {
  const headers = { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' };

  // Claude generates industry-specific, conversational survey questions
  const aiRes = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 700,
    messages: [{ role: 'user', content: `Create a ${surveyType === 'nps' ? 'client satisfaction (NPS-style)' : 'lead qualification'} survey for a ${industry || 'marketing'} business called "${clientName || 'Business'}". Make questions feel conversational, not corporate. Return ONLY valid JSON:
{"title":"Survey title","description":"1-sentence purpose","questions":[
{"text":"question","type":"radio|dropdown|text|rating","options":["opt1","opt2"],"required":true}
]}
Include ${surveyType === 'nps' ? '4' : '6'} questions. For rating use null options. For radio/dropdown provide 3-5 concise options.` }],
  });
  const survey = JSON.parse(aiRes.content[0].text.trim().match(/\{[\s\S]*\}/)[0]);

  const typeMap = { radio: 'MULTIPLE_CHOICE', dropdown: 'DROPDOWN', text: 'TEXTAREA', rating: 'RATING' };
  const surveyRes = await axios.post('https://services.leadconnectorhq.com/surveys/', {
    locationId,
    name: survey.title,
    description: survey.description,
    questions: survey.questions.map((q, i) => ({
      text: q.text,
      type: typeMap[q.type] || 'TEXTAREA',
      required: !!q.required,
      options: q.options || [],
      position: i,
    })),
  }, { headers, timeout: 15000 });

  const surveyId = surveyRes.data?.survey?.id || surveyRes.data?.id;
  console.log(`[Sofia] Survey created: "${survey.title}" (${surveyId}) for ${locationId}`);
  logActivity('sofia', `Created ${surveyType} survey for ${clientName || locationId}`);
  return { surveyId, title: survey.title, questionCount: survey.questions.length };
}

// Auto-create the full starter form + survey kit for a new client subaccount
async function createClientFormKit(locationId, clientName, industry) {
  console.log(`[Sofia] Creating form kit for ${clientName}...`);
  const results = {};
  try { results.contact  = await createGHLForm(locationId, 'contact',  clientName, industry); await new Promise(r => setTimeout(r, 1000)); } catch(e) { results.contact  = { error: e.message }; }
  try { results.quote    = await createGHLForm(locationId, 'quote',    clientName, industry); await new Promise(r => setTimeout(r, 1000)); } catch(e) { results.quote    = { error: e.message }; }
  try { results.qualify  = await createGHLForm(locationId, 'survey-qualify', clientName, industry); await new Promise(r => setTimeout(r, 1000)); } catch(e) { results.qualify  = { error: e.message }; }
  try { results.nps      = await createGHLSurvey(locationId, 'nps',   clientName, industry); } catch(e) { results.nps      = { error: e.message }; }
  console.log(`[Sofia] Form kit done for ${clientName}:`, JSON.stringify(results));
  return results;
}

// ─── Sofia: New Client Onboarding Check ──────────────────

const SOFIA_CLIENTS_SNAPSHOT_URL = 'https://res.cloudinary.com/dbsuw1mfm/raw/upload/jrz/sofia_clients_snapshot.json';
const SOFIA_CLIENTS_SNAPSHOT_PID = 'jrz/sofia_clients_snapshot';

async function loadSofiaClientsSnapshot() {
  try {
    const res = await axios.get(SOFIA_CLIENTS_SNAPSHOT_URL + '?t=' + Date.now(), { timeout: 8000 });
    return typeof res.data === 'string' ? JSON.parse(res.data) : res.data;
  } catch { return {}; }
}

async function saveSofiaClientsSnapshot(data) {
  const ts  = Math.floor(Date.now() / 1000);
  const sig = crypto.createHash('sha1').update(`overwrite=true&public_id=${SOFIA_CLIENTS_SNAPSHOT_PID}&timestamp=${ts}${CLOUDINARY_API_SECRET}`).digest('hex');
  const form = new FormData();
  form.append('file', Buffer.from(JSON.stringify(data, null, 2)), { filename: 'sofia_clients_snapshot.json', contentType: 'application/json' });
  form.append('public_id', SOFIA_CLIENTS_SNAPSHOT_PID);
  form.append('resource_type', 'raw');
  form.append('timestamp', String(ts));
  form.append('api_key', CLOUDINARY_API_KEY);
  form.append('signature', sig);
  form.append('overwrite', 'true');
  await axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, form, { headers: form.getHeaders(), maxBodyLength: Infinity, timeout: 30000 });
}

async function runSofiaOnboardingCheck() {
  console.log('[Sofia] Running new client onboarding check...');
  const [currentClients, prevSnapshot] = await Promise.all([getElenaClients(), loadSofiaClientsSnapshot()]);
  const newClients = currentClients.filter(c => !prevSnapshot[c.locationId]);

  // Save updated snapshot
  const newSnap = { ...prevSnapshot };
  currentClients.forEach(c => { if (!newSnap[c.locationId]) newSnap[c.locationId] = { addedAt: new Date().toISOString().split('T')[0] }; });
  await saveSofiaClientsSnapshot(newSnap);

  if (!newClients.length) { console.log('[Sofia] No new clients detected.'); return; }

  console.log(`[Sofia] ${newClients.length} new client(s) detected: ${newClients.map(c => c.name).join(', ')}`);
  const logoUrl = 'https://assets.cdn.filesafe.space/d7iUPfamAaPlSBNj6IhT/media/6957081ee4125a4ef97efc62.png';

  for (const client of newClients) {
    try {
      const locRes = await axios.get(`https://services.leadconnectorhq.com/locations/${client.locationId}`, {
        headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28' }, timeout: 8000,
      });
      const loc = locRes.data?.location || locRes.data;
      const website = loc?.website || loc?.business?.website || null;
      const phone   = loc?.phone   || loc?.business?.phone   || '';
      const email   = loc?.email   || loc?.business?.email   || '';

      const html = `<!DOCTYPE html><html><body style="font-family:Inter,sans-serif;background:#f4f4f4;padding:32px 20px;">
<div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.08);">
  <div style="background:#0a0a0a;padding:22px 32px;display:flex;align-items:center;justify-content:space-between;">
    <img src="${logoUrl}" style="height:30px;"/>
    <span style="background:rgba(255,255,255,0.08);border:1px solid rgba(255,255,255,0.12);color:rgba(255,255,255,0.45);font-size:10px;font-weight:700;letter-spacing:0.12em;text-transform:uppercase;padding:5px 12px;border-radius:100px;">Sofia · Nuevo Cliente</span>
  </div>
  <div style="background:#16a34a;padding:22px 32px;">
    <h1 style="color:#fff;font-size:20px;font-weight:800;">🎉 Nuevo cliente detectado</h1>
    <p style="color:rgba(255,255,255,0.85);font-size:14px;margin-top:6px;">${client.name} acaba de unirse a JRZ Marketing</p>
  </div>
  <div style="padding:28px 32px;">
    <table style="width:100%;border-collapse:collapse;margin-bottom:20px;">
      <tr><td style="padding:8px 0;font-size:13px;color:#999;width:120px;">Nombre</td><td style="padding:8px 0;font-size:14px;font-weight:600;color:#0a0a0a;">${client.name}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#999;">Industria</td><td style="padding:8px 0;font-size:14px;color:#0a0a0a;">${client.industry}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#999;">Teléfono</td><td style="padding:8px 0;font-size:14px;color:#0a0a0a;">${phone || 'No registrado'}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#999;">Email</td><td style="padding:8px 0;font-size:14px;color:#0a0a0a;">${email || 'No registrado'}</td></tr>
      <tr><td style="padding:8px 0;font-size:13px;color:#999;">Sitio web</td><td style="padding:8px 0;font-size:14px;color:${website ? '#16a34a' : '#dc2626'};">${website || '❌ Sin sitio web'}</td></tr>
    </table>
    ${!website ? `
    <div style="background:#fef2f2;border:1px solid #fecaca;border-radius:10px;padding:16px 20px;">
      <p style="font-size:14px;color:#991b1b;font-weight:600;margin-bottom:6px;">⚠️ Este cliente no tiene sitio web</p>
      <p style="font-size:13px;color:#dc2626;">Ejecuta este comando para que Sofia les cree una landing page automáticamente:</p>
      <code style="display:block;background:#fff;border:1px solid #fecaca;border-radius:6px;padding:10px;margin-top:10px;font-size:12px;color:#991b1b;">curl -X POST https://armando-bot-1.onrender.com/sofia/build-page -H "Content-Type: application/json" -d '{"locationId":"${client.locationId}","industry":"${client.industry}"}'</code>
    </div>` : `
    <div style="background:#f0fdf4;border:1px solid #bbf7d0;border-radius:10px;padding:16px 20px;">
      <p style="font-size:14px;color:#166534;">✅ Tiene sitio web: <a href="${website}" style="color:#16a34a;">${website}</a></p>
      <p style="font-size:13px;color:#4ade80;margin-top:4px;">Sofia hará un audit completo en el próximo reporte semanal.</p>
    </div>`}
  </div>
  <div style="background:#0a0a0a;padding:18px 32px;text-align:center;"><p style="font-size:11px;color:rgba(255,255,255,0.25);">Sofia — JRZ Marketing AI Web Designer</p></div>
</div></body></html>`;

      await sendEmail(OWNER_CONTACT_ID, `🎉 Sofia: Nuevo Cliente — ${client.name}${!website ? ' (Sin sitio web)' : ''}`, html);
      console.log(`[Sofia] Onboarding alert sent for ${client.name}`);
    } catch (err) {
      console.error(`[Sofia] Onboarding error for ${client.name}:`, err.message);
    }
  }
}

// ─── Sofia: Continuous Uptime Monitor (every 6 hours) ────
const sofiaDowntimeState = {}; // { locationId: { url, downSince, alertedAt } }

async function runSofiaUptimeMonitor() {
  console.log('[Sofia] Running 6-hour uptime check...');
  setAgentBusy('sofia', 'Running 6-hour uptime check on all client sites');
  logActivity('sofia', 'info', 'Uptime monitor started — checking all client sites');
  try {
    const clients = await getElenaClients();
    OFFICE_KPI.sitesMonitored = clients.length;
    const downtimeAlerts = [];

    await Promise.all(clients.map(async (client) => {
      const overrides = ELENA_CLIENT_OVERRIDES[client.locationId] || {};
      const url = overrides.website;
      if (!url) return;

      try {
        const start = Date.now();
        const res = await axios.get(url, { timeout: 10000, validateStatus: () => true, maxRedirects: 5 });
        const elapsed = Date.now() - start;
        const isDown = res.status >= 500 || res.status === 0;
        const isSlow = elapsed > 5000;

        if (isDown) {
          if (!sofiaDowntimeState[client.locationId]) {
            sofiaDowntimeState[client.locationId] = { url, downSince: new Date().toISOString(), alertedAt: null };
          }
          const state = sofiaDowntimeState[client.locationId];
          const now = Date.now();
          // Alert only once per 6 hours per site
          if (!state.alertedAt || now - new Date(state.alertedAt).getTime() > 6 * 60 * 60 * 1000) {
            state.alertedAt = new Date().toISOString();
            downtimeAlerts.push({ name: client.name, url, status: res.status, downSince: state.downSince });
          }
        } else if (isSlow) {
          downtimeAlerts.push({ name: client.name, url, status: res.status, slowMs: elapsed, type: 'slow' });
          delete sofiaDowntimeState[client.locationId];
        } else {
          delete sofiaDowntimeState[client.locationId]; // recovered
        }
      } catch {
        if (!sofiaDowntimeState[client.locationId]) {
          sofiaDowntimeState[client.locationId] = { url, downSince: new Date().toISOString(), alertedAt: null };
          downtimeAlerts.push({ name: client.name, url, status: 'unreachable', downSince: sofiaDowntimeState[client.locationId].downSince });
        }
      }
    }));

    if (!downtimeAlerts.length) {
      console.log('[Sofia] All monitored sites are up.');
      logActivity('sofia', 'success', `All ${clients.length} client sites are up and responding`);
      setAgentIdle('sofia', `All ${clients.length} sites healthy`);
      return;
    }
    downtimeAlerts.forEach(a => {
      logActivity('sofia', 'alert', `Site ${a.type === 'slow' ? 'SLOW' : 'DOWN'}: ${a.name} — ${a.url}`, { url: a.url });
    });
    agentChat('sofia', 'elena', `${downtimeAlerts.length} client site(s) are down or slow: ${downtimeAlerts.map(a=>a.name).join(', ')}. Client outreach may be needed.`);
    setAgentAlert('sofia', `${downtimeAlerts.length} site(s) down — alert sent`);

    const rows = downtimeAlerts.map(a =>
      a.type === 'slow'
        ? `<tr><td style="padding:10px;font-weight:600;">${a.name}</td><td><a href="${a.url}">${a.url}</a></td><td style="color:#f59e0b;">⚠️ Slow (${(a.slowMs/1000).toFixed(1)}s)</td></tr>`
        : `<tr><td style="padding:10px;font-weight:600;">${a.name}</td><td><a href="${a.url}">${a.url}</a></td><td style="color:#dc2626;">🔴 Down (HTTP ${a.status})</td></tr>`
    ).join('');

    const html = `<!DOCTYPE html><html><body style="font-family:sans-serif;background:#fff;padding:32px;">
<h2 style="color:#dc2626;">🚨 Sofia — Site Alert</h2>
<p style="color:#666;margin-bottom:20px;">${downtimeAlerts.length} client site(s) need attention right now.</p>
<table style="width:100%;border-collapse:collapse;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
<thead><tr style="background:#1a3a6b;color:#fff;"><th style="padding:12px;text-align:left;">Client</th><th>URL</th><th>Status</th></tr></thead>
<tbody>${rows}</tbody></table>
<p style="margin-top:20px;font-size:12px;color:#999;">Sofia checks all client sites every 6 hours — JRZ Marketing</p>
</body></html>`;

    await sendEmail(OWNER_CONTACT_ID, `🚨 Sofia: ${downtimeAlerts.length} Site(s) Down/Slow`, html);
    console.log(`[Sofia] Uptime alert sent — ${downtimeAlerts.length} issues found`);
  } catch (err) {
    console.error('[Sofia] Uptime monitor error:', err.message);
  }
}

// ─── Sofia endpoints ──────────────────────────────────────

app.post('/sofia/build-page', async (req, res) => {
  try {
    const { locationId, industry, city, formId } = req.body;
    if (!locationId) return res.status(400).json({ status: 'error', message: 'locationId required' });
    const locRes = await axios.get(`https://services.leadconnectorhq.com/locations/${locationId}`, {
      headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28' }, timeout: 8000,
    });
    const loc    = locRes.data?.location || locRes.data;
    const name   = loc?.name || loc?.business?.name || 'Client';
    const ind    = industry || ELENA_CLIENT_OVERRIDES[locationId]?.industry || 'business';
    const locCity = city || loc?.city || 'Orlando';
    const logo   = loc?.logoUrl || loc?.logo || '';
    const result = await createGHLLandingPage(locationId, name, ind, loc?.phone || '', loc?.email || '', locCity, logo, formId);
    res.json({ status: 'ok', funnelId: result.funnelId, stepCreated: result.stepCreated, message: `Landing page created for ${name}` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /sofia/preview-page — legacy single landing page preview
app.get('/sofia/preview-page', async (req, res) => {
  try {
    const { industry = 'water damage restoration', city = 'Orlando', name = 'Test Company', phone = '(407) 844-6376', email = '', formId } = req.query;
    const html = await buildLandingHTML(name, phone, email, city, industry, '', formId);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

// POST /sofia/build-website — create full 5-page website in GHL for a subaccount
app.post('/sofia/build-website', async (req, res) => {
  try {
    const { locationId, industry, city, formId } = req.body;
    if (!locationId) return res.status(400).json({ status: 'error', message: 'locationId required' });
    const locRes = await axios.get(`https://services.leadconnectorhq.com/locations/${locationId}`, {
      headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28' }, timeout: 8000,
    });
    const loc     = locRes.data?.location || locRes.data;
    const name    = loc?.name || loc?.business?.name || 'Client';
    const ind     = industry || ELENA_CLIENT_OVERRIDES[locationId]?.industry || 'business';
    const locCity = city || loc?.city || 'Orlando';
    const logo    = loc?.logoUrl || loc?.logo || '';
    const phone   = loc?.phone || loc?.business?.phone || '';
    const email   = loc?.email || loc?.business?.email || '';
    createGHLWebsite(locationId, name, ind, phone, email, locCity, logo, formId); // non-blocking
    res.json({ status: 'ok', message: `Sofia is building a 5-page website for ${name}. Check Render logs for funnelId.` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /sofia/preview-website?page=home&industry=roofing&city=Orlando&name=TestCo&phone=4071234567
// Preview any of the 5 pages directly in the browser
app.get('/sofia/preview-website', async (req, res) => {
  try {
    const {
      page = 'home', industry = 'roofing', city = 'Orlando',
      name = 'Test Company', phone = '(407) 123-4567', email = '', formId,
    } = req.query;
    const siteBase = '/sofia/preview-website';
    const pages = await buildWebsite(name, phone, email, city, industry, '', formId || GHL_FORM_ID, siteBase);
    const html = pages[page];
    if (!html) return res.status(400).send(`<pre>Unknown page "${page}". Use: home, about, services, contact, faq</pre>`);
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}\n${err.stack}</pre>`);
  }
});

// POST /sofia/build-funnel — create a lead gen funnel in GHL
// Body: { locationId, funnelType: 'consultation'|'quote'|'lead-magnet', industry?, city? }
app.post('/sofia/build-funnel', async (req, res) => {
  try {
    const { locationId, funnelType = 'consultation', industry, city, formId } = req.body;
    if (!locationId) return res.status(400).json({ status: 'error', message: 'locationId required' });
    const locRes = await axios.get(`https://services.leadconnectorhq.com/locations/${locationId}`, {
      headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28' }, timeout: 8000,
    });
    const loc     = locRes.data?.location || locRes.data;
    const name    = loc?.name || loc?.business?.name || 'Client';
    const ind     = industry || ELENA_CLIENT_OVERRIDES[locationId]?.industry || 'business';
    const locCity = city || loc?.city || 'Orlando';
    const logo    = loc?.logoUrl || loc?.logo || '';
    const phone   = loc?.phone || loc?.business?.phone || '';
    createGHLLeadFunnel(locationId, name, ind, funnelType, phone, locCity, logo, formId); // non-blocking
    res.json({ status: 'ok', message: `Sofia is building a ${funnelType} funnel for ${name}. Check Render logs for funnelId.` });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /sofia/preview-funnel?type=consultation&industry=roofing&city=Orlando&name=TestCo&phone=4071234567&step=optin
app.get('/sofia/preview-funnel', async (req, res) => {
  try {
    const {
      type = 'consultation', industry = 'roofing', city = 'Orlando',
      name = 'Test Company', phone = '(407) 123-4567', step = 'optin',
    } = req.query;
    const { optin, thankYou } = await buildLeadFunnelHTML(type, name, phone, city, industry);
    const html = step === 'thank-you' ? thankYou : optin;
    res.setHeader('Content-Type', 'text/html');
    res.send(html);
  } catch (err) {
    res.status(500).send(`<pre>Error: ${err.message}</pre>`);
  }
});

app.post('/sofia/cro-report', async (_req, res) => {
  try {
    runSofiaCROReport();
    res.json({ status: 'ok', message: 'Sofia is building the monthly CRO report' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/sofia/onboarding-check', async (_req, res) => {
  try {
    runSofiaOnboardingCheck();
    res.json({ status: 'ok', message: 'Sofia is checking for new clients' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/sofia/full-audit', async (req, res) => {
  try {
    const { url, clientName, industry } = req.body;
    if (!url) return res.status(400).json({ status: 'error', message: 'url required' });
    const audit = await runSofiaFullAudit(url, clientName || 'Client', industry || 'business');
    res.json({ status: 'ok', audit });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /sofia/competitor-report — compare a client's site against top 3 local competitors
// Body: { url, clientName, industry, city }
app.post('/sofia/competitor-report', async (req, res) => {
  try {
    const { url, clientName, industry = 'business', city = 'Orlando' } = req.body;
    if (!url || !clientName) return res.status(400).json({ status: 'error', message: 'url and clientName required' });

    const SERPAPI_KEY = process.env.SERPAPI_KEY;
    if (!SERPAPI_KEY) return res.status(503).json({ status: 'error', message: 'SERPAPI_KEY not configured' });

    // Fetch top 3 organic competitor URLs
    const serpRes = await axios.get('https://serpapi.com/search.json', {
      params: { engine: 'google', q: `${industry} ${city} FL`, hl: 'en', gl: 'us', num: 10, api_key: SERPAPI_KEY },
      timeout: 15000,
    });
    const organic = (serpRes.data?.organic_results || [])
      .map(r => r.link)
      .filter(l => l && !l.includes('yelp.com') && !l.includes('facebook.com') && !l.includes('google.com'))
      .slice(0, 3);

    // Audit client + competitors in parallel
    const [clientAudit, ...competitorAudits] = await Promise.all([
      runSofiaFullAudit(url, clientName, industry),
      ...organic.map((u, i) => runSofiaFullAudit(u, `Competitor ${i + 1}`, industry).catch(() => null)),
    ]);

    // Claude comparison summary
    const compData = competitorAudits.filter(Boolean).map((a, i) => ({
      name: `Competitor ${i + 1}`,
      url: organic[i],
      score: a.score,
      grade: a.grade,
      title: a.title,
      hasCTA: a.hasCTA,
      hasPhone: a.hasPhone,
      ssl: a.ssl,
      speed: a.responseTime,
    }));

    const avgCompScore = compData.length ? Math.round(compData.reduce((s, c) => s + c.score, 0) / compData.length) : 0;
    const clientScore  = clientAudit?.score || 0;

    let aiSummary = '';
    try {
      const aiRes = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 500,
        messages: [{ role: 'user', content: `You are Sofia, a web designer at JRZ Marketing. Compare these websites:

Client: ${clientName} — Score: ${clientScore}/100, Grade: ${clientAudit?.grade}, SSL: ${clientAudit?.ssl}, Speed: ${clientAudit?.responseTime}ms, CTA: ${clientAudit?.hasCTA}

Competitors:
${compData.map(c => `${c.name} (${c.url}): Score ${c.score}/100, Speed ${c.speed}ms, CTA ${c.hasCTA}`).join('\n')}

Write a 4-6 sentence competitive analysis for Jose (agency owner). Focus on: where client ranks, what competitors do better, and the top 3 actionable wins for ${clientName}. Be direct and specific.` }],
      });
      aiSummary = aiRes.content[0].text.trim();
    } catch { aiSummary = `${clientName} scored ${clientScore}/100 vs competitor avg of ${avgCompScore}/100.`; }

    res.json({
      status: 'ok',
      client: { name: clientName, url, score: clientScore, grade: clientAudit?.grade },
      competitors: compData,
      avgCompetitorScore: avgCompScore,
      clientVsAvg: clientScore - avgCompScore,
      analysis: aiSummary,
    });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /sofia/pagespeed?url=https://example.com — test PageSpeed API directly
app.get('/sofia/pagespeed', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: 'error', message: 'url required' });
    const data = await getPageSpeedData(url);
    if (!data) return res.status(503).json({ status: 'error', message: 'PageSpeed API unavailable or key missing' });
    res.json({ status: 'ok', url, data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// GET /sofia/search-console?url=https://example.com — test Search Console API directly
app.get('/sofia/search-console', async (req, res) => {
  try {
    const { url } = req.query;
    if (!url) return res.status(400).json({ status: 'error', message: 'url required' });
    const data = await getSearchConsoleData(url);
    if (!data) return res.status(503).json({ status: 'error', message: 'Site not verified in Search Console or OAuth not configured' });
    res.json({ status: 'ok', url, data });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

// POST /sofia/uptime-check — manual trigger for uptime monitor
app.post('/sofia/uptime-check', async (_req, res) => {
  runSofiaUptimeMonitor();
  res.json({ status: 'ok', message: 'Sofia uptime monitor running' });
});

// Manual trigger: POST /cron/client-blogs — run daily SEO blog for all SEO_CLIENTS
// Responds immediately — blog generation runs in background (60-90s per client)
app.post('/cron/client-blogs', (_req, res) => {
  res.json({ status: 'started', message: 'Blogs running in background — check GET /status for results' });
  runAllClientsDailyBlog()
    .then(r => logCron('client-blogs', 'ok', r))
    .catch(e => { logCron('client-blogs', 'error', e.message); console.error('[Client SEO] All blogs error:', e.message); });
});

// Manual trigger: POST /cron/client-blog/:locationId — run blog for one specific client
// Example: GET or POST /cron/client-blog/iipUT8kmVxJZzGBzvkZm (Railing Max)
// Responds immediately — Claude Opus takes 60-90s, would 502 if awaited on Render free plan
app.get('/cron/client-blog/:locationId', (req, res) => {
  const { locationId } = req.params;
  const config = SEO_CLIENTS[locationId];
  if (!config) return res.status(404).json({ error: `No SEO_CLIENTS entry for locationId: ${locationId}` });
  const jobKey = `blog-${config.name}`;
  res.json({ status: 'started', job: jobKey, name: config.name, note: 'Check GET /status in ~60s' });
  runCron(jobKey, () => runClientDailySeoBlog(locationId, config), true);
});
app.post('/cron/client-blog/:locationId', (req, res) => {
  const { locationId } = req.params;
  const config = SEO_CLIENTS[locationId];
  if (!config) return res.status(404).json({ error: `No SEO_CLIENTS entry for locationId: ${locationId}` });
  const jobKey = `blog-${config.name}`;
  res.json({ status: 'started', job: jobKey, name: config.name, note: 'Check GET /status in ~60s' });
  runCron(jobKey, () => runClientDailySeoBlog(locationId, config), true);
});

// GET /sofia/content-learning/status — show blog history + next recommended keyword per client
app.get('/sofia/content-learning/status', async (_req, res) => {
  try {
    const history = await loadBlogHistory();
    const status = {};
    for (const [locationId, config] of Object.entries(SEO_CLIENTS)) {
      const clientHistory = history[locationId] || [];
      status[config.name] = {
        totalPosts: clientHistory.length,
        lastPost: clientHistory.slice(-1)[0] || null,
        nextKeyword: await getBestNextKeyword(locationId, config, clientHistory),
        recentKeywords: clientHistory.slice(-5).map(p => p.keyword),
      };
    }
    res.json(status);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /cron/content-learning — generate learning report + email Jose
app.post('/cron/content-learning', async (_req, res) => {
  try {
    const result = await runSofiaContentLearning();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// POST /cron/rank-tracking — run weekly rank check now
app.post('/cron/rank-tracking', (_req, res) => {
  res.json({ status: 'started', message: 'Rank tracking running — check GET /status for results' });
  runWeeklyRankTracking()
    .then(r => logCron('rank-tracking', 'ok', r))
    .catch(e => { logCron('rank-tracking', 'error', e.message); console.error('[Rank Tracking] Manual error:', e.message); });
});

// POST /cron/gbp-posts — trigger GBP posting now for all connected clients
app.post('/cron/gbp-posts', async (_req, res) => {
  try {
    const results = await runDailyGBPPosts();
    res.json({ status: 'done', posted: results.length, results });
  } catch (e) {
    res.json({ status: 'error', error: e.message });
  }
});

// POST /cron/backlink-check — run backlink monitoring now
app.post('/cron/backlink-check', (_req, res) => {
  res.json({ status: 'started', message: 'Backlink check running — check GET /status for results' });
  runWeeklyBacklinkCheck()
    .then(r => logCron('backlink-check', 'ok', r))
    .catch(e => { logCron('backlink-check', 'error', e.message); console.error('[Backlinks] Manual error:', e.message); });
});

// POST /cron/link-prospecting — run backlink prospecting now (mines competitor links, sends pitches)
app.post('/cron/link-prospecting', (_req, res) => {
  res.json({ status: 'started', message: 'Link prospecting running — check GET /status + your email for report' });
  runBacklinkProspecting()
    .then(r => logCron('link-prospecting', 'ok', r))
    .catch(e => { logCron('link-prospecting', 'error', e.message); console.error('[LinkBuild] Manual error:', e.message); });
});

// GET /cron/link-prospects/status — show full prospect history
app.get('/cron/link-prospects/status', async (_req, res) => {
  try {
    const r = await axios.get(LINK_PROSPECTS_URL, { timeout: 8000, headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
    const snap = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    const totalContacted = Object.values(snap.contacted || {}).reduce((s, arr) => s + arr.length, 0);
    res.json({
      lastRun: snap.lastRun || 'never',
      totalOutreach: totalContacted,
      recentPitches: (snap.history || []).slice(-20),
      contactedByClient: Object.fromEntries(Object.entries(snap.contacted || {}).map(([d, arr]) => [d, arr.length]))
    });
  } catch (e) { res.json({ lastRun: 'never', totalOutreach: 0, recentPitches: [], error: e.message }); }
});

// GET or POST /cron/railing-city-pages — run next batch of Railing Max city pages
function triggerRailingPages(req, res) {
  const batchSize = parseInt(req.query.batch) || 50;
  res.json({ status: 'started', job: 'railing-city-pages', batchSize, note: 'Check GET /status or /cron/railing-city-pages/status in ~5 min' });
  runCron('railing-city-pages', () => runRailingMaxCityPagesBatch(batchSize), true);
}
app.get('/cron/railing-city-pages', triggerRailingPages);
app.post('/cron/railing-city-pages', triggerRailingPages);

// GET /cron/railing-city-pages/status — show progress
app.get('/cron/railing-city-pages/status', async (_req, res) => {
  let snap, snapError, rawPreview, statusCode;
  try {
    const r = await axios.get(CITY_PAGES_URL, { timeout: 8000, headers: { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' } });
    statusCode = r.status;
    rawPreview = JSON.stringify(r.data).slice(0, 120);
    snap = typeof r.data === 'string' ? JSON.parse(r.data) : (r.data || { published: [] });
  } catch (e) { snapError = e.message; snap = { published: [] }; }
  res.json({ published: (snap.published || []).length, total: RAILING_MAX_SERVICES.length * RAILING_MAX_CITIES.length, remaining: RAILING_MAX_SERVICES.length * RAILING_MAX_CITIES.length - (snap.published || []).length, lastPages: (snap.published || []).slice(-10), debug: snapError || null, statusCode, rawPreview });
});

// GET or POST /cron/cooney-city-pages — run next batch of Cooney Homes city pages
function triggerCooneyPages(req, res) {
  const batchSize = parseInt(req.query.batch) || 50;
  res.json({ status: 'started', job: 'cooney-city-pages', batchSize, note: 'Check GET /status or /cron/cooney-city-pages/status in ~5 min' });
  runCron('cooney-city-pages', () => runCooneyHomesCityPagesBatch(batchSize), true);
}
app.get('/cron/cooney-city-pages', triggerCooneyPages);
app.post('/cron/cooney-city-pages', triggerCooneyPages);

// GET /cron/cooney-city-pages/status — show progress
app.get('/cron/cooney-city-pages/status', async (_req, res) => {
  const snap = await loadCooneyPagesSnapshot().catch(() => ({ published: [] }));
  res.json({ published: snap.published.length, total: COONEY_SERVICES.length * COONEY_CITIES.length, remaining: COONEY_SERVICES.length * COONEY_CITIES.length - snap.published.length, lastPages: snap.published.slice(-10) });
});

// GET /cron/railing-city-pages/test — test one page and return result or error
app.get('/cron/railing-city-pages/test', async (_req, res) => {
  try {
    const result = await runRailingMaxCityPage(RAILING_MAX_SERVICES[0], RAILING_MAX_CITIES[0]);
    const snap = await loadCityPagesSnapshot();
    snap.published.push(`floating-stairs-orlando-fl`);
    await saveCloudinaryJSON(CITY_PAGES_PID, snap);
    res.json({ success: true, result });
  } catch (e) { res.json({ success: false, error: e.message, stack: e.stack?.split('\n').slice(0,5) }); }
});

// GET /cron/cooney-city-pages/test — test one page and return result or error
app.get('/cron/cooney-city-pages/test', async (_req, res) => {
  try {
    const result = await runCooneyHomeCityPage(COONEY_SERVICES[0], COONEY_CITIES[0]);
    const snap = await loadCooneyPagesSnapshot();
    snap.published.push(`custom-home-builder-orlando-fl`);
    await saveCloudinaryJSON(COONEY_CITY_PAGES_PID, snap);
    res.json({ success: true, result });
  } catch (e) { res.json({ success: false, error: e.message, stack: e.stack?.split('\n').slice(0,5) }); }
});

// Debug: GET /sofia/blogs/:locationId — check what blogs API returns for a sub-account
app.get('/sofia/blogs/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const config = SEO_CLIENTS[locationId];
  const hardcodedKeys = { 'iipUT8kmVxJZzGBzvkZm': RAILING_MAX_API_KEY, 'Gc4sUcLiRI2edddJ5Lfl': COONEY_API_KEY };
  const token = config?.apiKey || hardcodedKeys[locationId];
  if (!token) return res.json({ error: 'No apiKey for this locationId in SEO_CLIENTS' });
  try {
    const r1 = await axios.get(`https://services.leadconnectorhq.com/blogs/site/all?locationId=${locationId}&skip=0&limit=10`,
      { headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28' }, timeout: 10000 }
    ).catch(e => ({ error: e?.response?.data || e.message }));
    res.json({ blogsEndpoint: r1?.data || r1?.error });
  } catch (err) {
    res.json({ error: err?.response?.data || err.message });
  }
});

// Debug: GET /sofia/location-token/:locationId — test if agency key can get a token for a sub-account
app.get('/sofia/location-token/:locationId', async (req, res) => {
  const { locationId } = req.params;
  try {
    const tokenResp = await axios.post(
      'https://services.leadconnectorhq.com/oauth/locationToken',
      { companyId: GHL_COMPANY_ID, locationId },
      { headers: { Authorization: `Bearer ${GHL_AGENCY_KEY}`, Version: '2021-07-28', 'Content-Type': 'application/json' }, timeout: 10000 }
    );
    res.json({ success: true, hasToken: !!tokenResp.data?.access_token, raw: tokenResp.data });
  } catch (err) {
    res.json({ success: false, error: err?.response?.data || err.message });
  }
});

// Manual trigger: POST /cron/seo-blog — Isabella writes a SEO blog targeting a striking-distance keyword
app.post('/cron/seo-blog', async (_req, res) => {
  const result = await runDailySeoBlog();
  res.json(result);
});

// Manual trigger: POST /cron/keyword-tracker — Sofia checks keyword rankings vs last week
app.post('/cron/keyword-tracker', async (_req, res) => {
  const result = await runSofiaKeywordTracker();
  res.json(result);
});

// Manual trigger: POST /cron/weekly-seo — Sofia runs full weekly SEO plan
app.post('/cron/weekly-seo', async (_req, res) => {
  const result = await runSofiaWeeklySEOPlan();
  res.json(result);
});

// Test endpoint: GET /sofia/ga4?propertyId=384751711 — returns GA4 data for a property
app.get('/sofia/ga4', async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId required' });

  // Debug: check each step
  const saEmail = process.env.GOOGLE_SA_EMAIL;
  const saKey   = process.env.GOOGLE_SA_PRIVATE_KEY;
  if (!saEmail && !saKey) return res.json({ error: 'Both GOOGLE_SA_EMAIL and GOOGLE_SA_PRIVATE_KEY are missing in Render env vars' });
  if (!saEmail) return res.json({ error: 'GOOGLE_SA_EMAIL is missing' });
  if (!saKey)   return res.json({ error: 'GOOGLE_SA_PRIVATE_KEY is missing', emailFound: saEmail });

  const jwt = _buildServiceAccountJWT('https://www.googleapis.com/auth/analytics.readonly');
  if (!jwt) return res.json({ error: 'JWT failed — GOOGLE_SA_EMAIL or GOOGLE_SA_PRIVATE_KEY missing' });

  const tokenResp = await axios.post('https://oauth2.googleapis.com/token', new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  })).catch(e => ({ error: e?.response?.data || e.message }));

  if (tokenResp?.error) return res.json({ error: 'Token exchange failed', detail: tokenResp.error });

  const accessToken = tokenResp?.data?.access_token;
  if (!accessToken) return res.json({ error: 'No access token returned', raw: tokenResp?.data });

  const apiResp = await axios.post(
    `https://analyticsdata.googleapis.com/v1beta/properties/${propertyId}:runReport`,
    { dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }], metrics: [{ name: 'sessions' }] },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  ).catch(e => ({ error: e?.response?.data || e.message }));

  if (apiResp?.error) return res.json({ error: 'GA4 API call failed', detail: apiResp.error });

  const data = await getGA4Data(propertyId);
  res.json(data || { error: 'getGA4Data returned null' });
});

// Manual trigger: POST /cron/local-pack — Sofia checks if each client is in the Google 3-pack
app.post('/cron/local-pack', async (_req, res) => {
  const result = await runLocalPackMonitor();
  res.json(result);
});

// Manual trigger: POST /cron/backlink-prospector — Sofia finds guest post targets + sends outreach
app.post('/cron/backlink-prospector', async (_req, res) => {
  const result = await runSofiaBacklinkProspector();
  res.json(result);
});

// Manual trigger: POST /cron/press-release — Sofia writes + publishes monthly press release per client
app.post('/cron/press-release', async (_req, res) => {
  const result = await runSofiaPressRelease();
  res.json(result);
});

// Manual trigger: POST /cron/citation-builder — Sofia auto-submits to Bing/Foursquare + emails citation kit
app.post('/cron/citation-builder', async (_req, res) => {
  const result = await runSofiaCitationBuilder();
  res.json(result);
});

// ═══════════════════════════════════════════════════════════
// INTERNAL CRON — checks every 2 minutes
//  7:00am EST  daily      → Carousel post + blog
//  7:05am EST  daily      → Isabella: SEO blog (striking-distance keyword from GSC)
//  7:10am EST  Monday     → Weekly analytics analysis + A/B test + summary email
//  9:40am EST  Monday     → Sofia: keyword rank tracker (DataForSEO — 10 target keywords)
//  9:50am EST  Monday     → Sofia: weekly SEO plan (keyword → meta → schema → blog → gaps)
//  8:00am EST  Mon–Fri    → Diego: daily standup email
//  8:00am EST  Monday     → Competitor monitoring
//  8:35am EST  Monday     → Elena: weekly subaccount health check
//  9:00am EST  1st/month  → Monthly client reports + Elena monthly reports + Diego scorecard
//  9:00am EST  Monday     → Apollo email enrichment
// 10:00am EST  Mon–Fri    → Outbound prospecting (15 contacts/day)
// 10:30am EST  daily      → Client check-ins (30-day rolling)
//  4:00pm EST  daily      → Viral 15s Reel (7 platforms)
//  6:30pm EST  daily      → Story (Instagram + Facebook)
// ═══════════════════════════════════════════════════════════
let lastPostDate     = null;
let lastStoryDate    = null;
let lastSeoBlogDate        = null;
let lastClientBlogDate     = null;
let lastKeywordTrackerDate = null;
let lastWeeklySEODate      = null;
let lastSummaryDate        = null;
let lastOutboundDate = null;
let lastEnrichDate   = null;
let lastCheckInDate         = null;
let lastMonthlyReportDate   = null;
let lastMidMonthCheckIn     = null;
let lastQuarterlyReport     = null;
let lastCompetitorDate      = null;
let lastSubCheckInDate      = null;
let lastLearningDate        = null;
let lastElenaHealthDate     = null;
let lastDiegoReportDate     = null;
let lastDiegoStandupDate    = null;
let lastMarcoContentDate    = null;
let lastMarcoTrendDate      = null;
let lastSofiaCheckDate      = null;
let lastSofiaCRODate        = null;
let lastSofiaMonitorHour    = -1; // tracks last 6-hour slot (0, 6, 12, 18)
let lastRankTrackingDate    = null;
let lastBacklinkCheckDate   = null;
let lastStandupDate           = null;
let lastLinkProspectingDate   = null;
let lastGBPPostDate           = null;

// ─── GOOGLE BUSINESS PROFILE AUTO-POSTING ────────────────────────────────────
// Runs daily at 9:00am — fetches connected Google accounts per client,
// generates a location-specific GBP post with Claude Haiku, publishes via GHL.

async function runDailyGBPPosts() {
  console.log('[GBP] Starting daily Google Business Profile posts...');
  const results = [];

  const gbpClients = Object.entries(SEO_CLIENTS).filter(([, c]) => c.blogEnabled !== false && c.gbpEnabled !== false);

  for (const [locationId, config] of gbpClients) {
    const { name, industry, voice, author } = config;
    const token = config.apiKey;
    if (!token) continue;

    try {
      // Fetch connected Google accounts for this sub-account
      const accountsRes = await axios.get(
        `https://services.leadconnectorhq.com/social-media-posting/${locationId}/accounts`,
        { headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28' }, timeout: 10000 }
      );
      const googleAccounts = (accountsRes.data?.results?.accounts || [])
        .filter(a => a.platform === 'google' && !a.isExpired && !a.deleted);

      if (!googleAccounts.length) {
        console.log(`[GBP] No Google accounts connected for ${name} — skipping`);
        continue;
      }

      console.log(`[GBP] ${name}: ${googleAccounts.length} GBP location(s) found`);

      // Rotate post type by day of week
      const dayIdx = new Date().getDay();
      const postType = GBP_POST_TYPES[dayIdx % GBP_POST_TYPES.length];

      // Generate post for each connected GBP location
      for (const account of googleAccounts) {
        const locationName = account.name || name;

        const msg = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 300,
          messages: [{ role: 'user', content: `Write a Google Business Profile "${postType}" post for ${locationName} — a ${industry} in Central Florida.

AUTHOR: ${author?.name || name}, ${author?.title || ''}
BRAND VOICE: ${voice || 'Helpful, local, and direct.'}
POST TYPE: ${postType === 'WHATS_NEW' ? "What's New (share an update, tip, or reason to visit)" : postType === 'OFFER' ? 'Special Offer (limited time deal or promotion)' : 'Event (upcoming event or special occasion)'}

RULES:
- 150–280 characters total
- Mention a specific service, dish, or benefit
- End with a clear action ("Call us", "Book online", "Order now", "Visit us today")
- Sound like a real local business owner wrote it — no corporate speak
- NO hashtags, NO emojis unless naturally fitting

Return ONLY the post text, nothing else.` }]
        });

        const postText = msg.content[0].text.trim();

        // Publish via GHL Social Posting API — withRetry handles transient GHL errors
        const postNow = new Date();
        await withRetry(() => axios.post(
          `https://services.leadconnectorhq.com/social-media-posting/${locationId}/posts`,
          {
            accountIds: [account.id],
            summary: postText,
            type: 'post',
            userId: GHL_USER_ID,
            status: 'scheduled',
            scheduleDate: postNow.toISOString(),
            scheduleTimeUpdated: true,
            media: [],
          },
          { headers: { Authorization: `Bearer ${token}`, Version: '2021-07-28', 'Content-Type': 'application/json' }, timeout: 15000 }
        ));

        console.log(`[GBP] ✅ Posted to ${locationName} GBP: "${postText.slice(0, 60)}..."`);
        results.push({ client: name, location: locationName, text: postText });
        await new Promise(r => setTimeout(r, 2000));
      }
    } catch (e) {
      console.error(`[GBP] ❌ ${name}:`, e.message);
    }

    await new Promise(r => setTimeout(r, 3000));
  }

  console.log(`[GBP] Done — ${results.length} GBP posts published`);
  return results;
}

// ─── /health — instant deploy verification ────────────────────────────────────
app.get('/health', (_req, res) => {
  const errors = Object.values(CRON_STATUS).filter(s => s.status === 'error').length;
  res.json({
    status: 'ok',
    buildHash: BUILD_HASH,
    startedAt: SERVER_START_TIME,
    uptime: `${Math.floor(process.uptime() / 3600)}h ${Math.floor((process.uptime() % 3600) / 60)}m`,
    cronJobs: Object.keys(CRON_STATUS).length,
    errors,
  });
});

// ─── /status — live cron dashboard ───────────────────────────────────────────
app.get('/status', (_req, res) => {
  const jobs = Object.entries(CRON_STATUS).sort((a, b) => a[0].localeCompare(b[0]));
  const rows = jobs.map(([name, s]) => {
    const icon = s.status === 'ok' ? '✅' : s.status === 'error' ? '❌' : '⏳';
    const mins = s.lastRun ? Math.round((Date.now() - new Date(s.lastRun)) / 60000) : null;
    const age  = mins === null ? 'never' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`;
    const color = s.status === 'error' ? '#e74c3c' : '#2ecc71';
    return `<tr>
      <td>${icon} <strong>${name}</strong></td>
      <td style="color:#aaa">${age}</td>
      <td style="color:${color}">${s.status}</td>
      <td style="font-size:12px;color:#888;max-width:420px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${(s.detail||'').replace(/"/g,"'")}">${s.detail || ''}</td>
    </tr>`;
  }).join('');

  const errorCount = jobs.filter(([,s]) => s.status === 'error').length;
  const okCount    = jobs.filter(([,s]) => s.status === 'ok').length;
  const upStr = `${Math.floor(process.uptime()/3600)}h ${Math.floor((process.uptime()%3600)/60)}m`;

  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html><head>
<title>Armando Bot — Status</title>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Courier New',monospace;background:#0a0a0a;color:#ddd;padding:24px}
  h1{color:#fff;font-size:22px;margin-bottom:4px}
  .meta{color:#555;font-size:13px;margin-bottom:20px}
  .stats{display:flex;gap:16px;margin-bottom:24px}
  .stat{background:#111;border:1px solid #222;padding:12px 20px;border-radius:8px;text-align:center}
  .stat .n{font-size:28px;font-weight:bold;color:#fff}
  .stat .l{font-size:11px;color:#666;text-transform:uppercase;margin-top:2px}
  table{width:100%;border-collapse:collapse}
  th{text-align:left;padding:8px 14px;background:#111;color:#555;font-size:11px;text-transform:uppercase;border-bottom:1px solid #1a1a1a}
  td{padding:9px 14px;border-bottom:1px solid #141414;font-size:13px}
  tr:hover td{background:#0f0f0f}
  .empty{padding:32px;text-align:center;color:#333}
</style></head><body>
<h1>🤖 Armando Bot</h1>
<p class="meta">Build: <strong>${BUILD_HASH}</strong> &nbsp;|&nbsp; Up: <strong>${upStr}</strong> &nbsp;|&nbsp; ${new Date().toLocaleString('en-US',{timeZone:'America/New_York'})} EST</p>
<div class="stats">
  <div class="stat"><div class="n">${jobs.length}</div><div class="l">Total Jobs</div></div>
  <div class="stat"><div class="n" style="color:#2ecc71">${okCount}</div><div class="l">OK</div></div>
  <div class="stat"><div class="n" style="color:#e74c3c">${errorCount}</div><div class="l">Errors</div></div>
  <div class="stat"><div class="n" style="color:#f39c12">${jobs.length - okCount - errorCount}</div><div class="l">Pending</div></div>
</div>
<table><thead><tr><th>Job</th><th>Last Run</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>${rows || '<tr><td colspan="4" class="empty">No jobs have run yet — cron fires at scheduled times EST.</td></tr>'}</tbody></table>
</body></html>`);
});

// ─── /dashboard — JRZ Marketing client dashboard ─────────────────────────────
app.get('/dashboard', (_req, res) => {
  const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const upStr = `${Math.floor(process.uptime()/3600)}h ${Math.floor((process.uptime()%3600)/60)}m`;

  // DM stats from in-memory trackers
  const totalDMs     = repliedMessageIds.size;
  const uniqueLeads  = contactMessageCount.size;
  const hotLeads     = alertEmailSent.size;
  const qualified    = leadScoreAlertSent.size;

  // Cron health summary
  const cronJobs  = Object.entries(CRON_STATUS);
  const cronOk    = cronJobs.filter(([,s]) => s.status === 'ok').length;
  const cronErr   = cronJobs.filter(([,s]) => s.status === 'error').length;

  // Key cron rows to show on dashboard
  const KEY_CRONS = ['daily-post','daily-story','daily-seo-blog','gbp-posts','diego-standup','weekly-analysis'];
  const cronRows = KEY_CRONS.map(name => {
    const s = CRON_STATUS[name];
    if (!s) return `<tr><td>${name}</td><td style="color:#555">never run</td><td style="color:#555">—</td></tr>`;
    const mins = s.lastRun ? Math.round((Date.now() - new Date(s.lastRun)) / 60000) : null;
    const age  = mins === null ? 'never' : mins < 60 ? `${mins}m ago` : `${Math.floor(mins/60)}h ago`;
    const dot  = s.status === 'ok' ? '#2ecc71' : s.status === 'error' ? '#e74c3c' : '#f39c12';
    return `<tr>
      <td><span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${dot};margin-right:8px"></span>${name}</td>
      <td style="color:#aaa">${age}</td>
      <td style="color:${dot};font-size:12px">${s.detail ? s.detail.slice(0,80) : s.status}</td>
    </tr>`;
  }).join('');

  res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>JRZ Marketing — Dashboard</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d0d;color:#e0e0e0;padding:0}
header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:20px 32px;border-bottom:3px solid #e94560;display:flex;align-items:center;justify-content:space-between}
header h1{color:#fff;font-size:1.4rem;font-weight:700}header h1 span{color:#e94560}
.meta{color:#666;font-size:12px;margin-top:4px}
.now{color:#4ecca3;font-size:13px;background:rgba(78,204,163,0.1);padding:4px 12px;border-radius:20px;border:1px solid #4ecca3}
.main{padding:28px 32px;max-width:1100px;margin:0 auto}
.section-title{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;margin-top:28px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px;margin-bottom:8px}
.kpi{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:20px;text-align:center}
.kpi .num{font-size:2.4rem;font-weight:800;line-height:1}
.kpi .lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-top:6px}
.kpi.blue .num{color:#4ecca3}
.kpi.red .num{color:#e94560}
.kpi.orange .num{color:#f39c12}
.kpi.green .num{color:#2ecc71}
table{width:100%;border-collapse:collapse;background:#111;border-radius:10px;overflow:hidden;border:1px solid #1e1e1e}
th{text-align:left;padding:10px 16px;background:#0f0f0f;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px}
td{padding:10px 16px;border-bottom:1px solid #161616;font-size:13px}
tr:last-child td{border-bottom:none}
tr:hover td{background:#0f0f0f}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600}
.badge.ok{background:rgba(46,204,113,0.15);color:#2ecc71}
.badge.err{background:rgba(231,76,60,0.15);color:#e74c3c}
.links{display:flex;gap:10px;flex-wrap:wrap;margin-top:28px}
.link{color:#4ecca3;text-decoration:none;font-size:13px;padding:6px 16px;border:1px solid #4ecca3;border-radius:20px}
.link:hover{background:rgba(78,204,163,0.1)}
footer{padding:20px 32px;color:#333;font-size:12px;border-top:1px solid #1a1a1a;margin-top:32px}
</style></head><body>
<header>
  <div><h1>JRZ Marketing <span>·</span> AI Dashboard</h1><div class="meta">Build: ${BUILD_HASH} &nbsp;·&nbsp; Up: ${upStr}</div></div>
  <div class="now">${now} EST</div>
</header>
<div class="main">

  <div class="section-title">DM Bot — Since Last Deploy</div>
  <div class="kpi-grid">
    <div class="kpi blue"><div class="num">${totalDMs}</div><div class="lbl">DMs Handled</div></div>
    <div class="kpi"><div class="num">${uniqueLeads}</div><div class="lbl">Unique Leads</div></div>
    <div class="kpi orange"><div class="num">${hotLeads}</div><div class="lbl">Hot Leads Alerted</div></div>
    <div class="kpi red"><div class="num">${qualified}</div><div class="lbl">Score ≥ 8 Alerts</div></div>
  </div>

  <div class="section-title">System Health</div>
  <div class="kpi-grid">
    <div class="kpi green"><div class="num">${cronOk}</div><div class="lbl">Crons OK</div></div>
    <div class="kpi ${cronErr > 0 ? 'red' : 'green'}"><div class="num">${cronErr}</div><div class="lbl">Cron Errors</div></div>
    <div class="kpi"><div class="num">${cronJobs.length}</div><div class="lbl">Total Jobs</div></div>
  </div>

  <div class="section-title">Key Automations</div>
  <table>
    <thead><tr><th>Job</th><th>Last Run</th><th>Status / Detail</th></tr></thead>
    <tbody>${cronRows}</tbody>
  </table>

  <div class="links">
    <a class="link" href="/status">Full Cron Status</a>
    <a class="link" href="/health">Health JSON</a>
    <a class="link" href="/social/status">Social Status</a>
    <a class="link" href="/office">AI Office</a>
  </div>
</div>
<footer>JRZ Marketing · Armando Bot · Orlando, FL</footer>
</body></html>`);
});

// ─── /client/:locationId — Live client portal ────────────────────────────────
// Auth: ?key=<apiKey> must match the client's GHL API key
// Shows: recent posts, DM bot status, upcoming scheduled posts
app.get('/client/:locationId', async (req, res) => {
  const { locationId } = req.params;
  const { key } = req.query;

  if (!key) {
    return res.status(401).set('Content-Type', 'text/html').send(`
      <html><body style="font-family:sans-serif;background:#0d0d0d;color:#e0e0e0;padding:40px;text-align:center">
        <h2 style="color:#e94560">Access Denied</h2>
        <p>Add your API key: <code>/client/${locationId}?key=YOUR_API_KEY</code></p>
      </body></html>`);
  }

  try {
    const headers = { Authorization: `Bearer ${key}`, Version: '2021-07-28' };

    // Fetch location info + recent posts in parallel
    const [locationRes, postsRes] = await Promise.all([
      axios.get(`https://services.leadconnectorhq.com/locations/${locationId}`, { headers, timeout: 10000 }).catch(() => null),
      axios.get(`https://services.leadconnectorhq.com/social-media-posting/${locationId}/posts`, {
        params: { skip: 0, limit: 10, status: 'published' }, headers, timeout: 10000,
      }).catch(() => null),
    ]);

    if (!locationRes) {
      return res.status(403).set('Content-Type', 'text/html').send(`
        <html><body style="font-family:sans-serif;background:#0d0d0d;color:#e0e0e0;padding:40px;text-align:center">
          <h2 style="color:#e94560">Invalid credentials</h2>
          <p>Check your locationId and API key.</p>
        </body></html>`);
    }

    const location = locationRes.data?.location || locationRes.data || {};
    const posts    = postsRes?.data?.posts || postsRes?.data?.data || [];

    // Check if this location has a persona bot active
    const persona   = getPersona(locationId);
    const botStatus = persona ? `Active — ${persona.name} is handling DMs` : 'Not activated yet';
    const botColor  = persona ? '#2ecc71' : '#f39c12';

    const postRows = posts.slice(0, 8).map(p => {
      const date    = p.publishedAt || p.scheduledAt || p.createdAt || '';
      const caption = (p.caption || p.description || '').slice(0, 120);
      const e       = p.engagement || p.analytics || {};
      const eng     = [
        e.likes || e.likeCount ? `❤️ ${e.likes || e.likeCount}` : '',
        e.comments || e.commentCount ? `💬 ${e.comments || e.commentCount}` : '',
        e.shares || e.shareCount ? `🔄 ${e.shares || e.shareCount}` : '',
      ].filter(Boolean).join('  ') || '—';
      const dateStr = date ? new Date(date).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—';
      return `<tr>
        <td style="color:#aaa;font-size:12px;white-space:nowrap">${dateStr}</td>
        <td style="font-size:13px">${caption}${caption.length >= 120 ? '…' : ''}</td>
        <td style="font-size:12px;white-space:nowrap">${eng}</td>
      </tr>`;
    }).join('') || `<tr><td colspan="3" style="color:#555;padding:20px;text-align:center">No published posts yet</td></tr>`;

    const now = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });

    res.set('Content-Type', 'text/html').send(`<!DOCTYPE html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${location.name || locationId} — Client Portal</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0d0d0d;color:#e0e0e0}
header{background:linear-gradient(135deg,#1a1a2e,#16213e);padding:20px 32px;border-bottom:3px solid #e94560;display:flex;align-items:center;justify-content:space-between}
header h1{color:#fff;font-size:1.3rem;font-weight:700}
.sub{color:#aaa;font-size:12px;margin-top:3px}
.now{color:#4ecca3;font-size:12px;padding:4px 12px;border:1px solid #4ecca3;border-radius:20px}
.main{padding:28px 32px;max-width:960px;margin:0 auto}
.section-title{color:#888;font-size:11px;text-transform:uppercase;letter-spacing:2px;margin-bottom:14px;margin-top:28px}
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:16px}
.kpi{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:20px;text-align:center}
.kpi .num{font-size:2rem;font-weight:800}
.kpi .lbl{font-size:11px;color:#666;text-transform:uppercase;letter-spacing:1px;margin-top:6px}
.bot-status{background:#111;border:1px solid #1e1e1e;border-radius:12px;padding:16px 20px;margin-top:16px;display:flex;align-items:center;gap:12px}
.dot{width:10px;height:10px;border-radius:50%;flex-shrink:0}
table{width:100%;border-collapse:collapse;background:#111;border-radius:10px;overflow:hidden;border:1px solid #1e1e1e;margin-top:0}
th{text-align:left;padding:10px 16px;background:#0f0f0f;color:#555;font-size:11px;text-transform:uppercase;letter-spacing:1px}
td{padding:9px 16px;border-bottom:1px solid #161616;vertical-align:top}
tr:last-child td{border-bottom:none}
footer{padding:20px 32px;color:#333;font-size:12px;border-top:1px solid #1a1a1a;margin-top:32px}
</style></head><body>
<header>
  <div>
    <h1>${location.name || 'Client Portal'}</h1>
    <div class="sub">Powered by JRZ Marketing · Orlando, FL</div>
  </div>
  <div class="now">${now} EST</div>
</header>
<div class="main">

  <div class="section-title">Automation Status</div>
  <div class="bot-status">
    <div class="dot" style="background:${botColor}"></div>
    <div>
      <strong style="font-size:14px">DM Bot:</strong>
      <span style="color:${botColor};margin-left:8px">${botStatus}</span>
    </div>
  </div>

  <div class="section-title" style="margin-top:24px">Recent Posts</div>
  <table>
    <thead><tr><th>Date</th><th>Caption</th><th>Engagement</th></tr></thead>
    <tbody>${postRows}</tbody>
  </table>

</div>
<footer>JRZ Marketing · jrzmarketing.com · info@jrzmarketing.com</footer>
</body></html>`);

  } catch (err) {
    console.error('[ClientPortal] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

setInterval(async () => {
  try {
    const nowEST      = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const today       = nowEST.toISOString().split('T')[0];
    const hour        = nowEST.getHours();
    const minute      = nowEST.getMinutes();
    const dayOfWeek   = nowEST.getDay();
    const isWeekday   = dayOfWeek >= 1 && dayOfWeek <= 5;
    const dateOfMonth = nowEST.getDate();

    // 9:00am Mon–Fri — Google Business Profile posts
    if (hour === 9 && minute >= 0 && minute < 5 && isWeekday && lastGBPPostDate !== today) {
      lastGBPPostDate = today;
      runCron('gbp-posts', runDailyGBPPosts, true);
    }

    // 6:50am daily — AI team standup
    if (hour === 6 && minute >= 50 && minute < 55 && lastStandupDate !== today) {
      lastStandupDate = today;
      runCron('standup', runDailyTeamStandup, true);
    }

    // 7:00am daily — carousel + blog
    if (hour === 7 && minute < 5 && lastPostDate !== today) {
      lastPostDate = today;
      await runCron('daily-post', runDailyPost);
    }

    // 7:05am daily — SEO blog (striking-distance keywords)
    if (hour === 7 && minute >= 5 && minute < 10 && lastSeoBlogDate !== today) {
      lastSeoBlogDate = today;
      runCron('seo-blog', runDailySeoBlog, true);
    }

    // 7:08am daily — all SEO clients: one blog post each
    if (hour === 7 && minute >= 8 && minute < 13 && lastClientBlogDate !== today) {
      lastClientBlogDate = today;
      runCron('client-blogs', runAllClientsDailyBlog, true);
    }


    // 7:10am Monday — weekly analytics + A/B test + summary email
    if (hour === 7 && minute >= 10 && minute < 15 && dayOfWeek === 1 && lastSummaryDate !== today) {
      lastSummaryDate = today;
      await runCron('weekly-summary', async () => {
        await runWeeklyAnalysis();
        await runABTestAnalysis();
        const days = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
        const weekPosts = CAROUSEL_SCRIPTS.slice(0, 7).map((s, i) => ({ day: days[i], title: s.title, success: true }));
        await sendWeeklySummaryEmail(weekPosts);
      });
    }

    // 8:00am Mon–Fri — Diego standup
    if (hour === 8 && minute < 5 && isWeekday && lastDiegoStandupDate !== today) {
      lastDiegoStandupDate = today;
      runCron('diego-standup', runDiegoStandup, true);
    }

    // 8:00am Monday — competitor monitoring
    if (hour === 8 && minute < 5 && dayOfWeek === 1 && lastCompetitorDate !== today) {
      lastCompetitorDate = today;
      await runCron('competitor-monitoring', runCompetitorMonitoring);
    }

    // 8:30am Monday — engagement learning + voice patterns + review mining
    if (hour === 8 && minute >= 30 && minute < 35 && dayOfWeek === 1 && lastLearningDate !== today) {
      lastLearningDate = today;
      await runCron('engagement-learning', async () => {
        await runEngagementLearning();
        await updateWinningVoicePatterns();
        await runReviewMining();
        await runObjectionLearning();
        await runSelfUpdateRules();
      });
    }

    // 8:35am Monday — Elena health check
    if (hour === 8 && minute >= 35 && minute < 40 && dayOfWeek === 1 && lastElenaHealthDate !== today) {
      lastElenaHealthDate = today;
      runCron('elena-health', elenaHealthCheck, true);
    }

    // 9:00am Monday — Apollo email enrichment
    if (hour === 9 && minute < 5 && dayOfWeek === 1 && lastEnrichDate !== today) {
      lastEnrichDate = today;
      await runCron('enrich-prospects', enrichProspectEmails);
    }

    // 9:05am Monday — rank tracking
    if (hour === 9 && minute >= 5 && minute < 10 && dayOfWeek === 1 && lastRankTrackingDate !== today) {
      lastRankTrackingDate = today;
      runCron('rank-tracking', runWeeklyRankTracking, true);
    }

    // 9:10am Monday — backlink monitoring
    if (hour === 9 && minute >= 10 && minute < 15 && dayOfWeek === 1 && lastBacklinkCheckDate !== today) {
      lastBacklinkCheckDate = today;
      runCron('backlink-check', runWeeklyBacklinkCheck, true);
    }

    // 9:15am Monday — Diego weekly report
    if (hour === 9 && minute >= 15 && minute < 20 && dayOfWeek === 1 && lastDiegoReportDate !== today) {
      lastDiegoReportDate = today;
      runCron('diego-weekly-report', runDiegoWeeklyReport, true);
    }

    // 9:20am Monday — backlink prospecting
    if (hour === 9 && minute >= 20 && minute < 25 && dayOfWeek === 1 && lastLinkProspectingDate !== today) {
      lastLinkProspectingDate = today;
      runCron('link-prospecting', runBacklinkProspecting, true);
    }

    // 9:30am Monday — Marco content brief
    if (hour === 9 && minute >= 30 && minute < 35 && dayOfWeek === 1 && lastMarcoContentDate !== today) {
      lastMarcoContentDate = today;
      runCron('marco-content-brief', runMarcoContentBrief, true);
    }

    // 9:40am Monday — Sofia keyword tracker
    if (hour === 9 && minute >= 40 && minute < 45 && dayOfWeek === 1 && lastKeywordTrackerDate !== today) {
      lastKeywordTrackerDate = today;
      runCron('keyword-tracker', runSofiaKeywordTracker, true);
    }

    // 9:45am Monday — Sofia weekly check + onboarding
    if (hour === 9 && minute >= 45 && minute < 50 && dayOfWeek === 1 && lastSofiaCheckDate !== today) {
      lastSofiaCheckDate = today;
      runCron('sofia-weekly-check',   runSofiaWeeklyCheck,    true);
      runCron('sofia-onboarding',     runSofiaOnboardingCheck, true);
    }

    // 9:50am Monday — Sofia weekly SEO plan
    if (hour === 9 && minute >= 50 && minute < 55 && dayOfWeek === 1 && lastWeeklySEODate !== today) {
      lastWeeklySEODate = today;
      runCron('weekly-seo-plan', runSofiaWeeklySEOPlan, true);
    }

    // Every 6 hours (0/6/12/18) — Sofia uptime monitor
    const sixHourSlot = Math.floor(hour / 6);
    if (minute < 3 && sixHourSlot !== lastSofiaMonitorHour) {
      lastSofiaMonitorHour = sixHourSlot;
      runCron('uptime-monitor', runSofiaUptimeMonitor, true);
    }

    // 1st of month, 9:55am — Sofia CRO report
    if (hour === 9 && minute >= 55 && dateOfMonth === 1 && lastSofiaCRODate !== today) {
      lastSofiaCRODate = today;
      runCron('sofia-cro-report', runSofiaCROReport, true);
    }

    // 1st of month, 9:00am — monthly reports + Elena + Diego scorecard + SEO progress
    if (hour === 9 && minute < 5 && dateOfMonth === 1 && lastMonthlyReportDate !== today) {
      lastMonthlyReportDate = today;
      await runCron('monthly-reports', async () => {
        await sendMonthlyClientReports();
        elenaMonthlyReports();
        runDiegoScorecard();
        (async () => {
          const clients = await getElenaClients();
          for (const client of clients) {
            const bl  = await runSofiaBacklinkAudit(client.website?.replace(/^https?:\/\//, '') || '').catch(() => null);
            const cit = await runSofiaCitationAudit(client.name).catch(() => null);
            const seoConfig = SEO_CLIENTS[client.locationId] || {};
            const ga4 = seoConfig.ga4PropertyId ? await getGA4Data(seoConfig.ga4PropertyId).catch(() => null) : null;
            await sendClientSEOProgressReport(client, { keyword: 'your top local keyword', position: null, blogsThisMonth: 4, backlinks: bl, citations: cit, competitorGaps: [], ga4 });
            await new Promise(r => setTimeout(r, 3000));
          }
        })();
      });
    }

    // 15th of month, 10:00am — Elena mid-month check-in
    if (hour === 10 && minute < 5 && dateOfMonth === 15 && lastMidMonthCheckIn !== today) {
      lastMidMonthCheckIn = today;
      runCron('elena-midmonth', elenaMidMonthCheckIn, true);
    }

    // 1st of Jan/Apr/Jul/Oct, 9:30am — Elena quarterly report
    const isQuarterStart = [1, 4, 7, 10].includes(nowEST.getMonth() + 1) && dateOfMonth === 1;
    if (hour === 9 && minute >= 30 && minute < 35 && isQuarterStart && lastQuarterlyReport !== today) {
      lastQuarterlyReport = today;
      runCron('elena-quarterly', elenaQuarterlyReport, true);
    }

    // Last Friday of month, 10:00am — sub-account check-in emails
    const isFriday    = dayOfWeek === 5;
    const isLastFriday = isFriday && (dateOfMonth + 7 > new Date(nowEST.getFullYear(), nowEST.getMonth() + 1, 0).getDate());
    if (hour === 10 && minute < 5 && isLastFriday && lastSubCheckInDate !== today) {
      lastSubCheckInDate = today;
      await runCron('subaccount-checkin', sendSubAccountCheckInEmails);
    }

    // 10:00am Wednesday — Marco trend alert
    if (hour === 10 && minute < 5 && dayOfWeek === 3 && lastMarcoTrendDate !== today) {
      lastMarcoTrendDate = today;
      runCron('marco-trend-alert', runMarcoTrendAlert, true);
    }

    // 10:00am Mon–Fri — outbound prospecting
    if (hour === 10 && minute < 5 && isWeekday && lastOutboundDate !== today) {
      lastOutboundDate = today;
      await runCron('daily-outbound', runDailyOutbound);
    }

    // 10:30am daily — client check-ins
    if (hour === 10 && minute >= 30 && minute < 35 && lastCheckInDate !== today) {
      lastCheckInDate = today;
      await runCron('client-checkins', runClientCheckIns);
    }

    // 6:30pm daily — story
    if (hour === 18 && minute >= 30 && minute < 35 && lastStoryDate !== today) {
      lastStoryDate = today;
      await runCron('daily-story', runDailyStory);
    }

    // Every 2 min — Gmail inbox check
    await runCron('gmail-check', runGmailCheck);

  } catch (err) {
    console.error('[Cron] Internal scheduler error:', err.message);
    logCron('_scheduler', 'error', err.message);
  }
}, 2 * 60 * 1000); // Every 2 minutes

// ═══════════════════════════════════════════════════════════
// AUTHOR PAGES — branded bio pages for each client's blogger
// ═══════════════════════════════════════════════════════════

const AUTHOR_SLUGS = {
  'railing-max':        'iipUT8kmVxJZzGBzvkZm',
  'escobar-kitchen':    'rJKRuyayc6Z6twr9X20v',
  'rental-spaces':      '6FdG0APBuZ81P8X2H4zc',
  'guaca-mole':         'Emg5M7GZE7XmnHc7F5vy',
  'jrz-marketing':      'd7iUPfamAaPlSBNj6IhT',
  'cooney-homes':       'Gc4sUcLiRI2edddJ5Lfl',
  'le-varon':           'OpdBPAp31zItOc5IIykL',
  'usa-latino-cpa':     'VWHZW08b0skUV7wcnG55',
};

function buildAuthorPageHTML(client) {
  const a = client.author || {};
  const b = client.brand || {};
  const primary   = b.primary || '#1a1a1a';
  const accent    = b.accent  || primary;
  const fontImport = b.fontImport || "https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&display=swap";
  const fontDisplay = b.fontDisplay || 'Inter';
  const fontBody   = b.fontBody   || 'Inter';
  const logoUrl    = b.logoUrl    || '';
  const phone      = b.phone      || '';
  const stats      = b.stats      || [];
  const trust      = b.trustBadges || [];

  const authorName  = a.name        || 'Our Expert';
  const authorTitle = a.title       || '';
  const authorCreds = a.credentials || '';
  const authorBio   = a.bio         || '';

  const articlesUrl = `https://${client.domain}/blog`;
  const cta = client.cta || `Learn more at ${client.domain}`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${authorName} — ${client.name}</title>
<meta name="description" content="${authorTitle}. ${authorCreds.slice(0,160)}">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="${fontImport}" rel="stylesheet">
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: '${fontBody}', sans-serif; background: #f9f9f9; color: #1a1a1a; }

.hero {
  background: ${primary};
  color: #fff;
  padding: 64px 24px 80px;
  text-align: center;
}
.hero-logo { max-height: 48px; margin-bottom: 32px; opacity: 0.95; }
.avatar-ring {
  width: 120px; height: 120px;
  border-radius: 50%;
  border: 4px solid ${accent};
  background: rgba(255,255,255,0.15);
  display: flex; align-items: center; justify-content: center;
  margin: 0 auto 24px;
  font-family: '${fontDisplay}', sans-serif;
  font-size: 48px;
  font-weight: 700;
  color: #fff;
  letter-spacing: 2px;
}
.author-name {
  font-family: '${fontDisplay}', sans-serif;
  font-size: clamp(28px, 5vw, 44px);
  font-weight: 700;
  letter-spacing: 1px;
  margin-bottom: 8px;
}
.author-title {
  font-size: 15px;
  opacity: 0.85;
  font-weight: 400;
  max-width: 520px;
  margin: 0 auto;
  line-height: 1.5;
}

.card-section {
  max-width: 780px;
  margin: -40px auto 0;
  padding: 0 20px 64px;
}
.card {
  background: #fff;
  border-radius: 16px;
  padding: 40px 40px;
  box-shadow: 0 4px 32px rgba(0,0,0,0.08);
  margin-bottom: 24px;
}
.card h2 {
  font-family: '${fontDisplay}', sans-serif;
  font-size: 13px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: ${accent};
  margin-bottom: 16px;
  font-weight: 700;
}
.card p {
  font-size: 16px;
  line-height: 1.75;
  color: #333;
}
.creds {
  background: ${primary}0D;
  border-left: 3px solid ${accent};
  padding: 16px 20px;
  border-radius: 0 8px 8px 0;
  font-size: 15px;
  line-height: 1.7;
  color: #222;
}

.stats-row {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
  gap: 16px;
  margin-bottom: 24px;
}
.stat-box {
  background: ${primary};
  color: #fff;
  border-radius: 12px;
  padding: 20px 16px;
  text-align: center;
}
.stat-box .num {
  font-family: '${fontDisplay}', sans-serif;
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 4px;
}
.stat-box .lbl { font-size: 12px; opacity: 0.8; }

.trust-row {
  display: flex; flex-wrap: wrap; gap: 10px;
}
.badge {
  background: #f0f0f0;
  border-radius: 100px;
  padding: 6px 16px;
  font-size: 13px;
  font-weight: 500;
  color: #333;
}
.badge::before { content: '✓  '; color: ${accent}; font-weight: 700; }

.cta-card {
  background: ${primary};
  color: #fff;
  border-radius: 16px;
  padding: 40px;
  text-align: center;
}
.cta-card h3 {
  font-family: '${fontDisplay}', sans-serif;
  font-size: 24px;
  font-weight: 700;
  margin-bottom: 12px;
}
.cta-card p { font-size: 15px; opacity: 0.85; margin-bottom: 24px; }
.cta-btn {
  display: inline-block;
  background: ${accent};
  color: #fff;
  font-weight: 700;
  font-size: 15px;
  padding: 14px 32px;
  border-radius: 8px;
  text-decoration: none;
}
${phone ? `.phone-link { display:inline-block; margin-top:12px; color:#fff; opacity:0.85; font-size:14px; text-decoration:none; }` : ''}

@media (max-width: 600px) {
  .card { padding: 28px 24px; }
  .hero { padding: 48px 20px 72px; }
}
</style>
</head>
<body>

<div class="hero">
  ${logoUrl ? `<img src="${logoUrl}" alt="${client.name}" class="hero-logo">` : ''}
  <div class="avatar-ring">${authorName.charAt(0)}</div>
  <div class="author-name">${authorName}</div>
  <div class="author-title">${authorTitle}</div>
</div>

<div class="card-section">

  ${stats.length ? `
  <div class="stats-row">
    ${stats.map(s => {
      const parts = s.match(/^([^A-Za-z]+)?(.*)$/) || [, '', s];
      return `<div class="stat-box"><div class="num">${s}</div></div>`;
    }).join('')}
  </div>` : ''}

  <div class="card">
    <h2>About ${authorName}</h2>
    <p>${authorBio}</p>
  </div>

  ${authorCreds ? `
  <div class="card">
    <h2>Credentials & Experience</h2>
    <div class="creds">${authorCreds}</div>
  </div>` : ''}

  ${trust.length ? `
  <div class="card">
    <h2>Why ${client.name}</h2>
    <div class="trust-row">
      ${trust.map(t => `<span class="badge">${t}</span>`).join('')}
    </div>
  </div>` : ''}

  <div class="cta-card">
    <h3>Read Articles by ${authorName.split(' ')[0]}</h3>
    <p>${cta}</p>
    <a href="https://${client.domain}" class="cta-btn">Visit ${client.name}</a>
    ${phone ? `<br><a href="tel:${phone.replace(/\D/g,'')}" class="phone-link">${phone}</a>` : ''}
  </div>

</div>
</body>
</html>`;
}

// GET /author/:slug — branded author page for any SEO client
app.get('/author/:slug', (req, res) => {
  const locationId = AUTHOR_SLUGS[req.params.slug];
  if (!locationId) {
    return res.status(404).send('<h1>Author not found</h1><p>Valid paths: /authors</p>');
  }
  const client = SEO_CLIENTS[locationId];
  if (!client || !client.author) {
    return res.status(404).send('<h1>No author configured for this client</h1>');
  }
  res.setHeader('Content-Type', 'text/html');
  res.send(buildAuthorPageHTML(client));
});

// GET /authors — index of all author pages
app.get('/authors', (_req, res) => {
  res.setHeader('Content-Type', 'text/html');
  const rows = Object.entries(AUTHOR_SLUGS).map(([slug, locId]) => {
    const c = SEO_CLIENTS[locId];
    if (!c) return '';
    const a = c.author || {};
    return `<tr>
      <td><strong>${a.name || '—'}</strong></td>
      <td>${c.name}</td>
      <td><a href="/author/${slug}">/author/${slug}</a></td>
    </tr>`;
  }).join('');
  res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Author Index</title>
  <style>body{font-family:system-ui,sans-serif;padding:40px;max-width:800px;margin:0 auto}
  table{width:100%;border-collapse:collapse}td,th{padding:12px;border-bottom:1px solid #eee;text-align:left}
  th{background:#f5f5f5;font-size:12px;text-transform:uppercase;letter-spacing:1px}
  a{color:#37ca37}</style></head><body>
  <h1 style="margin-bottom:24px">JRZ Marketing — Author Pages</h1>
  <table><thead><tr><th>Author</th><th>Client</th><th>Page URL</th></tr></thead>
  <tbody>${rows}</tbody></table></body></html>`);
});

// ═══════════════════════════════════════════════════════════
// GOOGLE ADS — LIVE PERFORMANCE ENDPOINT v2
// GET /google-ads/stats?customerId=5192590797&campaignIds=22447873137,23772794832&period=LAST_30_DAYS
// Returns: clicks, impressions, calls, cost, conversions per campaign + daily breakdown
// ═══════════════════════════════════════════════════════════

const GOOGLE_ADS_DEV_TOKEN = process.env.GOOGLE_ADS_DEV_TOKEN || 'saVkv7v1x6X9dsnDyPVCYg';
const GOOGLE_ADS_API_VERSION = 'v20';

async function runGoogleAdsQuery(customerId, query) {
  const token = await getGoogleAccessToken();
  if (!token) throw new Error('Google OAuth token unavailable — check GOOGLE_REFRESH_TOKEN env var');

  const url = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}/customers/${customerId}/googleAds:search`;
  const res = await axios.post(
    url,
    { query },
    {
      headers: {
        Authorization:      `Bearer ${token}`,
        'developer-token':  GOOGLE_ADS_DEV_TOKEN,
        'Content-Type':     'application/json',
      },
      timeout: 20000,
    }
  );
  return res.data;
}

app.get('/google-ads/stats', async (req, res) => {
  try {
    const customerId  = req.query.customerId  || '5192590797';
    const period      = req.query.period      || 'LAST_30_DAYS';
    const campaignIds = req.query.campaignIds || '22447873137,23772794832';
    const idList      = campaignIds.split(',').map(s => s.trim()).join(', ');

    // ── Campaign Summary ──────────────────────────────────────────────────────
    const campaignData = await runGoogleAdsQuery(customerId, `
      SELECT
        campaign.id,
        campaign.name,
        campaign.status,
        metrics.clicks,
        metrics.impressions,
        metrics.cost_micros,
        metrics.conversions,
        metrics.all_conversions,
        metrics.phone_calls,
        metrics.phone_impressions,
        metrics.ctr,
        metrics.average_cpc
      FROM campaign
      WHERE segments.date DURING ${period}
        AND campaign.id IN (${idList})
      ORDER BY metrics.clicks DESC
    `);

    // ── Daily Breakdown (last 7 days) ──────────────────────────────────────────
    const dailyData = await runGoogleAdsQuery(customerId, `
      SELECT
        segments.date,
        campaign.name,
        metrics.clicks,
        metrics.phone_calls,
        metrics.impressions,
        metrics.cost_micros
      FROM campaign
      WHERE segments.date DURING LAST_7_DAYS
        AND campaign.id IN (${idList})
      ORDER BY segments.date DESC
    `);

    // ── Parse campaigns ────────────────────────────────────────────────────────
    const campaigns   = [];
    let totalClicks   = 0;
    let totalImpress  = 0;
    let totalCost     = 0;
    let totalCalls    = 0;
    let totalConv     = 0;

    for (const row of (campaignData.results || [])) {
      const m     = row.metrics || {};
      const c     = row.campaign || {};
      const clicks = parseInt(m.clicks || 0);
      const impr   = parseInt(m.impressions || 0);
      const cost   = parseInt(m.costMicros || 0) / 1_000_000;
      const calls  = parseInt(m.phoneCalls || 0);
      const conv   = parseFloat(m.conversions || 0);

      totalClicks  += clicks;
      totalImpress += impr;
      totalCost    += cost;
      totalCalls   += calls;
      totalConv    += conv;

      campaigns.push({
        id:          c.id,
        name:        c.name,
        status:      c.status,
        clicks,
        impressions: impr,
        ctr:         impr > 0 ? ((clicks / impr) * 100).toFixed(2) + '%' : '0%',
        avgCpc:      '$' + (clicks > 0 ? (cost / clicks).toFixed(2) : '0.00'),
        cost:        '$' + cost.toFixed(2),
        calls,
        conversions: conv,
      });
    }

    // ── Parse daily ───────────────────────────────────────────────────────────
    const dailyMap = {};
    for (const row of (dailyData.results || [])) {
      const date   = row.segments?.date || '?';
      const clicks = parseInt(row.metrics?.clicks || 0);
      const calls  = parseInt(row.metrics?.phoneCalls || 0);
      const cost   = parseInt(row.metrics?.costMicros || 0) / 1_000_000;
      if (!dailyMap[date]) dailyMap[date] = { clicks: 0, calls: 0, cost: 0 };
      dailyMap[date].clicks += clicks;
      dailyMap[date].calls  += calls;
      dailyMap[date].cost   += cost;
    }
    const daily = Object.entries(dailyMap)
      .sort(([a], [b]) => b.localeCompare(a))
      .map(([date, d]) => ({ date, clicks: d.clicks, calls: d.calls, cost: '$' + d.cost.toFixed(2) }));

    const weekCalls  = daily.reduce((s, d) => s + d.calls, 0);
    const budgetAlert = weekCalls >= 5
      ? '✅ 5+ calls/week — ELIGIBLE to raise budget to $35/day'
      : `⏳ ${weekCalls} calls this week — Hold at $20/day (need 5+ to raise)`;

    res.json({
      status:    'ok',
      client:    'Le Varon Barbershop',
      customerId,
      period,
      pulledAt:  new Date().toISOString(),
      totals: {
        clicks:      totalClicks,
        impressions: totalImpress,
        ctr:         totalImpress > 0 ? ((totalClicks / totalImpress) * 100).toFixed(2) + '%' : '0%',
        cost:        '$' + totalCost.toFixed(2),
        calls:       totalCalls,
        conversions: totalConv,
      },
      campaigns,
      last7Days:  daily,
      budgetRule: budgetAlert,
      note:       'Booking form tags still PENDING — website access needed for full conversion tracking',
    });

  } catch (err) {
    const detail = err.response?.data || err.message;
    console.error('[GoogleAds] Stats error:', detail);
    res.status(500).json({ status: 'error', message: err.message, detail });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Armando Rivas is online — JRZ Marketing 🇻🇪`);
  console.log(`7:00am  EST daily     → Carousel + Blog`);
  console.log(`7:05am  EST Monday    → Weekly analytics self-learning + email`);
  console.log(`10:00am EST Mon-Fri   → Outbound prospecting (15 contacts/day)`);
  console.log(`4:00pm  EST Mon/Wed/Fri → 15s Viral Reel w/ voice (7 platforms, ~12/month)`);
  console.log(`6:30pm  EST daily     → Story (Instagram + Facebook)`);
  console.log(`24/7                  → Armando warm DMs on comments/follows`);
  await loadOfficeKPI(); // restore KPIs from Cloudinary on every startup
  await loadDMState();  // restore DM dedup sets so Armando remembers conversations

  // ── Real-time cron failure alerts ─────────────────────────────────────────
  // Any runCron() that throws will DM Jose immediately via GHL
  setCronErrorHandler(async (cronName, errorMessage) => {
    const time = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit' });
    const msg  = `🚨 Cron failed: [${cronName}] at ${time} EST\n\n${errorMessage.slice(0, 300)}`;
    try {
      await axios.post(
        'https://services.leadconnectorhq.com/conversations/messages',
        { type: 'SMS', contactId: OWNER_CONTACT_ID, message: msg },
        { headers: { Authorization: `Bearer ${GHL_API_KEY}`, Version: '2021-04-15', 'Content-Type': 'application/json' } }
      );
      console.log(`[CronAlert] Sent failure alert for [${cronName}] to Jose`);
    } catch (e) {
      console.error('[CronAlert] Failed to send alert:', e.message);
    }
  });
});

// Save KPIs every 30 minutes so restarts lose at most 30 min of counts
setInterval(saveOfficeKPI, 30 * 60 * 1000);

// Save DM state every 5 minutes — Armando remembers conversations across restarts
setInterval(saveDMState, 5 * 60 * 1000);

// Save KPIs + DM state on graceful shutdown (Render sends SIGTERM before restarting)
process.on('SIGTERM', async () => {
  console.log('[Office] SIGTERM received — saving state before shutdown...');
  await Promise.all([saveOfficeKPI(), saveDMState()]);
  process.exit(0);
});
