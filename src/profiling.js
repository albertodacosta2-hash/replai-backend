const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic();

const EXTRACT_TOOL = {
  name: 'save_lead_qualification',
  description: 'Extrae los datos de calificación del lead inmobiliario de la conversación.',
  input_schema: {
    type: 'object',
    properties: {
      type:       { type: 'string', enum: ['Buyer', 'Seller', 'Renter', 'Investor', null], description: 'Tipo de intención del lead' },
      zone:       { type: 'string', description: 'Zona o área de interés. null si no se mencionó.' },
      budget:     { type: 'string', description: 'Presupuesto mencionado (ej: "$450,000", "$2,500/mes"). null si no se mencionó.' },
      bedrooms:   { type: 'string', description: 'Número de habitaciones requeridas. null si no se mencionó.' },
      timeline:   { type: 'string', description: 'Cuándo quiere hacer la transacción. null si no se mencionó.' },
      financing:  { type: 'string', description: 'Situación de financiamiento: Pre-aprobado, Cash, Buscando financiamiento. null si no se mencionó.' },
      urgency:    { type: 'string', enum: ['Alta', 'Media', 'Baja', null], description: 'Nivel de urgencia percibido.' },
      name:       { type: 'string', description: 'Nombre del lead si lo mencionó. null si no.' },
    },
    required: [],
  },
};

async function extractQualification(history) {
  if (history.length < 3) return null;

  try {
    const response = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 512,
      tools: [EXTRACT_TOOL],
      tool_choice: { type: 'auto' },
      system: 'Analiza la conversación de WhatsApp y extrae los datos de calificación inmobiliaria disponibles. Si un dato no fue mencionado, omítelo o usa null.',
      messages: history,
    });

    const toolUse = response.content.find(b => b.type === 'tool_use');
    if (!toolUse) return null;

    const data = toolUse.input;
    // Solo retornar si tiene los campos mínimos para calificar
    if (!data.type && !data.zone && !data.budget) return null;

    return data;
  } catch {
    return null;
  }
}

function isQualified(data) {
  return Boolean(data?.type && data?.zone && data?.budget);
}

module.exports = { extractQualification, isQualified };
