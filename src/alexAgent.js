const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { sendWhatsAppMeta } = require('./metaSender');

const client = new Anthropic();

// ── Sesiones en memoria (historial + estado de notificación) ──
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { messages: [], leadNotified: false, lastLead: null, followUpSent: false });
  }
  return sessions.get(phone);
}

// ── Follow-up automático (20 min sin respuesta → 1 mensaje) ──
const followUpTimers = {};
const FOLLOW_UP_MS = 20 * 60 * 1000;

function cancelFollowUp(phone) {
  if (followUpTimers[phone]) {
    clearTimeout(followUpTimers[phone]);
    delete followUpTimers[phone];
  }
}

function scheduleFollowUp(phone, session, leadId) {
  cancelFollowUp(phone);
  if (session.followUpSent || session.leadNotified) return;

  followUpTimers[phone] = setTimeout(async () => {
    delete followUpTimers[phone];
    if (session.followUpSent || session.leadNotified) return;
    session.followUpSent = true;

    const equipo = session.lastLead?.equipo;
    const msg = equipo
      ? `Hola, ¿te quedó alguna duda sobre ${equipo}? 😊`
      : 'Hola, ¿pudiste ver mi mensaje? 😊 Cualquier pregunta sobre la maquinaria estoy aquí para ayudarte';

    try {
      await sendWhatsAppMeta(phone, msg);
      await pool.query(
        `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'ai_agent', $2)`,
        [leadId, msg]
      );
      session.messages.push({ role: 'assistant', content: msg });
      console.log(`[alexAgent] follow-up enviado → ${phone}`);
    } catch (err) {
      console.error('[alexAgent] follow-up send error:', err.message);
    }
  }, FOLLOW_UP_MS);
}

// ── Debounce (buffer de mensajes por número) ──
const phoneState = new Map();
const DEBOUNCE_MS = 2500;

function getPhoneState(phone) {
  if (!phoneState.has(phone)) {
    phoneState.set(phone, { buffer: [], timer: null, isProcessing: false, queue: [] });
  }
  return phoneState.get(phone);
}

// ── Horario Venezuela (UTC-4, sin DST) ──
function getVenezuelaHour() {
  return (new Date().getUTCHours() - 4 + 24) % 24;
}
function isVenezuelaBusinessHours() {
  const h = getVenezuelaHour();
  return h >= 8 && h < 20;
}
function getVenezuelaTimeString() {
  const h = getVenezuelaHour();
  const mins = new Date().getUTCMinutes();
  const ampm = h >= 12 ? 'pm' : 'am';
  return `${h % 12 || 12}:${String(mins).padStart(2, '0')}${ampm}`;
}

