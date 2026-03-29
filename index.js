const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');

// =============================
// CONFIG
// =============================

const CONFIG = {
    MODE: 2, // 1 = histórico | 2 = realtime

    SUPORT_PHONES: [
        '555181129332@c.us'
    ],

    SLA_MINUTES: 5, // tempo de resposta padrão
    TIMEZONE: 'America/Sao_Paulo',

    DIAS_HISTORICO: 7,
    LIMITE_MENSAGENS: 10
};

const SLA_MS = CONFIG.SLA_MINUTES * 1000;
// const SLA_MS = CONFIG.SLA_MINUTES * 60 * 1000;


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

async function enviarParaN8N(dados) {
    try {
        const res = await fetch('https://veda-maternalistic-graciela.ngrok-free.dev/webhook/whatsapp-group-monitor', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(dados)
        });

        const text = await res.text();

        console.log('Enviado para n8n:', res.status, text);
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
                grupoId: grupo,
                grupo: nomeGrupo,
                ultimaMensagemCliente: formatarData(g.ultimaMensagemCliente),
                tempoSemResposta: Math.floor(tempo / 1000),
                tipo: 'Mais de 30 minutos sem resposta'
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
                grupo: nomeGrupo,
                ultimaMensagemCliente: ultimaCliente,
                tempoSemResposta: Math.floor(tempo / 1000),
                tipo: 'HISTORICO_SEM_RESPOSTA'
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

    // ATENDENTE
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

    // CLIENTE
    g.ultimaMensagemCliente = agora;
    g.alertado = false;

    mensagensRelevantes[grupo].push({
        numero,
        mensagem: texto,
        timestamp: agora
    });

    console.log('MENSAGEM RELEVANTE');
    console.log(mensagensRelevantes[grupo]);

    // agenda SLA
    agendarSLA(grupo, nomeGrupo);
});

// =============================
// START
// =============================

client.initialize();