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

const NOME_LANCHONETE = process.env.NOME_LANCHONETE || "Lanchonete do Ze";
const HORARIO = process.env.HORARIO || "Seg-Sex: 11h-22h | Sab-Dom: 11h-23h";
const ENDERECO = process.env.ENDERECO || "Rua das Flores, 123 - Centro";
const PIX = process.env.PIX_CHAVE || "lanchonete@email.com";

function buildSystemPrompt() {
  return `Voce e um atendente simpatico e eficiente da ${NOME_LANCHONETE}.
Seu trabalho e atender clientes pelo WhatsApp, anotar pedidos e confirmar tudo com clareza.

INFORMACOES DO ESTABELECIMENTO:
- Nome: ${NOME_LANCHONETE}
- Endereco: ${ENDERECO}
- Horario: ${HORARIO}
- Pagamento: PIX (${PIX}) ou dinheiro na entrega

CARDAPIO COMPLETO:
${CARDAPIO}

REGRAS DE ATENDIMENTO:
1. Cumprimente o cliente com energia e simpatia
2. Apresente o cardapio quando o cliente pedir ou na primeira mensagem
3. Anote os itens do pedido com atencao
4. Ao finalizar, SEMPRE confirme o pedido completo com os itens e o total
5. Informe que o pagamento e via PIX (${PIX}) ou dinheiro na entrega
6. Se o cliente quiser retirar no local, confirme o endereco
7. Se pedir delivery, pergunte o endereco de entrega
8. Seja breve, amigavel e objetivo
9. Use emojis com moderacao
10. Nunca invente itens ou precos que nao estejam no cardapio

FORMATO DE CONFIRMACAO DO PEDIDO:
PEDIDO CONFIRMADO
[lista dos itens com precos]
Total: R$ XX,00
[retirada/delivery + endereco]
Pagamento: PIX ${PIX}

Responda SEMPRE em portugues brasileiro.`;
}

async function getHistory(phone) {
  try {
    const { data } = await supabase
      .from("conversas")
      .select("mensagens")
      .eq("telefone", phone)
      .single();
    return data?.mensagens || [];
  } catch {
    return [];
  }
}

async function saveHistory(phone, messages) {
  try {
    const recent = messages.slice(-20);
    await supabase.from("conversas").upsert(
      { telefone: phone, mensagens: recent, atualizado_em: new Date() },
      { onConflict: "telefone" }
    );
  } catch (e) {
    console.error("Erro ao salvar historico:", e.message);
  }
}

async function saveOrder(phone, message, response) {
  try {
    if (response.includes("PEDIDO CONFIRMADO")) {
      await supabase.from("pedidos").insert({
        telefone: phone,
        mensagem_cliente: message,
        resposta_agente: response,
        criado_em: new Date(),
      });
    }
  } catch (e) {
    console.error("Erro ao salvar pedido:", e.message);
  }
}

async function callGroq(history, userMessage) {
  const messages = [
    { role: "system", content: buildSystemPrompt() },
    ...history.map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: m.content,
    })),
    { role: "user", content: userMessage },
  ];

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
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
  try {
    const response = await fetch(
      `${process.env.EVOLUTION_API_URL}/message/sendText/${process.env.EVOLUTION_INSTANCE}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          apikey: process.env.EVOLUTION_API_KEY,
        },
        body: JSON.stringify({
          number: phone,
          textMessage: { text: message },
        }),
      }
    );
    const result = await response.json();
    console.log("Resultado envio WhatsApp:", JSON.stringify(result));
    return response.ok;
  } catch (e) {
    console.error("Erro ao enviar WhatsApp:", e.message);
    return false;
  }
}

function extractPhone(body) {
  if (!body?.data?.key?.remoteJid) return null;
  if (body.data.key.fromMe) return null;

  const remoteJid = body.data.key.remoteJid;

  // Se vier @lid, tenta pegar o numero real
  if (remoteJid.includes("@lid")) {
    // remoteJidAlt tem o numero real em versoes mais novas
    const alt = body.data.key.remoteJidAlt;
    if (alt) return alt.replace("@s.whatsapp.net", "");
    // sender tambem pode ter o numero real
    const sender = body.data.sender;
    if (sender) return sender.replace("@s.whatsapp.net", "").replace("@lid", "");
    // Fallback: usa o proprio @lid (a Evolution API v1.8.2 aceita enviar para @lid)
    return remoteJid;
  }

  return remoteJid.replace("@s.whatsapp.net", "");
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
      phone = extractPhone(body);
      message = body.data.message?.conversation || body.data.message?.extendedTextMessage?.text;
    } else if (body?.entry?.[0]?.changes?.[0]?.value?.messages?.[0]) {
      const msg = body.entry[0].changes[0].value.messages[0];
      phone = msg.from;
      message = msg.text?.body;
    }

    if (!phone || !message) return res.status(200).json({ ok: true });
    if (phone.includes("@g.us")) return res.status(200).json({ ok: true });

    console.log(`Mensagem de ${phone}: ${message}`);

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

    console.log(`Resposta enviada para ${phone}`);
    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error("Erro no webhook:", error);
    return res.status(500).json({ error: error.message });
  }
}