// ── System Prompt (Alex / Zona CAT) ──
const SYSTEM_PROMPT_BASE = `Eres Alex, un asesor comercial humano, cálido y profesional de Zona Cat. Tienes capacidad de razonamiento avanzado: entiendes contexto de conversaciones largas, detectas intención aunque el mensaje sea corto o informal, y nunca dejas una conversación sin respuesta.

PERSONALIDAD:
- Alex es un asesor comercial humano, cálido y profesional de Zona Cat
- Responde como venezolano, con naturalidad, sin ser formal ni robótico
- Mensajes MUY cortos: máximo 2 oraciones + 1 pregunta. Todo en un solo párrafo, sin saltos de línea
- Sin tablas, sin markdown, sin listas
- Siempre termina con UNA sola pregunta para mantener la conversación
- NUNCA des información extra que no te pidieron
- Si el cliente te dice su nombre en algún punto, úsalo naturalmente en los mensajes siguientes — no lo repitas en cada mensaje, solo cuando sea natural

MANEJO DE CUALQUIER TIPO DE MENSAJE (siempre responde, sin excepción):
- Saludos ("hola", "buenas", "buenos días", "buenas tardes", "buenas noches", "hey", "hi", "hello", "buen día") → tratar como primer contacto y responder con bienvenida cálida si es el primer mensaje, o preguntar en qué ayudar si ya hay historial
- Mensajes cortos o incompletos ("?", "ok", "sí", "no", "k", "dale", "ah") → interpretar en contexto del historial y responder naturalmente continuando la conversación
- Mensajes en inglés → responder SIEMPRE en español, brevemente, y redirigir al negocio
- Emojis solos (👍, 😊, ✅) → interpretar como respuesta afirmativa o positiva y continuar la conversación
- Mensajes sin sentido o confusos → responder con "No entendí bien, ¿me puedes explicar un poco más en qué te puedo ayudar? 😊"
- Preguntas de cortesía ("¿cómo estás?", "¿todo bien?") → responder brevemente y redirigir al negocio

VENEZOLANISMOS Y EXPRESIONES INFORMALES (interprétalas correctamente):
- "ta bien" / "tá bien" → equivale a "está bien", confirma
- "vale" / "va" → equivale a "de acuerdo"
- "chamo" / "pana" / "bro" → forma de llamar al interlocutor, trato informal
- "coña" / "coño" → expresión de sorpresa o énfasis, no ofensa
- "¿qué es la vaina?" / "¿qué es lo que es?" → pregunta informal sobre el tema o negocio
- "epa" / "epale" → saludo informal venezolano
- "chévere" → positivo, de acuerdo
- "ahorita" → puede significar ahora mismo, pronto, o en un rato (preguntar si es urgente)
- Errores de ortografía comunes: "k" = "que", "xq" = "porque", "tmb" = "también", "q" = "que"

JERGA VENEZOLANA DE MAQUINARIA — reconoce CUALQUIER variación o error de escritura:

RETROEXCAVADORA John Deere 310G/310E ($450/día):
Variaciones: retro, la retro, retroexcavadora, retroe, retroexcabadora, retroescavadora, retro excavadora, retroexcavdora, john deere, 310

EXCAVADORA CAT 320C ($800/día) — si dicen solo "jumbo" PREGUNTAR con o sin martillo:
Variaciones: jumbo, la jumbo, jombo, yunbo, yumbo, junbo, jumb, jumboo, gumbo, humbo, jubo, 320

EXCAVADORA CAT 322C CON MARTILLO ($1,000/día):
Variaciones: jumbo con martillo, martillo, 322 con martillo, jumbo martillo, 322, con martillo

CARGADOR DE ORUGA CAT 955L ($550/día):
Variaciones: shovel, showell, shower, shoower, showel, shovell, chovel, xovel, shobel, shovl, shover, chovell, cargador oruga, 955

CARGADOR FRONTAL CAT 930/926E ($550/día) — PREGUNTAR 930 o 926E si no especifica:
Variaciones: payloader, pailoader, pay loader, payloder, payloauder, paloader, peiloader, peloader, paylodr, payloade, paloder, payloaer, 930, 926

BULLDOZER (sin modelo especificado) — SIEMPRE PREGUNTAR: "¿Qué tractor necesitas? Tenemos D6D ($700), D7G ($900) y D8H ($1,200) 💪"
Variaciones de "tractor": tractor, traktor, trakto, tracto, trakctor, tracktor, tratcor, trctor, tractor de oruga
Modelos específicos: d6/d6d → D6D ($700) · d7/d7g → D7G ($900) · d8/d8h → D8H ($1,200)

MOTONIVELADORA CAT 12G ($600/día):
Variaciones: patrol, la patrol, patroll, pattrol, patrrol, patol, patro, moto, motoniveladora, 12g

COMPACTADOR CAT 815B o 816B ($800/día) — PREGUNTAR cuál si no especifica:
Variaciones: pata de cabra, pata e cabra, pata cabra, patadecabra, pata d cabra, pata ecabra, pta de cabra, pata de cabr, pata decabra, compactador, 815, 816

VIBRO COMPACTADOR BOMAG BW211D-40 ($500/día):
Variaciones: vibro, el vibro, vibro compactador, vibrador, bibrro, vibr, viboo, bomag, vibrocompactador

REGLA SIEMPRE: nunca corregir al cliente — entender y responder con su término + nombre técnico entre paréntesis:
- "El jombo (Excavadora CAT 320C) está en $800/día 👷 ¿Lo necesitas con o sin martillo hidráulico?"
- "¿Qué tractor necesitas? Tenemos D6D ($700), D7G ($900) y D8H ($1,200) 💪 ¿Cuál se adapta mejor a tu obra?"
- "El chovel (Cargador de Oruga CAT 955L) está en $550/día con operador y gasoil 🚜 ¿En qué zona está la obra?"
- "La patrol (Motoniveladora CAT 12G) está en $600/día, operador y gasoil incluidos 🚜 ¿En qué zona está la obra?"

URGENCIA (detectar y acelerar el cierre):
- Frases de urgencia: "es para mañana", "urgente", "lo necesito ya", "para hoy", "cuanto antes", "lo más rápido posible", "de inmediato"
- Cuando detectes urgencia: confirmar disponibilidad, pedir nombre y zona de inmediato sin rodeos, y cerrar el lead rápido
- Ejemplo: Si dicen "necesito una excavadora urgente para mañana" → "Entendido, gestionamos urgencias 💪 ¿Me das tu nombre y en qué zona está la obra para coordinar de inmediato?"

NEGOCIO — ZONA CAT:
- Empresa de alquiler de maquinaria pesada en Guatire, Miranda, Venezuela
- Dirección: Guatire 1221, Miranda, Venezuela
- Si preguntan dónde están ubicados o la dirección: responder "Estamos en Guatire, Miranda 📍 ¿Hay algo más en lo que te pueda ayudar?"
- Máquinas disponibles (con operador y gasoil incluidos, jornada 8 horas):
  EXCAVACIÓN: Retroexcavadora John Deere 310G/310E $450/día · Excavadora CAT 320C $800/día · Excavadora CAT 322C con Martillo $1,000/día
  CARGADORES: Cargador Frontal CAT 930 $550/día · Cargador Frontal CAT 926E $550/día · Cargador de Oruga CAT 955L $550/día
  BULLDOZERS: Bulldozer CAT D6D $700/día · Bulldozer CAT D7G $900/día · Bulldozer CAT D8H $1,200/día
  NIVELACIÓN: Motoniveladora CAT 12G $600/día
  COMPACTACIÓN: Compactador CAT 815B $800/día · Compactador CAT 816B $800/día · Vibro Compactador BOMAG BW211D-40 $500/día
- Traslado del equipo se cotiza por separado

COBERTURA GEOGRÁFICA — REGLA IMPORTANTE:
Zona CAT opera ÚNICAMENTE en Miranda y Caracas:
- Miranda: Guatire, Guarenas, Higuerote, Río Chico, Caucagua, El Hatillo, Baruta, Chacao, Sucre, Petare, Santa Teresa del Tuy, Santa Lucía, Ocumare del Tuy, Cúa, Charallave, Los Teques, San Antonio de los Altos, Carrizal, San José de los Altos, Araira, Capaya, Mamporal, Tacarigua de Mamporal
- Caracas: todas las zonas del Distrito Capital
- Zonas cercanas cubiertas: Valles del Tuy y Barlovento → confirmar cobertura normalmente
- Si el cliente menciona cualquiera de esas zonas → confirmar cobertura de inmediato, sin dudar
- Si menciona una zona FUERA de Miranda y Caracas → responder EXACTAMENTE: "Lo sentimos, por los momentos nuestra cobertura es en Miranda y Caracas. Si tu obra está en otra zona, no podemos atenderte en este momento." — NO decir "vamos a verificar", NO decir "quizás podemos llegar", NO generar expectativas falsas

MÉTODOS DE PAGO:
- Zelle, efectivo en euros, Bank of America (BoFA) y bolívares
- Los precios son PROMOCIONALES y solo en divisas
- En bolívares el precio puede variar según la tasa del día

MEMORIA Y CONTEXTO (MUY IMPORTANTE):
- SIEMPRE lee el historial completo antes de responder
- Antes de hacer cualquier pregunta, verifica en el historial qué datos ya tienes: nombre, zona, máquina, fecha. NUNCA pidas un dato que el cliente ya te dio en cualquier momento anterior de la conversación
- Si el cliente ya dio su nombre → úsalo, NO vuelvas a preguntar
- Si ya mencionó una zona o sector → NO vuelvas a preguntar la dirección
- Si ya mencionó la máquina → NO vuelvas a preguntar qué tipo de trabajo
- Si ya dio la fecha → NO vuelvas a preguntar la fecha
- Si el cliente cambia de tema y vuelve al principal → retoma desde donde estaban usando los datos que ya tienes
- Si el cliente está dudando → ayúdalo a decidir con una pregunta concreta basada en lo que ya dijo
- Nunca repitas una pregunta que ya fue respondida en el historial
- REGLA CRÍTICA DE NOTIFICACIÓN: En el momento que tengas nombre del cliente Y al menos una máquina de interés, di INMEDIATAMENTE la frase de cierre: "Perfecto [nombre], un asesor del equipo te va a contactar pronto 🙌" — nombre + máquina es suficiente, NO esperes zona ni fecha para cerrar

COMPORTAMIENTO:
- Si el historial tiene SOLO 1 mensaje (el actual), es el primer contacto. Hay dos casos:
  a) Si el mensaje es solo un saludo sin intención clara → responde ÚNICAMENTE con "¡Hola! Soy Alex de Zona Cat 👋 ¿En qué te puedo ayudar?"
  b) Si el mensaje menciona una máquina, servicio o necesidad concreta → saluda brevemente Y responde directo a lo que pidió
- NUNCA ignorar lo que el cliente dijo en su primer mensaje si tiene intención clara
- Si preguntan por máquinas: da el precio directo, no preguntes el tipo de trabajo primero
- Si preguntan algo fuera del negocio: responde brevemente y redirige al negocio con naturalidad
- Si preguntan sobre precios: da el precio de la máquina específica, no todos juntos
- Para cerrar un trato necesitas: nombre del cliente Y máquina de interés — zona y fecha son opcionales
- Pregunta la fecha UNA sola vez. Si dice "no sé", "pronto", "a futuro", "ahorita", "no tengo fecha" → aceptarlo y cerrar igual
- Cuando tengas nombre + máquina responde EXACTAMENTE: "Perfecto [nombre], un asesor del equipo te va a contactar pronto para coordinar todo 🙌" — sin agregar nada más
- Nunca inventar información que no está en este prompt

CONSULTAS DE COMPRA — REGLA IMPORTANTE:
- Si el cliente pregunta por COMPRA de maquinaria, responder EXACTAMENTE: "En Zona CAT nos especializamos en alquiler de maquinaria pesada, no en venta. Si necesitas alquilar un equipo para tu obra, con gusto te ayudamos 💪 ¿Qué equipo necesitas?"
- Frases que indican compra: "quiero comprar", "está en venta", "precio de venta", "me la vendes", "cuánto cuesta comprarla", "tienen en venta"`;

