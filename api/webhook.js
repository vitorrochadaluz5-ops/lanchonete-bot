import { createClient } from "@supabase/supabase-js";

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

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
1. Cumprimente o cliente com energia e simpatia
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
✅ *PEDIDO CONFIRMADO*
[lista dos itens com preços]
💰 *Total: R$ XX,00*
📍 [retirada/delivery + endereço]
💳 *Pagamento:* PIX ${PIX}

Responda SEMPRE em português brasileiro.`;
}

async function getHistory(phone) {
  const { data } = await supabase
    .from("conversas")
    .select("mensagens")
    .eq("telefone", phone)
    .single();
  return data?.mensagens || [];
}

async function saveHistory(phone, messages) {
  const recent = messages.slice(-20);
  await supabase.from("conversas").upsert(
    { telefone: phone, mensagens: recent, atualizado_em: new Date() },
    { onConflict: "telefone" }
  );
}

async function saveOrder(phone, message, response) {
  if (response.includes("PEDIDO CONFIRMADO")) {
    await supabase.from("pedidos").insert({
      telefone: phone,
      mensagem_cliente: message,
      resposta_agente: response,
      criado_em: new Date(),
    });
  }
}

async function callGroq(history, userMessage) {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history.map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content })),
    { role: "user", content: userMessage },
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.GROQ_API_KEY}`,
    },
    body: JSON.stringify({
      model: "llama-3.1-8b-instant",
      messages,
      max_tokens: 500,
      temperature: 0.7,
    }),
  });

  const data = await response.json();
  return data.choices[0].message.content;
}

async function sendWhatsApp(phone, message) {
  const response = await fetch(
    `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: process.env.EVOLUTION_API_KEY,
      },
      body: JSON.stringify({ number: phone, text: message }),
    }
  );
  return response.ok;
}

export default async function handler(req, res) {
  if (req.method === "GET") {
    const verify_token = process.env.WEBHOOK_VERIFY_TOKEN || "lanchonete123";
    const { "hub.mode": mode, "hub.verify_token": token, "hub.challenge": challenge } = req.query;
    if (mode === "subscribe" && token === verify_token) return res.status(200).send(challenge);
    return res.status(403).end();
  }

  if (req.method !== "POST") return res.status(405).end();

  try {
    const body = req.body;
    let phone, message;

    if (body?.data?.key?.remoteJid) {
      phone = body.data.key.remoteJid.replace("@s.whatsapp.net", "");
      message = body.data.message?.conversation || body.data.message?.extendedTextMessage?.text;
    } else if (body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const msg = body.entry[0].changes[0].value.messages[0];
      phone = msg.from;
      message = msg.text?.body;
    }

    if (!phone || !message) return res.status(200).json({ ok: true });
    if (phone.includes("@g.us")) return res.status(200).json({ ok: true });

    console.log(`📱 Mensagem de ${phone}: ${message}`);

    const history = await getHistory(phone);
    const reply = await callGroq(history, message);

    const updatedHistory = [
      ...history,
      { role: "user", content: message },
      { role: "assistant", content: reply },
    ];
    await saveHistory(phone, updatedHistory);
    await saveOrder(phone, message, reply);
    await sendWhatsApp(phone, reply);

    console.log(`✅ Resposta enviada para ${phone}`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(500).json({ error: error.message });
  }
}
