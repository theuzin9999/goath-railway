const { chromium } = require('playwright');

// ===================== CONFIG =====================
let FIREBASE_URL = (process.env.FIREBASE_HISTORY_URL || "https://goathvelas-default-rtdb.firebaseio.com/").replace(/\/+$/, "");
if (!FIREBASE_URL.endsWith("/history")) FIREBASE_URL += "/history";
const AVIATOR_USER_URL = process.env.AVIATOR_USER_URL || "COLE_AQUI_O_SEU_URL_COMPLETO";

const WATCHDOG_MS = Number(process.env.WATCHDOG_MIN || 3.5) * 60 * 1000;     // sem vela nova -> reinicia
const RESTART_MS  = Number(process.env.REINICIO_HORAS || 3) * 60 * 60 * 1000; // reinício programado
const RELOAD_MS   = 30 * 60 * 1000;                                           // reload leve da página
const LOOP_MS     = 3000;
const RAF_FPS     = Number(process.env.RAF_FPS ?? 8); // limita a animação do jogo (0 = desliga o limite)
const LARGURA = Number(process.env.LARGURA || 480);  // janela menor = menos CPU/RAM
const ALTURA  = Number(process.env.ALTURA  || 640);

if (!FIREBASE_URL.startsWith("https://") || !AVIATOR_USER_URL || AVIATOR_USER_URL.includes("COLE_AQUI")) {
    console.error("ERRO CRÍTICO: configure AVIATOR_USER_URL nas variáveis de ambiente (Variables) do Railway!");
    process.exit(1);
}

const SELETOR_VELA = '.payouts-block .bubble-multiplier, .payout-item, app-stats-widget .bubble-multiplier, .bubble-multiplier, .payouts-wrapper span, [class*="payout"]';

// ===================== UTIL =====================
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function comTimeout(promise, ms, nome) {
    let t;
    const limite = new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`timeout em ${nome} (${ms}ms)`)), ms); });
    return Promise.race([promise, limite]).finally(() => clearTimeout(t));
}

const hora = () => new Date().toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour12: false });

// ===================== ESTADO (sobrevive entre reinícios do navegador) =====================
let ultimaVelaNova = Date.now(); // última vez que apareceu uma vela diferente na tela do jogo
let ultimaVelaSalva = "";        // evita salvar duplicada depois de reiniciar

function obterCor(valorNum) {
    if (valorNum >= 10) return "magenta-bg";
    if (valorNum >= 2) return "purple-bg";
    return "blue-bg";
}