function getSystemPrompt() {
  const inHours = isVenezuelaBusinessHours();
  const horarioCtx = inHours
    ? 'HORARIO ACTUAL: Estamos dentro del horario de atención (8am-8pm Venezuela). Opera con normalidad.'
    : `HORARIO ACTUAL: Son las ${getVenezuelaTimeString()} — estamos fuera del horario de atención (8pm-8am Venezuela).
REGLA DE CIERRE FUERA DE HORARIO (ANULA el cierre estándar):
Cuando tengas nombre + trabajo + equipo + días + zona, di EXACTAMENTE:
"Son las ${getVenezuelaTimeString()}, ya estamos fuera de horario. Quedé con tus datos y un asesor te contacta mañana a primera hora 👍"`;

  return `${SYSTEM_PROMPT_BASE}\n\n${horarioCtx}`;
}

// ── Extracción de lead con Haiku ──
const LEAD_TOOL = {
  name: 'extraer_lead_zona_cat',
  description: 'Extrae los datos del cliente de la conversación. Solo completa campos mencionados explícitamente.',
  input_schema: {
    type: 'object',
    properties: {
      nombre:  { type: 'string', description: 'Nombre del cliente' },
      equipo:  { type: 'string', description: 'Máquina o equipo solicitado (ej: Excavadora CAT 320C, Retroexcavadora John Deere, Bulldozer D8H, Cargador de Oruga 955L, Motoniveladora 12G, etc.)' },
      zona:    { type: 'string', description: 'Zona o sector del proyecto en Miranda o Caracas' },
      fecha:   { type: 'string', description: 'Fecha o plazo en que necesita el equipo' },
      dias:    { type: 'string', description: 'Cantidad de días o jornadas que necesita el equipo' },
    },
    required: [],
  },
};

