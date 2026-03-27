
// =============================================================
// AGENTE ATENDENTE DE LANCHONETE — WhatsApp + Gemini (GRÁTIS)
// =============================================================
// Stack: Vercel (grátis) + Gemini Flash-Lite (grátis) + Supabase (grátis)
// Custo estimado: R$ 0/mês para até ~500 pedidos/mês
// =============================================================

import { GoogleGenerativeAI } from "@google/generative-ai";
import { createClient } from "@supabase/supabase-js";

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// =============================================================
// CARDÁPIO — edite aqui com seus produtos e preços
// =============================================================
const CARDAPIO = `
🍔 LANCHES
- X-Burguer .............. R$ 18,00
- X-Bacon ................ R$ 22,00
- X-Frango ............... R$ 20,00
- X-Tudo ................. R$ 26,00

🍟 ACOMPANHAMENTOS
- Fritas pequena ......... R$ 8,00
- Fritas grande .......... R$ 12,00
- Onion rings ............ R$ 10,00

🥤 BEBIDAS
- Refrigerante lata ...... R$ 6,00
- Suco natural ........... R$ 9,00
- Água mineral ........... R$ 4,00
- Milkshake .............. R$ 15,00

🍰 SOBREMESAS
- Sundae ................. R$ 8,00
- Brownie ................ R$ 7,00
`;

const NOME_LANCHONETE = process.env.NOME_LANCHONETE || "Lanchonete do Zé";
const HORARIO = process.env.HORARIO || "Seg-Sex: 11h–22h | Sáb-Dom: 11h–23h";
const ENDERECO = process.env.ENDERECO || "Rua das Flores, 123 — Centro";
const PIX = process.env.PIX_CHAVE || "lanchonete@email.com";

// =============================================================
// PROMPT DO AGENTE
// =============================================================
function buildSystemPrompt() {
  return `Você é um atendente simpático e eficiente da ${NOME_LANCHONETE}.
Seu trabalho é atender clientes pelo WhatsApp, anotar pedidos e confirmar tudo com clareza.

INFORMAÇÕES DO ESTABELECIMENTO:
- Nome: ${NOME_LANCHONETE}
- Endereço: ${ENDERECO}
- Horário: ${HORARIO}
- Pagamento: PIX (${PIX}) ou dinheiro na entrega

CARDÁPIO COMPLETO:
${CARDAPIO}

REGRAS DE ATENDIMENTO:
1. Cumprimente o cliente pelo nome se souber, com energia e simpatia
2. Apresente o cardápio quando o cliente pedir ou na primeira mensagem
3. Anote os itens do pedido com atenção
4. Ao finalizar, SEMPRE confirme o pedido completo com os itens e o total
5. Informe que o pagamento é via PIX (${PIX}) ou dinheiro na entrega
6. Se o cliente quiser retirar no local, confirme o endereço
7. Se pedir delivery, pergunte o endereço de entrega
8. Seja breve, amigável e objetivo — evite textos longos
9. Use emojis com moderação para deixar a conversa mais leve
10. Nunca invente itens ou preços que não estejam no cardápio

FORMATO DE CONFIRMAÇÃO DO PEDIDO:
Ao confirmar, use sempre este formato:
✅ *PEDIDO CONFIRMADO*
[lista dos itens com preços]
💰 *Total: R$ XX,00*
📍 [retirada/delivery + endereço]
💳 *Pagamento:* PIX ${PIX}

Responda SEMPRE em português brasileiro.`;
}

// =============================================================
// HISTÓRICO DE CONVERSA (Supabase)
// =============================================================
async function getHistory(phone) {
  const { data } = await supabase
    .from("conversas")
    .select("mensagens")
    .eq("telefone", phone)
    .single();
  return data?.mensagens || [];
}

async function saveHistory(phone, messages) {
  // Mantém apenas as últimas 20 mensagens para economizar tokens
  const recent = messages.slice(-20);
  await supabase.from("conversas").upsert(
    { telefone: phone, mensagens: recent, atualizado_em: new Date() },
    { onConflict: "telefone" }
  );
}

async function saveOrder(phone, message, response) {
  // Detecta se há confirmação de pedido na resposta
  if (response.includes("PEDIDO CONFIRMADO")) {
    await supabase.from("pedidos").insert({
      telefone: phone,
      mensagem_cliente: message,
      resposta_agente: response,
      criado_em: new Date(),
    });
  }
}

// =============================================================
// CHAMADA AO GEMINI
// =============================================================
async function callGemini(history, userMessage) {
  const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash", // modelo mais barato — grátis até certo limite
    systemInstruction: buildSystemPrompt(),
    generationConfig: {
      maxOutputTokens: 500, // limita resposta para economizar tokens
      temperature: 0.7,
    },
  });

  // Converte histórico para o formato do Gemini
  const chat = model.startChat({
    history: history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    })),
  });

  const result = await chat.sendMessage(userMessage);
  return result.response.text();
}

// =============================================================
// ENVIO DE MENSAGEM VIA EVOLUTION API (WhatsApp)
// =============================================================
async function sendWhatsApp(phone, message) {
  const evolutionUrl = process.env.EVOLUTION_API_URL;
  const evolutionKey = process.env.EVOLUTION_API_KEY;
  const instanceName = process.env.EVOLUTION_INSTANCE;

  const response = await fetch(
    `${evolutionUrl}/message/sendText/${instanceName}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: evolutionKey,
      },
      body: JSON.stringify({
        number: phone,
        text: message,
      }),
    }
  );

  return response.ok;
}

// =============================================================
// HANDLER PRINCIPAL DO WEBHOOK
// =============================================================
export default async function handler(req, res) {
  // Verificação do webhook (Evolution API / Meta)
  if (req.method === "GET") {
    const verify_token = process.env.WEBHOOK_VERIFY_TOKEN || "lanchonete123";
    const mode = req.query["hub.mode"];
    const token = req.query["hub.verify_token"];
    const challenge = req.query["hub.challenge"];
    if (mode === "subscribe" && token === verify_token) {
      return res.status(200).send(challenge);
    }
    return res.status(403).end();
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body;

    // Suporte a Evolution API e Meta Webhooks
    let phone, message;

    if (body?.data?.key?.remoteJid) {
      // Evolution API format
      phone = body.data.key.remoteJid.replace("@s.whatsapp.net", "");
      message = body.data.message?.conversation || body.data.message?.extendedTextMessage?.text;
    } else if (body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      // Meta Webhook format
      const msg = body.entry[0].changes[0].value.messages[0];
      phone = msg.from;
      message = msg.text?.body;
    }

    if (!phone || !message) return res.status(200).json({ ok: true });

    // Ignora mensagens de grupos
    if (phone.includes("@g.us")) return res.status(200).json({ ok: true });

    console.log(`📱 Mensagem de ${phone}: ${message}`);

    // Busca histórico da conversa
    const history = await getHistory(phone);

    // Chama o Gemini
    const reply = await callGemini(history, message);

    // Salva histórico atualizado
    const updatedHistory = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: reply },
    ];
    await saveHistory(phone, updatedHistory);

    // Salva pedido se foi confirmado
    await saveOrder(phone, message, reply);

    // Envia resposta pelo WhatsApp
    await sendWhatsApp(phone, reply);

    console.log(`✅ Resposta enviada para ${phone}`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(500).json({ error: error.message });
  }
}
