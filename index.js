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
    ],

    SLA_MINUTES: 5, // tempo de resposta padrão
    TIMEZONE: 'America/Sao_Paulo',

    DIAS_HISTORICO: 7,
    LIMITE_MENSAGENS: 10
};

const SLA_MS = CONFIG.SLA_MINUTES * 1000; // SEGUNDOS PARA TESTE
// const SLA_MS = CONFIG.SLA_MINUTES * 60 * 1000; // MINUTOS


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

    📌 Grupo: ${dados.grupo}
    ⏱ Tempo sem resposta: ${dados.tempoSemResposta}s
    🕒 Última mensagem: ${dados.ultimaMensagemCliente}

    Corre lá responder 👀`;

                await enviarWhatsApp(atendente, mensagem);
            }

        } catch (err) {
            console.error('Erro ao enviar pro n8n:', err.message);
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
            console.log(`${Math.floor(tempo / 1000)}s`);
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
    const limiteTempo = agora - (CONFIG.DIAS_HISTORICO * 86400000);

    for (const chat of chats) {
        if (!chat.isGroup) continue;

        const nomeGrupo = chat.name;
        console.log('\nGrupo:', nomeGrupo);

        const mensagens = await chat.fetchMessages({ limit: CONFIG.LIMITE_MENSAGENS });

        let ultimaCliente = null;
        let ultimaAtendente = null;
        let ultimaMensagem = null;

        for (const msg of mensagens.reverse()) {
            const timestamp = msg.timestamp * 1000;
            if (timestamp < limiteTempo) continue;

            const contato = await msg.getContact();
            const numero = contato.number + '@c.us';
            const texto = msg.body || '';

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
            console.log(`${Math.floor(tempo / 1000)}s`);

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