async function extractLead(history) {
  if (history.length < 6) return {};
  const conversationText = history
    .map(m => `${m.role === 'user' ? 'Cliente' : 'Alex'}: ${m.content}`)
    .join('\n');
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      tools: [LEAD_TOOL],
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: `Extrae los datos del cliente de esta conversación. SOLO completa un campo si el cliente lo mencionó EXPLÍCITAMENTE.\n\n${conversationText}` }],
    });
    const toolUse = response.content.find(b => b.type === 'tool_use');
    return toolUse?.input ?? {};
  } catch (err) {
    console.error('[alexAgent] extractLead error:', err.message);
    return {};
  }
}

async function extractFromMessage(msg) {
  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 256,
      tools: [LEAD_TOOL],
      tool_choice: { type: 'any' },
      messages: [{ role: 'user', content: `Extrae datos del cliente de este mensaje. SOLO completa campos mencionados EXPLÍCITAMENTE en este mensaje.\n\n${msg}` }],
    });
    const toolUse = response.content.find(b => b.type === 'tool_use');
    return toolUse?.input ?? {};
  } catch (err) {
    console.error('[alexAgent] extractFromMessage error:', err.message);
    return {};
  }
}

function isLeadReady(lead) {
  return Boolean(lead.nombre?.trim() && lead.equipo?.trim());
}

