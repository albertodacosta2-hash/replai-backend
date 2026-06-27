const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { sendWhatsAppMeta } = require('./metaSender');

const client = new Anthropic();

// ── Sesiones en memoria (historial + estado de notificación) ──
const sessions = new Map();

function getSession(phone) {
  if (!sessions.has(phone)) {
    sessions.set(phone, { messages: [], leadNotified: false, lastLead: null });
  }
  return sessions.get(phone);
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
const SYSTEM_PROMPT_BASE = `Eres Alex, asesor de Zona CAT, empresa de alquiler de maquinaria pesada en Venezuela.

PERSONALIDAD:
- Venezolano natural, no forzado. Usas "claro que sí", "con gusto", "dale", "perfecto", "manejamos eso", "sin problema", "de una".
- Profesional pero cercano, como un buen asesor de confianza.
- Mensajes MUY cortos: máximo 3-4 líneas en un solo párrafo. Sin saltos de línea innecesarios.
- Sin markdown, sin tablas, sin listas.
- Siempre terminas con UNA sola pregunta o acción clara para mantener la conversación.
- Si el cliente duda, lo ayudas a decidir con seguridad.
- Nunca robótico, nunca respuestas largas.
- Nunca te quedas sin respuesta.

MANEJO DE CUALQUIER TIPO DE MENSAJE:
- Saludos ("hola", "buenas", "epa", "hey") → si es el primer mensaje, responde ÚNICAMENTE: "¡Hola! Soy Alex de Zona CAT 👋 ¿En qué te puedo ayudar?"
- Mensajes cortos o ambiguos ("?", "ok", "sí", "dale", "k", "ta bien") → interpretar en contexto del historial y continuar naturalmente
- "quiero alquilar" → "Con gusto, ¿qué tipo de maquinaria necesitas?"
- Urgencia ("urgente", "es para mañana", "lo necesito ya") → priorizar, pedir datos rápido sin rodeos
- Mensajes fuera de tema → responde brevemente y redirige al negocio con naturalidad
- Venezolanismos: "ta bien" = de acuerdo, "chévere" = positivo, "vale/va" = de acuerdo, "epa/epale" = saludo

NEGOCIO — ZONA CAT:
Somos una empresa de alquiler de maquinaria pesada en Venezuela (Miranda y Caracas).
NUNCA menciones precios. Siempre dices que un asesor confirma la cotización.

EQUIPOS DISPONIBLES:
- Retroexcavadora John Deere (310G / 310E)
- Excavadora CAT 320C
- Bulldozer CAT D8H
- Cargador de oruga CAT 955L
- Cargador de caucho CAT (930 / 926E)

CONDICIONES DEL SERVICIO:
- Jornada de 8 horas
- Incluye operador
- Incluye gasoil
- Flete NO incluido

COBERTURA: Miranda y Caracas.
Si el cliente pide otra zona: "Por ahora operamos en Miranda y Caracas, ¿tu proyecto es en esa área?"

FLUJO DE CALIFICACIÓN (de forma natural, nunca como formulario):
1. ¿Qué tipo de trabajo necesita? (movimiento de tierra, excavación, nivelación, demolición, carga, otro)
2. ¿Qué equipo cree que necesita? (si no sabe, ayudar a identificar según el trabajo)
3. ¿Cuántos días o jornadas necesita el equipo?
4. ¿Dónde es el proyecto? (zona/sector en Miranda o Caracas)
5. Nombre del cliente.
6. Cuando tengas trabajo + equipo + días + zona + nombre: "Perfecto [nombre], un asesor te confirma la disponibilidad y cotización 🙌"

REGLAS:
- NUNCA menciones precios ni tarifas. Un asesor siempre confirma.
- Una sola pregunta a la vez.
- Si el cliente ya dio su nombre, úsalo. No vuelvas a pedirlo.
- Si ya mencionó el equipo o la zona, no vuelvas a preguntar.
- Si el historial tiene SOLO 1 mensaje, responde ÚNICAMENTE: "¡Hola! Soy Alex de Zona CAT 👋 ¿En qué te puedo ayudar?" — sin importar lo que diga el cliente.

MEMORIA Y CONTEXTO:
- SIEMPRE lee el historial completo antes de responder.
- Nunca repitas una pregunta ya respondida en el historial.

COMPORTAMIENTO AL CIERRE:
- Cuando tengas nombre + trabajo + equipo + días + zona: responde EXACTAMENTE "Perfecto [nombre], un asesor te confirma la disponibilidad y cotización 🙌" — sin dar precios, sin agregar nada más.`;

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
      trabajo: { type: 'string', description: 'Tipo de trabajo: movimiento de tierra, excavación, nivelación, demolición, carga, otro' },
      equipo:  { type: 'string', description: 'Equipo solicitado: Retroexcavadora John Deere, Excavadora CAT 320C, Bulldozer CAT D8H, Cargador de oruga CAT 955L, Cargador de caucho CAT' },
      dias:    { type: 'string', description: 'Cantidad de días o jornadas que necesita el equipo' },
      zona:    { type: 'string', description: 'Zona o sector del proyecto en Miranda o Caracas' },
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

function isLeadReady(lead) {
  return Boolean(
    lead.nombre?.trim() &&
    lead.trabajo?.trim() &&
    lead.equipo?.trim() &&
    lead.dias?.trim() &&
    lead.zona?.trim()
  );
}

function hasLeadChanged(prev, curr) {
  return ['trabajo', 'equipo', 'dias', 'zona'].some(f => (prev[f] || '') !== (curr[f] || '') && curr[f]);
}

// ── Notificación a Beto ──
async function notifyBeto(phone, lead, isNew, inBusinessHours, prevLead = null) {
  const notify = process.env.NOTIFY_PHONE;
  if (!notify) return;

  const tiempoInfo = inBusinessHours
    ? '✅ Dentro de horario — atender ahora'
    : '🌙 Fuera de horario — contactar mañana a primera hora';

  const formattedPhone = phone.startsWith('+') ? phone : `+${phone}`;

  let msg;
  if (isNew) {
    msg =
      `🚜 CLIENTE LISTO - Zona CAT\n` +
      `Cliente: ${lead.nombre}\n` +
      `Trabajo: ${lead.trabajo}\n` +
      `Equipo: ${lead.equipo}\n` +
      `Días: ${lead.dias}\n` +
      `Zona: ${lead.zona}\n` +
      `Número: ${formattedPhone}\n` +
      `⏰ ${tiempoInfo}`;
  } else {
    const fieldLabels = { trabajo: 'Trabajo', equipo: 'Equipo', dias: 'Días', zona: 'Zona' };
    const changes = Object.entries(fieldLabels)
      .filter(([k]) => (prevLead[k] || '') !== (lead[k] || '') && lead[k])
      .map(([k, label]) => `${label}: ${prevLead[k] || 'No especificado'} → ${lead[k]}`)
      .join('\n');

    msg =
      `🔄 SOLICITUD MODIFICADA - Zona CAT\n` +
      `Cliente: ${lead.nombre}\n` +
      `Cambio:\n${changes}\n` +
      `Solicitud actualizada: ${lead.trabajo} | ${lead.equipo} | ${lead.dias} días\n` +
      `Zona: ${lead.zona}\n` +
      `Número: ${formattedPhone}\n` +
      `⏰ ${tiempoInfo}`;
  }

  await sendWhatsAppMeta(notify, msg);
  console.log(`[alexAgent] Beto notificado → ${lead.nombre} (${formattedPhone})`);
}

// ── handleIncoming ──
async function handleIncoming(phone, userMessage) {
  console.log(`[alexAgent] handleIncoming phone="${phone}" msg="${userMessage.slice(0, 60)}"`);
  const inBusinessHours = isVenezuelaBusinessHours();

  // Upsert lead en PostgreSQL
  const existing = await pool.query('SELECT id FROM leads WHERE phone = $1', [phone]);
  let leadId;
  if (existing.rows[0]) {
    leadId = existing.rows[0].id;
  } else {
    const { rows } = await pool.query(
      `INSERT INTO leads (phone, channel, source, status)
       VALUES ($1, 'meta_whatsapp', 'Meta WhatsApp Inbound', 'New') RETURNING id`,
      [phone]
    );
    leadId = rows[0].id;
  }

  // Guardar mensaje entrante
  await pool.query(
    `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'inbound', 'lead', $2)`,
    [leadId, userMessage]
  );
  await pool.query('UPDATE leads SET updated_at = NOW() WHERE id = $1', [leadId]);

  // Historial en memoria — cargar desde DB si la sesión está vacía (ej: tras redeploy)
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
  }
  session.messages.push({ role: 'user', content: userMessage });

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
  await pool.query(
    `UPDATE leads SET status = 'Contacted', updated_at = NOW() WHERE id = $1 AND status = 'New'`,
    [leadId]
  );

  // Enviar respuesta al cliente
  try {
    await sendWhatsAppMeta(phone, reply);
    console.log('[alexAgent] WhatsApp enviado OK');
  } catch (err) {
    console.error('[alexAgent] WhatsApp send error:', err.message);
  }

  // Extracción de lead y notificación a Beto
  try {
    const lead = await extractLead(session.messages);
    if (lead && isLeadReady(lead)) {
      if (!session.leadNotified) {
        session.leadNotified = true;
        session.lastLead = { ...lead };
        await pool.query(
          `UPDATE leads SET name = $1, status = 'Qualified', updated_at = NOW() WHERE id = $2`,
          [lead.nombre, leadId]
        );
        await notifyBeto(phone, lead, true, inBusinessHours);
      } else if (hasLeadChanged(session.lastLead, lead)) {
        const prev = session.lastLead;
        session.lastLead = { ...lead };
        await notifyBeto(phone, lead, false, inBusinessHours, prev);
      }
    }
  } catch (err) {
    console.error('[alexAgent] profiling error:', err.message);
  }
}

// ── enqueue: debounce + cola por número ──
function enqueue(phone, message) {
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
