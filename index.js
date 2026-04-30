const fs = require('fs');
const path = require('path');

function carregarEnv(arquivo = '.env') {
    const envPath = path.resolve(__dirname, arquivo);

    if (!fs.existsSync(envPath)) {
        return;
    }

    const conteudo = fs.readFileSync(envPath, 'utf8');

    for (const linha of conteudo.split(/\r?\n/)) {
        const texto = linha.trim();

        if (!texto || texto.startsWith('#')) {
            continue;
        }

        const separadorIndex = texto.indexOf('=');

        if (separadorIndex === -1) {
            continue;
        }

        const chave = texto.slice(0, separadorIndex).trim();
        let valor = texto.slice(separadorIndex + 1).trim();

        if (
            (valor.startsWith('"') && valor.endsWith('"')) ||
            (valor.startsWith("'") && valor.endsWith("'"))
        ) {
            valor = valor.slice(1, -1);
        }

        if (!(chave in process.env)) {
            process.env[chave] = valor;
        }
    }
}

carregarEnv();

process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// =============================
// CONFIG
// =============================

const CONFIG = {
    MODE: 2, // 1 = histórico | 2 = realtime

    N8N_WEBHOOK_URL: process.env.N8N_WEBHOOK_URL,

    SUPORT_PHONES: [
        '555181129332@c.us',
        '555121659658@c.us',
        '555181097062@c.us',
        '5551990176857@c.us'
    ],

    SLA_MINUTES: 30, // tempo de resposta padrão
    TIMEZONE: 'America/Sao_Paulo',

    DIAS_HISTORICO: 7,
    LIMITE_MENSAGENS: 10
};

//const SLA_MS = CONFIG.SLA_MINUTES * 1000; // SEGUNDOS PARA TESTE
const SLA_MS = CONFIG.SLA_MINUTES * 60 * 1000; // MINUTOS


// =============================
// ESTADO
// =============================

const grupos = {};
const mensagensRelevantes = {};
const nomesGrupos = {};
const timers = {};
const fetch = (...args) =>
    import('node-fetch').then(({ default: fetch }) => fetch(...args));

// =============================
// FUNÇÕES
// =============================

function isAtendente(numero) {
    return CONFIG.SUPORT_PHONES.includes(numero);
}

const MENSAGENS_IGNORADAS = [
    'ok','blz','beleza','valeu','obrigado','obrigada','obg',
    '👍','👍🏻','👍🏽','👍🏿','top','show','obrigado!', 'obrigado!!'
];

function normalizar(texto) {
    return texto.toLowerCase().trim().replace(/[^\w\s]/gi, '');
}

function isMensagemIgnorada(texto) {
    const t = normalizar(texto);
    if (t.length > 10) return false;
    return MENSAGENS_IGNORADAS.includes(t);
}

function formatarData(timestamp) {
    return new Date(timestamp).toLocaleString('pt-BR', {
        timeZone: CONFIG.TIMEZONE
    });
}

function obterChaveDia(timestamp) {
    return new Intl.DateTimeFormat('sv-SE', {
        timeZone: CONFIG.TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit'
    }).format(new Date(timestamp));
}

function formatarDuracao(tempoMs) {
    const totalSegundos = Math.floor(tempoMs / 1000);

    if (totalSegundos <= 59) {
        return `${totalSegundos}s`;
    }

    const totalMinutos = Math.floor(totalSegundos / 60);

    if (totalMinutos <= 59) {
        return `${totalMinutos}min`;
    }

    const totalHoras = Math.floor(totalMinutos / 60);
    return `${totalHoras}h`;
}