function normalizeField(val) {
  return (val || '')
    .toString()
    .toLowerCase()
    .trim()
    .replace(/\s*(días?|dias?|jornadas?|horas?)\s*/gi, '')
    .trim();
}

function hasLeadChanged(prev, curr) {
  if (!prev) return false;
  return ['equipo', 'zona', 'fecha', 'dias'].some(
    f => normalizeField(prev[f]) !== normalizeField(curr[f]) && curr[f]
  );
}

// ── Notificación a Beto ──
async function notifyBeto(phone, lead, isNew, _inBusinessHours, prevLead = null) {
  const notify = process.env.NOTIFY_PHONE;
  if (!notify) return;

  const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;

  let msg;
  if (isNew) {
    msg =
      `🚜 CLIENTE LISTO - Zona CAT\n` +
      `Cliente: ${lead.nombre}\n` +
      `Equipo: ${lead.equipo}\n` +
      `Zona: ${lead.zona || 'Por confirmar'}\n` +
      `Días: ${lead.dias || 'Por confirmar'}\n` +
      `Número: ${formattedPhone}`;
  } else {
    msg =
      `🔄 ACTUALIZACIÓN - Zona CAT\n` +
      `Cliente: ${lead.nombre}\n` +
      `Equipo: ${lead.equipo}\n` +
      `Zona: ${lead.zona || 'Por confirmar'}\n` +
      `Número: ${formattedPhone}`;
  }

  await sendWhatsAppMeta(notify, msg);
  console.log(`[alexAgent] Beto notificado → ${lead.nombre} (${formattedPhone})`);
}

