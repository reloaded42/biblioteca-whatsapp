// ============================================================
//  Servicio de WhatsApp para la Biblioteca (v5 - Baileys / Render)
//  Conecta una cuenta de WhatsApp usando Baileys (WebSocket, SIN
//  navegador) y expone endpoints HTTP que el PHP usa para enviar
//  los codigos OTP / avisos.
//
//  Variables de entorno:
//    PORT           -> puerto (Render lo asigna)
//    HOST           -> 0.0.0.0 por defecto
//    SITE_BASE_URL  -> URL del sitio PHP (para callbacks)
//    WA_AUTH_PATH   -> carpeta donde guardar la sesion
//    WA_API_KEY     -> (opcional) clave para proteger /send
// ============================================================
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  Browsers
} from '@whiskeysockets/baileys';
import qrcode from 'qrcode';
import qrcodeTerminal from 'qrcode-terminal';
import pino from 'pino';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PUERTO = parseInt(process.env.PORT || '4200', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_BASE_URL = String(process.env.SITE_BASE_URL || 'https://bibliotecaiemr.infy.click').replace(/\/+$/, '');
const WA_API_KEY = process.env.WA_API_KEY || '';
const WA_AUTH_PATH = process.env.WA_AUTH_PATH || path.join(__dirname, '.baileys_auth');

const MAX_INTENTOS_ENVIO = 3;
const DIR_LOG = path.join(__dirname, 'logs');
const ARCHIVO_LOG = path.join(DIR_LOG, 'servicio.log');
if (!fs.existsSync(DIR_LOG)) fs.mkdirSync(DIR_LOG, { recursive: true });
if (!fs.existsSync(WA_AUTH_PATH)) { try { fs.mkdirSync(WA_AUTH_PATH, { recursive: true }); } catch (e) {} }

const logger = pino({ level: process.env.BAILEYS_LOG_LEVEL || 'silent' });

let clienteListo = false;
let sock = null;
let intentando = false;
let genQr = 0;
let qrPngBuf = null;
let numeroConectado = null;
let nombreConectado = null;

const confirmaciones = new Map();
const notificacionesEstudiante = new Map();

function logLine(lugar, texto) {
  const linea = '[' + new Date().toISOString() + '] [' + lugar + '] ' + texto + '\n';
  try { fs.appendFileSync(ARCHIVO_LOG, linea); } catch (e) {}
  console.log(linea.trimEnd());
}

function ahora() { return new Date().toISOString(); }

function soloNumero(jid) {
  return String(jid || '').split('@')[0].split(':')[0].replace(/\D/g, '');
}

function registrarConfirmacion(numero, loanId, authCode) {
  const key = numero + '|' + loanId + '|' + authCode;
  confirmaciones.set(key, { loanId, numero, authCode, fecha: Date.now() });
  logLine('confirm', 'Esperando confirmacion para prestamo #' + loanId + ' de ' + numero);
  return key;
}

function registrarNotificacionEstudiante(numero, loanId, authCode) {
  const key = numero + '|' + loanId;
  notificacionesEstudiante.set(key, { loanId, numero, authCode, fecha: Date.now() });
  logLine('confirm', 'Esperando confirmacion del estudiante para prestamo #' + loanId);
  return key;
}

function verificarConfirmacion(numero, texto) {
  const limpio = texto.trim().toUpperCase();
  for (const [key, info] of confirmaciones) {
    if (info.numero === numero) {
      if (limpio === 'SÍ' || limpio === 'SI') {
        confirmaciones.delete(key);
        logLine('confirm', 'Confirmacion APROBADA por ' + numero + ' para prestamo #' + info.loanId);
        return { aprobado: true, loanId: info.loanId, authCode: info.authCode };
      }
      if (limpio === 'NO') {
        confirmaciones.delete(key);
        logLine('confirm', 'Confirmacion RECHAZADA por ' + numero + ' para prestamo #' + info.loanId);
        return { aprobado: false, loanId: info.loanId, authCode: info.authCode };
      }
    }
  }
  return null;
}

function verificarRespuestaEstudiante(numero, texto) {
  const limpio = texto.trim().toUpperCase();
  for (const [key, info] of notificacionesEstudiante) {
    if (info.numero === numero) {
      if (limpio === 'Sí' || limpio === 'SI') {
        notificacionesEstudiante.delete(key);
        logLine('confirm', 'Estudiante CONFIRMO prestamo #' + info.loanId);
        return { confirmado: true, loanId: info.loanId, authCode: info.authCode };
      }
      if (limpio === 'NO') {
        notificacionesEstudiante.delete(key);
        logLine('confirm', 'Estudiante RECHAZO prestamo #' + info.loanId);
        return { confirmado: false, loanId: info.loanId, authCode: info.authCode };
      }
    }
  }
  return null;
}

function notificarPhp(query) {
  const phpUrl = SITE_BASE_URL + '/api.php?' + query;
  http.get(phpUrl, (resp) => {
    let d = '';
    resp.on('data', (c) => d += c);
    resp.on('end', () => logLine('confirm', 'Respuesta PHP: ' + d));
  }).on('error', (e) => logLine('confirm', 'Error PHP: ' + String(e)));
}

const textoDeMensaje = (msg) =>
  msg.message?.conversation ||
  msg.message?.extendedTextMessage?.text ||
  msg.message?.imageMessage?.caption ||
  msg.message?.videoMessage?.caption ||
  '';

async function iniciar() {
  if (intentando) return;
  intentando = true;
  try {
    const { state, saveCreds } = await useMultiFileAuthState(WA_AUTH_PATH);
    let version;
    try {
      const info = await fetchLatestBaileysVersion();
      version = info.version;
    } catch (e) {
      logLine('init', 'No se pudo obtener version, usando la por defecto: ' + String(e.message || e));
    }

    sock = makeWASocket({
      version,
      auth: {
        creds: state.creds,
        keys: makeCacheableSignalKeyStore(state.keys, logger)
      },
      logger,
      printQRInTerminal: false,
      browser: Browsers.ubuntu('Chrome'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        genQr++;
        logLine('qr', 'QR generado (#' + genQr + '), esperando escaneo...');
        console.log('\n========= ESCANEA ESTE QR CON EL WHATSAPP DE LA BIBLIOTECA =========');
        console.log('(WhatsApp > Ajustes > Dispositivos vinculados > Vincular dispositivo)\n');
        try { qrcodeTerminal.generate(qr, { small: true }); } catch (e) {}
        qrcode.toBuffer(qr, { type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111b21', light: '#ffffff' } })
          .then((buf) => { qrPngBuf = buf; })
          .catch((e) => logLine('qr', 'No se pudo dibujar QR imagen: ' + String(e.message || e)));
      }

      if (connection === 'open') {
        clienteListo = true;
        numeroConectado = soloNumero(sock?.user?.id) || null;
        nombreConectado = (sock?.user && sock.user.name) || null;
        logLine('ready', 'WhatsApp conectado. Cuenta: ' + (nombreConectado || '') + ' (' + numeroConectado + ')');
      }

      if (connection === 'close') {
        clienteListo = false;
        numeroConectado = null;
        nombreConectado = null;
        const code = lastDisconnect?.error?.output?.statusCode;
        const cerrarSesion = code === DisconnectReason.loggedOut;
        logLine('disc', 'Conexion cerrada. code=' + code + ' logout=' + cerrarSesion);
        if (cerrarSesion) {
          try { fs.rmSync(WA_AUTH_PATH, { recursive: true, force: true }); } catch (e) {}
          try { fs.mkdirSync(WA_AUTH_PATH, { recursive: true }); } catch (e) {}
          qrPngBuf = null;
        }
        intentando = false;
        setTimeout(() => { iniciar().catch((e) => logLine('init', 'Error: ' + String(e.message || e))); }, 3000);
        return;
      }
    });

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify' || !clienteListo) return;
      for (const msg of messages) {
        try {
          if (!msg.message || msg.key?.fromMe) continue;
          const numero = soloNumero(msg.key?.remoteJid);
          const texto = textoDeMensaje(msg);
          if (!numero || !texto) continue;

          const rEst = verificarRespuestaEstudiante(numero, texto);
          if (rEst) {
            notificarPhp('action=student_confirm&loan_id=' + rEst.loanId + '&auth_code=' + rEst.authCode + '&confirmed=' + (rEst.confirmado ? '1' : '0'));
            continue;
          }

          const rAdm = verificarConfirmacion(numero, texto);
          if (rAdm) {
            notificarPhp('action=whatsapp_confirm&loan_id=' + rAdm.loanId + '&auth_code=' + rAdm.authCode + '&approved=' + (rAdm.aprobado ? '1' : '0'));
            continue;
          }
        } catch (e) {
          logLine('msg', 'Error procesando mensaje: ' + String(e.message || e));
        }
      }
    });

    intentando = false;
  } catch (e) {
    intentando = false;
    logLine('init', 'Error al iniciar sesion: ' + String(e.message || e));
    setTimeout(() => { iniciar().catch((err) => logLine('init', 'Error: ' + String(err.message || err))); }, 5000);
  }
}

async function enviarWhatsApp(telefono, mensaje) {
  const numero = String(telefono).replace(/\D/g, '');
  const jid = numero + '@s.whatsapp.net';
  if (!clienteListo || !sock) throw new Error('WhatsApp no conectado');

  try {
    const res = await sock.onWhatsApp(numero);
    if (Array.isArray(res) && res.length && res[0] && res[0].exists) {
      logLine('envio', 'Envio a ' + numero + ' -> jid ' + (res[0].jid || jid));
      return await sock.sendMessage(res[0].jid || jid, { text: mensaje });
    }
    logLine('envio', 'El numero ' + numero + ' no aparece en WhatsApp (onWhatsApp), intento directo');
  } catch (e) {
    logLine('envio', 'onWhatsApp fallo: ' + String(e.message || e) + ', intento directo');
  }
  return await sock.sendMessage(jid, { text: mensaje });
}

async function enviarConReintentos(telefono, mensaje) {
  let ultimoError = null;
  for (let intento = 1; intento <= MAX_INTENTOS_ENVIO; intento++) {
    try {
      const resultado = await enviarWhatsApp(telefono, mensaje);
      if (intento > 1) logLine('envio', 'Éxito en intento ' + intento + '/' + MAX_INTENTOS_ENVIO);
      return resultado;
    } catch (e) {
      ultimoError = e;
      logLine('envio', 'Intento ' + intento + '/' + MAX_INTENTOS_ENVIO + ' fallo: ' + String(e.message || e));
      if (intento < MAX_INTENTOS_ENVIO) await new Promise(r => setTimeout(r, 2000 * intento));
    }
  }
  throw ultimoError;
}

function authOk(req) {
  if (!WA_API_KEY) return true;
  return String(req.headers['x-api-key'] || '') === WA_API_KEY;
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && (url === '/health' || url === '/qrstate')) {
    return json(res, 200, { ok: true, ready: clienteListo, gen: genQr, uptime: process.uptime(), hora: ahora() });
  }

  if (req.method === 'GET' && url === '/qr-img') {
    if (!qrPngBuf) { res.writeHead(404); res.end('no-qr'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    res.end(qrPngBuf);
    return;
  }

  if (req.method === 'GET' && url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (clienteListo) {
      res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>WhatsApp vinculado</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#0b141a;color:#e9edef;text-align:center;padding:24px}h1{font-size:18px}.st{color:#7ff}</style></head><body><h1>WhatsApp ya está vinculado</h1><p class="st">Número: ' + (numeroConectado || '') + '</p></body></html>');
      return;
    }
    if (!qrPngBuf) {
      res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Vincular WhatsApp</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#0b141a;color:#e9edef;text-align:center;padding:24px}h1{font-size:18px}</style></head><body><h1>Generando el código QR...</h1><p>Recarga en unos segundos.</p></body></html>');
      return;
    }
    res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="18"><title>Vincular WhatsApp</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#0b141a;color:#e9edef;text-align:center;padding:24px 12px;margin:0}h1{font-size:18px;margin:0 0 6px}.st{color:#7ff}img{max-width:min(320px,90vw);border:10px solid #fff;border-radius:14px;background:#fff}.paso{max-width:430px;margin:12px auto 0;color:#b9bec3;font-size:13px;line-height:1.5}.ref{color:#7ff;font-size:12px;margin-top:10px}</style></head><body><h1>Vincular el WhatsApp que envía los códigos</h1><p class="st">Escanea este código con el WhatsApp de la biblioteca.</p><img src="/qr-img" alt="Código QR"><div class="paso">En el celular: <b>WhatsApp</b> &rsaquo; <b>Ajustes</b> &rsaquo; <b>Dispositivos vinculados</b> &rsaquo; <b>Vincular un dispositivo</b> y escanear este código.</div><div class="ref">La página se refresca sola. Escanéalo pronto (el código caduca).</div></body></html>');
    return;
  }

  if (req.method === 'GET' && url === '/status') {
    return json(res, 200, {
      ok: true,
      ready: clienteListo,
      numero: numeroConectado,
      nombre: nombreConectado,
      uptime: Math.round(process.uptime()),
      hora: ahora()
    });
  }

  if (!authOk(req)) {
    return json(res, 401, { ok: false, error: 'No autorizado' });
  }

  if (req.method === 'POST' && url === '/send') {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', async () => {
      try {
        const datos = JSON.parse(raw || '{}');
        const to = String(datos.to || '');
        const message = String(datos.message || '');
        if (!to || !message) return json(res, 400, { ok: false, error: 'Faltan to o message' });
        if (!clienteListo) return json(res, 503, { ok: false, error: 'WhatsApp no conectado (escanea el QR).' });
        const enviado = await enviarConReintentos(to, message);
        const idMsg = String((enviado && enviado.key && enviado.key.id) || '');
        return json(res, 200, { ok: true, sid: idMsg, to: to });
      } catch (e) {
        return json(res, 500, { ok: false, error: 'No se pudo enviar: ' + String(e.message || e).slice(0, 200) });
      }
    });
    return;
  }

  if (req.method === 'POST' && url === '/whatsapp-confirm') {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', async () => {
      try {
        const datos = JSON.parse(raw || '{}');
        const loanId = datos.loan_id;
        const numero = String(datos.numero || '');
        const authCode = String(datos.auth_code || '');
        const studentName = String(datos.student_name || 'Estudiante');
        const bookTitle = String(datos.book_title || 'libro');
        if (!loanId || !numero || !authCode) return json(res, 400, { ok: false, error: 'Faltan loan_id, numero o auth_code' });
        if (!clienteListo) return json(res, 503, { ok: false, error: 'WhatsApp no conectado (escanea el QR).' });
        const mensaje = 'Hola ' + studentName + ', tu solicitud del libro "' + bookTitle + '" fue registrada.\n\nTu codigo de autorizacion es: ' + authCode + '\n\nPresentalo al bibliotecario para completar el prestamo.';
        await enviarConReintentos(numero, mensaje);
        registrarConfirmacion(String(numero).replace(/\D/g, ''), loanId, authCode);
        return json(res, 200, { ok: true, msg: 'Enviado' });
      } catch (e) {
        return json(res, 500, { ok: false, error: 'No se pudo enviar: ' + String(e.message || e).slice(0, 200) });
      }
    });
    return;
  }

  return json(res, 404, { ok: false, error: 'Ruta no valida' });
});

server.listen(PUERTO, HOST, () => {
  logLine('srv', 'Servicio WhatsApp (Baileys) escuchando en http://' + HOST + ':' + PUERTO);
  logLine('srv', 'SITE_BASE_URL=' + SITE_BASE_URL + '  auth=' + WA_AUTH_PATH + '  apiKey=' + (WA_API_KEY ? 'si' : 'no'));
});

iniciar().catch((e) => logLine('init', 'Error al iniciar: ' + String(e.message || e)));

process.on('SIGTERM', () => { logLine('srv', 'SIGTERM, cerrando'); process.exit(0); });
process.on('SIGINT', () => { logLine('srv', 'SIGINT, cerrando'); process.exit(0); });