function esperar(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function enviarWhatsApp(atendente, mensagem) {
    try {
        await client.sendMessage(atendente, mensagem);
        console.log(`WhatsApp enviado para ${atendente}`);
    } catch (err) {
        console.error(`Erro ao enviar WhatsApp para ${atendente}:`, err.message);
    }
}

async function enviarParaN8N(dados) {
    if (!CONFIG.N8N_WEBHOOK_URL) {
        console.error('N8N_WEBHOOK_URL não configurada no ambiente.');
        return;
    }

    try {
        const res = await fetch(CONFIG.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(dados)
        });

        const text = await res.text();

        console.log('Enviado para n8n:', res.status, text);

         // Foreach em atendentes (obj em config)
        for (const atendente of CONFIG.SUPORT_PHONES) {
            const mensagem = `Tempo de espera excedido*

    📌 Grupo: ${dados.group_name}
    ⏱ Tempo sem resposta: ${dados.tempo_sem_resposta}s
    🕒 Última mensagem: ${dados.ultima_mensagem_cliente}

    Corre lá responder 👀`;

                await enviarWhatsApp(atendente, mensagem);
            }

        } catch (err) {
            console.error('Erro ao enviar pro n8n:', err.message);
        }
    }

async function obterMensagensHistorico(chat, limite) {
    const chatId = chat.id._serialized;

    try {
        await chat.syncHistory();
    } catch (err) {
        console.warn(`Falha ao sincronizar histórico de ${chat.name}:`, err.message);
    }

    try {
        await client.interface.openChatWindow(chatId);
        await esperar(500);
    } catch (err) {
        console.warn(`Falha ao abrir chat ${chat.name}:`, err.message);
    }

    try {
        const mensagens = await client.pupPage.evaluate(async (chatId, limite) => {
            const chat = await window.WWebJS.getChat(chatId, { getAsModel: false });

            if (!chat?.msgs) {
                return [];
            }

            let msgs = chat.msgs.getModelsArray().filter(m => !m.isNotification);

            msgs.sort((a, b) => (a.t > b.t ? 1 : -1));

            if (limite > 0 && msgs.length > limite) {
                msgs = msgs.slice(-limite);
            }

            return msgs.map(m => ({
                timestamp: m.t,
                hasMedia: Boolean(m.directPath),
                body: m.directPath ? (m.caption || '') : (m.body || m.pollName || m.eventName || ''),
                fromMe: Boolean(m.id?.fromMe),
                author: m.author?._serialized || null,
                from: m.from?._serialized || null
            }));
        }, chatId, limite);

        return Array.isArray(mensagens) ? mensagens : [];
    } catch (err) {
        console.error(`Erro ao carregar mensagens do grupo ${chat.name}:`, err.message);
        return [];
    }
}

// =============================
// SLA TIMER (CORE)
// =============================

function agendarSLA(grupo, nomeGrupo) {
    if (timers[grupo]) {
        clearTimeout(timers[grupo]);
    }

    timers[grupo] = setTimeout(() => {
        const g = grupos[grupo];

        if (
            g &&
            g.ultimaMensagemCliente &&
            (
                !g.ultimaMensagemAtendente ||
                g.ultimaMensagemCliente > g.ultimaMensagemAtendente
            )
        ) {
            const agora = Date.now();
            const tempo = agora - g.ultimaMensagemCliente;

            console.log('ALERTA SLA ESTOURADO');
            console.log(`Grupo: ${nomeGrupo}`);
            console.log(`Última msg: ${formatarData(g.ultimaMensagemCliente)}`);
            console.log(formatarDuracao(tempo));
            console.log('-------------------');

            enviarParaN8N({
                group_id: grupo,
                group_name: nomeGrupo,
                ultima_mensagem_cliente: formatarData(g.ultimaMensagemCliente),
                tempo_sem_resposta: Math.floor(tempo / 1000),
                tipo: 'Mais de 30 minutos sem resposta',
                msg_sent: mensagensRelevantes[grupo] && mensagensRelevantes[grupo].length > 0 ? mensagensRelevantes[grupo][mensagensRelevantes[grupo].length - 1].mensagem : ''
            });

            g.alertado = true;
        }
    }, SLA_MS);
}

// =============================
// CLIENT
// =============================

const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

// =============================
// EVENTOS
// =============================

client.on('qr', (qr) => {
    console.log('📱 Escaneie o QR:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Autenticado');
});

client.on('ready', async () => {
    console.log('Conectado e pronto!');

    if (CONFIG.MODE === 1) {
        await processarHistorico();
    }

    if (CONFIG.MODE === 2) {
        console.log('MODO REALTIME ATIVO');
    }
});