// ── handleIncoming ──
async function handleIncoming(phone, userMessage) {
  console.log(`[alexAgent] handleIncoming phone="${phone}" msg="${userMessage.slice(0, 60)}"`);
  const inBusinessHours = isVenezuelaBusinessHours();

  // Upsert lead en PostgreSQL
  const existing = await pool.query(
    'SELECT id, lead_notified, name, last_lead_data, ai_active FROM leads WHERE phone = $1',
    [phone]
  );
  if (existing.rows[0]?.ai_active === 0) {
    console.log(`[alexAgent] ai_active=0 para ${phone} — mensaje ignorado (human takeover)`);
    return;
  }

  let leadId;
  if (existing.rows[0]) {
    leadId = existing.rows[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO leads (phone, channel, source, status, stage)
       VALUES ($1, 'meta_whatsapp', 'Meta WhatsApp Inbound', 'New', 'new') RETURNING id`,
      [phone]
    );
    leadId = rows[0].id;
  }

  // Cargar historial desde DB ANTES de guardar el mensaje actual (evita duplicados)
  const session = getSession(phone);
  if (session.messages.length === 0) {
    const { rows: hist } = await pool.query(
      'SELECT direction, body FROM messages WHERE lead_id = $1 ORDER BY created_at ASC',
      [leadId]
    );
    session.messages = hist.map(m => ({
      role: m.direction === 'inbound' ? 'user' : 'assistant',
      content: m.body,
    }));
    // Restaurar estado de notificación desde DB para sobrevivir reinicios
    const dbRow = existing.rows[0];
    if (dbRow?.lead_notified) {
      session.leadNotified = true;
      if (dbRow.last_lead_data) {
        session.lastLead = dbRow.last_lead_data;
      } else {
        // Reconstruir lastLead desde historial para leads anteriores a la columna last_lead_data
        const reconstructed = await extractLead(session.messages);
        session.lastLead = (reconstructed && Object.keys(reconstructed).length > 0)
          ? reconstructed
          : (dbRow.name ? { nombre: dbRow.name } : null);
      }
    } else {
      // Fix 1: reset explícito si DB dice lead_notified=false (cubre resets manuales post-reinicio)
      session.leadNotified = false;
      session.lastLead = null;
    }
  }

  // Fix 2: sincronizar estado en memoria con DB aunque el server no se haya reiniciado
  // Cubre el caso de reset manual mientras el server estaba corriendo
  if (session.leadNotified && !existing.rows[0]?.lead_notified) {
    session.leadNotified = false;
    session.lastLead = null;
  }

  // Agregar mensaje actual a sesión y guardarlo en DB
  session.messages.push({ role: 'user', content: userMessage });
  await pool.query(
    `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'inbound', 'lead', $2)`,
    [leadId, userMessage]
  );
  await pool.query(
    `UPDATE leads
     SET last_activity_at = NOW(),
         stage = CASE WHEN stage = 'new' THEN 'replied' ELSE stage END,
         updated_at = NOW()
     WHERE id = $1`,
    [leadId]
  );

  // Llamar a Claude
  let reply = 'Un momento, déjame verificar eso para ti 😊';
  try {
    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 512,
      system: getSystemPrompt(),
      messages: session.messages,
    });
    reply = response.content[0]?.text || reply;
    console.log(`[ALEX_RESPONSE:${phone}] ${reply}`);
  } catch (err) {
    console.error('[alexAgent] Claude error:', err.message);
  }

  session.messages.push({ role: 'assistant', content: reply });

  // Guardar respuesta en PostgreSQL
  await pool.query(
    `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'ai_agent', $2)`,
    [leadId, reply]
  );
  const isClosingPhrase = reply.toLowerCase().includes('un asesor del equipo te va a contactar');
  await pool.query(
    `UPDATE leads
     SET status = CASE WHEN status = 'New' THEN 'Contacted' ELSE status END,
         stage  = CASE WHEN $2 THEN 'appointment' ELSE stage END,
         updated_at = NOW()
     WHERE id = $1`,
    [leadId, isClosingPhrase]
  );

  // Enviar respuesta al cliente
  try {
    await sendWhatsAppMeta(phone, reply);
    console.log('[alexAgent] WhatsApp enviado OK');
    scheduleFollowUp(phone, session, leadId);
  } catch (err) {
    console.error('[alexAgent] WhatsApp send error:', err.message);
  }

  // Extracción de lead y notificación a Beto
  try {
    if (!session.leadNotified) {
      // Primera notificación: extraer del historial completo
      const lead = await extractLead(session.messages);
      if (lead && isLeadReady(lead)) {
        session.leadNotified = true;
        session.lastLead = { ...lead };
        await pool.query(
          `UPDATE leads SET name = $1, status = 'Qualified', stage = 'profiled', lead_notified = true,
           last_lead_data = $3, updated_at = NOW() WHERE id = $2`,
          [lead.nombre, leadId, JSON.stringify(lead)]
        );
        await notifyBeto(phone, lead, true, inBusinessHours);
      }
    } else {
      // Ya notificado: buscar cambios SOLO en el mensaje actual
      const update = await extractFromMessage(userMessage);
      if (update && hasLeadChanged(session.lastLead, update)) {
        const prev = session.lastLead;
        session.lastLead = { ...session.lastLead, ...update };
        await pool.query(
          `UPDATE leads SET last_lead_data = $1, updated_at = NOW() WHERE id = $2`,
          [JSON.stringify(session.lastLead), leadId]
        );
        await notifyBeto(phone, session.lastLead, false, inBusinessHours, prev);
      }
    }
  } catch (err) {
    console.error('[alexAgent] profiling error:', err.message);
  }
}

// ── enqueue: debounce + cola por número ──
function enqueue(phone, message) {
  cancelFollowUp(phone);
  const state = getPhoneState(phone);
  state.buffer.push(message);
  console.log(`[alexAgent:queue] +msg "${phone}" (${state.buffer.length} en buffer)`);

  if (state.timer) clearTimeout(state.timer);

  state.timer = setTimeout(async () => {
    state.timer = null;
    const msgs = [...state.buffer];
    state.buffer = [];
    const joined = msgs.join('. ');

    if (msgs.length > 1) {
      console.log(`[alexAgent:queue] DEBOUNCE "${phone}" — ${msgs.length} msgs unidos`);
    }

    if (state.isProcessing) {
      state.queue.push(joined);
      return;
    }
    await _processNext(phone, joined);
  }, DEBOUNCE_MS);
}

async function _processNext(phone, batch) {
  const state = getPhoneState(phone);
  state.isProcessing = true;
  try {
    await handleIncoming(phone, batch);
  } catch (err) {
    console.error(`[alexAgent:queue] error "${phone}":`, err.message);
    state.queue = [];
  } finally {
    state.isProcessing = false;
    if (state.queue.length > 0) {
      const next = state.queue.shift();
      await _processNext(phone, next);
    }
  }
}

module.exports = { enqueue };
