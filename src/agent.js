const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { sendWhatsApp, notifyRealtor } = require('./notifier');
const { extractQualification, isQualified } = require('./profiling');

const client = new Anthropic();

function buildSystemPrompt() {
  const realtor  = process.env.REALTOR_NAME  || 'tu agente';
  const agency   = process.env.AGENCY_NAME   || 'nuestra agencia';
  const location = process.env.LOCATION      || 'el área';
  const agentName = process.env.AGENT_NAME   || 'Sofia';

  return `Eres ${agentName}, asistente virtual de ${realtor} en ${agency}.
Trabajas en el área de bienes raíces en ${location}.

Tu misión: responder al lead rápido, hacerlo sentir atendido, calificar su necesidad y agendar el siguiente paso con ${realtor}.

FLUJO DE CALIFICACIÓN (de forma natural, nunca como formulario):
1. Saluda con calidez. Preséntate brevemente. Menciona a ${realtor}.
2. Pregunta si busca COMPRAR, VENDER, RENTAR o INVERTIR.
3. Según la respuesta, califica:
   - Buyers: zona de interés, presupuesto, habitaciones, timeline, pre-aprobación
   - Sellers: ubicación, tamaño, precio estimado, timeline
   - Renters: zona, presupuesto mensual, habitaciones, fecha de entrada
   - Investors: tipo de inversión, presupuesto, zona, ROI esperado
4. Pregunta su nombre si aún no lo sabes.
5. Pregunta su mejor horario para hablar con ${realtor}.
6. Confirma que ${realtor} lo contactará pronto.

REGLAS:
- Máximo 2-3 oraciones por mensaje. UNA pregunta a la vez.
- Si el lead escribe en inglés, responde en inglés.
- No prometas precios ni garantices closings.
- No menciones que eres IA a menos que te lo pregunten directamente.
- Si te preguntan si eres IA: "Soy el asistente de ${realtor}. Él/ella te contactará personalmente pronto."
- No des información de propiedades específicas — eso lo hace ${realtor} en la consulta.`;
}

async function handleMessage(leadId, phone) {
  // Check if AI is active for this lead
  const leadRow = await pool.query('SELECT ai_active FROM leads WHERE id = $1', [leadId]);
  if (!leadRow.rows[0]?.ai_active) return;

  // Load full conversation history from DB
  const { rows: msgs } = await pool.query(
    'SELECT direction, sender, body FROM messages WHERE lead_id = $1 ORDER BY created_at ASC',
    [leadId]
  );

  // Convert to Claude message format
  const history = msgs.map(m => ({
    role: m.direction === 'inbound' ? 'user' : 'assistant',
    content: m.body,
  }));

  if (!history.length) return;

  // Call Claude
  const response = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 512,
    system: buildSystemPrompt(),
    messages: history,
  });

  const reply = response.content[0]?.text;
  if (!reply) return;

  // Save AI response to DB
  await pool.query(
    `INSERT INTO messages (lead_id, direction, sender, body) VALUES ($1, 'outbound', 'ai_agent', $2)`,
    [leadId, reply]
  );
  await pool.query(`UPDATE leads SET status = 'Contacted', updated_at = NOW() WHERE id = $1 AND status = 'New'`, [leadId]);

  // Send reply via WhatsApp
  await sendWhatsApp(phone, reply);

  // Try to extract qualification data
  const qualification = await extractQualification(history);
  if (qualification && isQualified(qualification)) {
    const updates = [];
    const params = [];

    const fields = ['type', 'zone', 'budget', 'bedrooms', 'timeline', 'financing', 'urgency', 'name'];
    for (const field of fields) {
      if (qualification[field]) {
        params.push(qualification[field]);
        updates.push(`${field} = $${params.length}`);
      }
    }

    updates.push(`status = 'Qualified'`);
    updates.push(`updated_at = NOW()`);
    params.push(leadId);

    await pool.query(
      `UPDATE leads SET ${updates.join(', ')} WHERE id = $${params.length} AND status != 'Closed'`,
      params
    );

    // Notify realtor once lead is qualified
    const { rows } = await pool.query('SELECT * FROM leads WHERE id = $1', [leadId]);
    if (rows[0]) await notifyRealtor(rows[0]);
  }
}

module.exports = { handleMessage };