client.on('disconnected', (reason) => {
    console.log('Desconectado:', reason);
    client.initialize();
});

// =============================
// HISTÓRICO
// =============================

async function processarHistorico() {
    console.log('MODO HISTÓRICO');

    const chats = await client.getChats();
    const agora = Date.now();
    const diaAtual = obterChaveDia(agora);

    for (const chat of chats) {
        if (!chat.isGroup) continue;

        const nomeGrupo = chat.name;
        console.log('\nGrupo:', nomeGrupo);

        const mensagens = await obterMensagensHistorico(chat, CONFIG.LIMITE_MENSAGENS);

        if (mensagens.length === 0) {
            console.log('Sem mensagens carregadas');
            continue;
        }

        let ultimaCliente = null;
        let ultimaAtendente = null;
        let ultimaMensagem = null;

        for (const msg of mensagens) {
            const timestamp = msg.timestamp * 1000;
            if (obterChaveDia(timestamp) !== diaAtual) continue;

            const numero = msg.author || msg.from;
            const texto = msg.body || '';

            if (!numero) continue;

            if (isAtendente(numero)) {
                ultimaAtendente = timestamp;
                continue;
            }

            if (!texto || texto.length < 2) continue;
            if (msg.hasMedia) continue;
            if (isMensagemIgnorada(texto)) continue;

            ultimaCliente = timestamp;
            ultimaMensagem = texto;
        }

        if (
            ultimaCliente &&
            (!ultimaAtendente || ultimaCliente > ultimaAtendente)
        ) {
            const tempo = agora - ultimaCliente;

            console.log('SEM RESPOSTA');
            console.log(`Última: ${formatarData(ultimaCliente)}`);
            console.log(formatarDuracao(tempo));

            await enviarParaN8N({
                group_name: nomeGrupo,
                ultima_mensagem_cliente: ultimaCliente,
                tempo_sem_resposta: Math.floor(tempo / 1000),
                tipo: 'HISTORICO_SEM_RESPOSTA',
                msg_sent: ultimaMensagem
            });

        } else {
            console.log('OK');
        }
    }

    console.log('\nHistórico finalizado');
}

// =============================
// REALTIME
// =============================

client.on('message', async msg => {
    if (CONFIG.MODE !== 2) return;

    if (!msg.from.endsWith('@g.us')) return;

    const contato = await msg.getContact();
    const numero = contato.number + '@c.us';

    const grupo = msg.from;
    const agora = Date.now();

    let nomeGrupo;

    if (nomesGrupos[grupo]) {
        nomeGrupo = nomesGrupos[grupo];
    } else {
        const chat = await msg.getChat();
        nomeGrupo = chat.name;
        nomesGrupos[grupo] = nomeGrupo;
    }

    if (!grupos[grupo]) {
        grupos[grupo] = {
            ultimaMensagemCliente: null,
            ultimaMensagemAtendente: null,
            alertado: false
        };
    }

    if (!mensagensRelevantes[grupo]) {
        mensagensRelevantes[grupo] = [];
    }

    const g = grupos[grupo];
    const texto = msg.body || '';

    console.log('-------------------');
    console.log('Grupo:', nomeGrupo);
    console.log('Número:', numero);
    console.log('Mensagem:', texto);

    if (isAtendente(numero)) {
        g.ultimaMensagemAtendente = agora;
        g.alertado = false;

        if (timers[grupo]) {
            clearTimeout(timers[grupo]);
        }

        console.log('ATENDENTE');
        return;
    }

    // ignoradas
    if (isMensagemIgnorada(texto)) {
        console.log('Ignorada');
        return;
    }

    g.ultimaMensagemCliente = agora;
    g.alertado = false;

    mensagensRelevantes[grupo].push({
        numero,
        mensagem: texto,
        timestamp: agora
    });

    console.log('MENSAGEM RELEVANTE');
    console.log(mensagensRelevantes[grupo]);

    agendarSLA(grupo, nomeGrupo);
});

// =============================
// START
// =============================

client.initialize();