async function salvarNoFirebase(valorStr) {
    const valorNum = parseFloat(valorStr);
    if (isNaN(valorNum) || valorNum <= 0) return false;

    const multFormatado = valorNum.toFixed(2);
    const agora = new Date();
    const [dia, mes, ano] = agora.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit' }).split('/');
    const horaStr = agora.toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    const micro = String(Math.floor(Math.random() * 900000) + 100000);
    const chaveNo = `${ano}-${mes}-${dia}_${horaStr.replace(/:/g, '-')}-${micro}_${multFormatado.replace('.', '-')}x`;

    const payload = { color: obterCor(valorNum), date: `${ano}-${mes}-${dia}`, multiplier: multFormatado, time: horaStr };

    try {
        const r = await fetch(`${FIREBASE_URL}/${chaveNo}.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(10000) // nunca fica pendurado esperando o Firebase
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        console.log(`[SALVO]: ${multFormatado}x às ${horaStr} (Horário de Brasília)`);
        return true;
    } catch (err) {
        console.error("Erro no Firebase:", err.message);
        return false;
    }
}

// Lê a vela mais recente direto no navegador (evaluate não deixa handles acumulando RAM)
async function lerUltimaVela(page) {
    for (const frame of page.frames()) {
        try {
            const txt = await frame.evaluate((sel) => {
                const el = document.querySelector(sel);
                return el ? el.innerText : null;
            }, SELETOR_VELA);
            if (txt && txt.trim()) return txt.trim();
        } catch (e) { /* frame destruído/sem acesso */ }
    }
    return null;
}

let ultimaVistaDom = null;
async function tick(page) {
    const texto = await lerUltimaVela(page);
    if (!texto) return;
    const valorNum = parseFloat(texto.replace('x', '').replace(',', '.').trim());
    if (isNaN(valorNum) || valorNum <= 0) return;
    const v = valorNum.toFixed(2);

    if (v !== ultimaVistaDom) {       // apareceu vela nova na tela -> zera o watchdog
        ultimaVistaDom = v;
        ultimaVelaNova = Date.now();
    }
    if (v !== ultimaVelaSalva) {      // só marca como salva se o Firebase confirmou (senão tenta de novo)
        if (await salvarNoFirebase(v)) ultimaVelaSalva = v;
    }
}

async function fecharNavegador(browser) {
    if (!browser) return;
    try {
        await comTimeout(browser.close(), 10000, 'fechar navegador');
    } catch (e) {
        console.error("Navegador não fechou direito; encerrando o processo para o AUTORESTART religar:", e.message);
        process.exit(1);
    }
}

// ===================== UM CICLO = UM NAVEGADOR =====================
async function rodarCiclo() {
    const inicio = Date.now();
    ultimaVelaNova = inicio;
    ultimaVistaDom = null;
    let motivo = null;
    let browser = null;
    const pedir = (m) => { if (!motivo) motivo = m; };

    try {
        browser = await comTimeout(chromium.launch({
            headless: true,
            args: [
                '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
                `--window-size=${LARGURA},${ALTURA}`,
                '--mute-audio', '--disable-extensions', '--disable-background-networking',
                '--disable-sync', '--disable-translate', '--no-first-run', '--metrics-recording-only',
                '--renderer-process-limit=1', '--disable-software-rasterizer', '--disable-features=Translate,BackForwardCache,MediaRouter,OptimizationHints',
                '--js-flags=--max-old-space-size=256'
            ]
        }), 90000, 'abrir navegador');

        browser.on('disconnected', () => pedir('navegador caiu/desconectou'));

        const context = await browser.newContext({ viewport: { width: LARGURA, height: ALTURA }, locale: 'pt-BR' });
        // Economia de CPU: o jogo redesenha a ~60fps sem ninguém olhando. Limita a animação (os dados continuam chegando normal).
        if (RAF_FPS > 0) {
            await context.addInitScript((fps) => {
                const ms = 1000 / fps;
                window.requestAnimationFrame = (cb) => setTimeout(() => cb(performance.now()), ms);
                window.cancelAnimationFrame = (id) => clearTimeout(id);
            }, RAF_FPS);
        }
        const page = await context.newPage();
        page.on('crash', () => pedir('página crashou (provável falta de RAM)'));

        // Bloqueio desligado por padrão (quebra o jogo). BLOQUEAR=1 liga só para teste.
        if (process.env.BLOQUEAR === '1') await page.route('**/*', (route) => {
            const t = route.request().resourceType();
            return (t === 'media' || t === 'font' || (process.env.BLOQUEAR_IMG === '1' && t === 'image')) ? route.abort() : route.continue();
        });

        // Captura extra via respostas de API. NÃO conta para o watchdog.
        page.on('response', async (response) => {
            const url = response.url();
            if (!(url.includes('payouts') || url.includes('history') || url.includes('stats'))) return;
            try {
                const matches = (await response.text()).match(/\d+\.\d{2}x?/g);
                if (matches && matches.length > 0) {
                    const ultima = parseFloat(matches[0].replace('x', '')).toFixed(2);
                    if (ultima !== ultimaVelaSalva && await salvarNoFirebase(ultima)) ultimaVelaSalva = ultima;
                }
            } catch (e) {}
        });

        console.log("Acessando o URL do Aviator...");
        try {
            await page.goto(AVIATOR_USER_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
        } catch (e) {
            console.log("Aviso de carregamento inicial:", e.message);
        }
        await sleep(10000);

        // Diagnóstico único por ciclo (sem a URL secreta)
        try {
            const host = (() => { try { return new URL(page.url()).host; } catch { return '?'; } })();
            console.log(`[DIAG] host=${host} titulo="${await comTimeout(page.title(), 5000, 'title')}" frames=${page.frames().length}`);
        } catch (e) { console.log('[DIAG] erro:', e.message); }

        let ultimoReload = Date.now();
        while (!motivo) {
            await sleep(LOOP_MS);
            const agora = Date.now();

            if (agora - ultimaVelaNova > WATCHDOG_MS) {
                pedir(`WATCHDOG: ${Math.round((agora - ultimaVelaNova) / 1000)}s sem vela nova`);
                break;
            }
            if (agora - inicio > RESTART_MS) {
                pedir('reinício programado (liberar RAM)');
                break;
            }

            try { await comTimeout(tick(page), 20000, 'leitura da vela'); }
            catch (e) { console.error("Erro no loop:", e.message); }

            if (Date.now() - ultimoReload > RELOAD_MS) {
                ultimoReload = Date.now();
                console.log("🔄 Recarregando a página (prevenção de leak)...");
                try {
                    await comTimeout(page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 }), 70000, 'reload');
                    await sleep(10000);
                } catch (e) { console.log("Aviso ao recarregar:", e.message); }
            }
        }
    } catch (e) {
        pedir(`erro: ${e.message}`);
    } finally {
        await fecharNavegador(browser);
    }
    return motivo;
}

// ===================== SUPERVISOR =====================
process.on('unhandledRejection', (e) => console.error('unhandledRejection:', e && e.message));
process.on('uncaughtException', (e) => console.error('uncaughtException:', e && e.message));

// Última barreira: se o supervisor travar de verdade, mata o processo e o AUTORESTART religa.
setInterval(() => {
    if (Date.now() - ultimaVelaNova > WATCHDOG_MS + 2 * 60 * 1000) {
        console.error("⚠️ WATCHDOG DURO: ciclo travado, encerrando o processo.");
        process.exit(1);
    }
}, 30000);

(async () => {
    console.log("Iniciando robô em modo resiliente 24/7...");
    let falhasSeguidas = 0;
    while (true) {
        const t0 = Date.now();
        const motivo = await rodarCiclo();
        console.log(`♻️ [${hora()}] Reiniciando navegador — motivo: ${motivo}`);
        falhasSeguidas = (Date.now() - t0 < 60000) ? falhasSeguidas + 1 : 0;
        await sleep(Math.min(5000 + falhasSeguidas * 10000, 60000));
    }
})();
