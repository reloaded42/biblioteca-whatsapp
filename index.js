// ============================================================
//  Servicio de WhatsApp para la Biblioteca (v4 - Render)
//  Conecta una cuenta de WhatsApp (via WhatsApp Web) y expone
//  endpoints HTTP que el PHP usa para enviar los codigos OTP.
//
//  Variables de entorno:
//    PORT                       -> puerto (Render lo asigna)
//    HOST                       -> 0.0.0.0 por defecto
//    SITE_BASE_URL              -> URL del sitio PHP (para callbacks)
//    WA_AUTH_PATH               -> carpeta donde guardar la sesion
//    WA_API_KEY                 -> (opcional) clave para proteger /send
//    PUPPETEER_EXECUTABLE_PATH  -> ruta a chromium del sistema
// ============================================================
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const qrImagen = require('qrcode');
const http = require('http');
const fs = require('fs');
const path = require('path');

const PUERTO = parseInt(process.env.PORT || '4200', 10);
const HOST = process.env.HOST || '0.0.0.0';
const SITE_BASE_URL = String(process.env.SITE_BASE_URL || 'https://bibliotecaiemr.infy.click').replace(/\/+$/, '');
const WA_API_KEY = process.env.WA_API_KEY || '';
const WA_AUTH_PATH = process.env.WA_AUTH_PATH || path.join(__dirname, '.wwebjs_auth');
const PUPPETEER_EXECUTABLE_PATH = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;

const ACK_TIMEOUT_MS = 30000;
const MAX_INTENTOS_ENVIO = 3;
const DIR_LOG = path.join(__dirname, 'logs');
const ARCHIVO_LOG = path.join(DIR_LOG, 'servicio.log');
if (!fs.existsSync(DIR_LOG)) fs.mkdirSync(DIR_LOG, { recursive: true });
if (!fs.existsSync(WA_AUTH_PATH)) { try { fs.mkdirSync(WA_AUTH_PATH, { recursive: true }); } catch (e) {} }

let clienteListo = false;
let shutdownEnCurso = false;
let reiniciando = false;
let client = null;
let genQr = 0;
let qrPngBuf = null;

const pendientesAck = new Map();
const confirmaciones = new Map();
const notificacionesEstudiante = new Map();

function logLine(lugar, texto) {
  const linea = '[' + new Date().toISOString() + '] [' + lugar + '] ' + texto + '\n';
  try { fs.appendFileSync(ARCHIVO_LOG, linea); } catch (e) {}
  console.log(linea.trimEnd());
}

function ahora() { return new Date().toISOString(); }

function claveMensaje(chat, cuerpo) {
  const t = String(chat || '').replace(/\D/g, '') || '*';
  const b = String(cuerpo || '').replace(/\s+/g, ' ').trim();
  return t + '|' + b;
}

function limpiarPendientesAck() {
  for (const [key, pend] of pendientesAck) {
    clearTimeout(pend.timer);
    pend.resolve({ ack: 0, caducado: true });
  }
  pendientesAck.clear();
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
      if (limpio === 'Sí' || limpio === 'SI') {
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

function crearCliente() {
  const c = new Client({
    authStrategy: new LocalAuth({ clientId: 'biblioteca', dataPath: WA_AUTH_PATH }),
    puppeteer: {
      headless: true,
      executablePath: PUPPETEER_EXECUTABLE_PATH,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu', '--disable-dev-shm-usage']
    }
  });

  c.on('qr', (qr) => {
    genQr++;
    logLine('qr', 'QR generado (#' + genQr + '), esperando escaneo...');
    console.log('\n========= ESCANEA ESTE QR CON EL WHATSAPP DE LA BIBLIOTECA =========');
    console.log('(WhatsApp > Ajustes > Dispositivos vinculados > Vincular dispositivo)\n');
    qrcode.generate(qr, { small: true });
    qrImagen.toBuffer(qr, { type: 'png', width: 360, margin: 1, errorCorrectionLevel: 'M', color: { dark: '#111b21', light: '#ffffff' } })
      .then((buf) => { qrPngBuf = buf; })
      .catch((e) => logLine('qr', 'No se pudo dibujar QR imagen: ' + String(e.message || e)));
  });

  c.on('ready', () => {
    clienteListo = true;
    reiniciando = false;
    let telefono = 'desconocido';
    try { telefono = (c.info && c.info.wid && c.info.wid.user) || telefono; } catch (e) {}
    logLine('ready', 'WhatsApp conectado. Cuenta: ' + (c.info && c.info.me && c.info.me.name ? c.info.me.name : '') + ' (' + telefono + ')');
  });

  c.on('auth_failure', (msg) => {
    logLine('auth', 'Fallo la autenticacion: ' + String(msg));
    clienteListo = false;
  });

  c.on('disconnected', (razon) => {
    logLine('disc', 'Desconectado: ' + String(razon) + '. Destruyendo y recreando...');
    clienteListo = false;
    limpiarPendientesAck();
    destruirYRecrear();
  });

  c.on('message_ack', (msg, ack) => {
    if (!msg || !msg.fromMe) return;
    const remotoRaw = (msg.to && (msg.to._serialized || msg.to.user || msg.to)) || (msg.id && msg.id.remote) || '';
    const remoto = String(remotoRaw).replace(/\D/g, '');
    const norm = String(msg.body || '').replace(/\s+/g, ' ').trim();
    const key = claveMensaje(remoto || '*', norm);
    let pend = pendientesAck.get(key);
    let kElim = key;
    if (!pend) {
      const ent = [...pendientesAck.entries()].find(([k]) => k.endsWith('|' + norm));
      if (ent) { pend = ent[1]; kElim = ent[0]; }
    }
    if (pend) {
      clearTimeout(pend.timer);
      pendientesAck.delete(kElim);
      pend.resolve({ ack, caducado: false });
    }
    const estados = ['ERROR', 'EN_COLA', 'ENVIADO(SERVIDOR)', 'ENTREGADO(2CHECKS)', 'LEIDO', 'ESCUCHADO'];
    const cuerpo = String(msg.body || '').replace(/\s+/g, ' ').slice(0, 40);
    logLine('ack', 'ack=' + ack + ' (' + (estados[ack] || ack) + ') ' + String(msg.id && msg.id._serialized) + ' [' + cuerpo + ']');
  });

  c.on('message', (msg) => {
    if (msg.fromMe || !clienteListo) return;
    const numero = String(msg.from || '').replace(/\D/g, '');
    const texto = String(msg.body || '');
    if (!numero || !texto) return;

    const resultadoEstudiante = verificarRespuestaEstudiante(numero, texto);
    if (resultadoEstudiante) {
      const phpUrl = SITE_BASE_URL + '/api.php?action=student_confirm&loan_id=' + resultadoEstudiante.loanId + '&auth_code=' + resultadoEstudiante.authCode + '&confirmed=' + (resultadoEstudiante.confirmado ? '1' : '0');
      http.get(phpUrl, (resp) => {
        let d = '';
        resp.on('data', (c) => d += c);
        resp.on('end', () => logLine('confirm', 'Respuesta PHP (estudiante): ' + d));
      }).on('error', (e) => logLine('confirm', 'Error PHP: ' + String(e)));
      return;
    }

    const resultadoAdmin = verificarConfirmacion(numero, texto);
    if (resultadoAdmin) {
      const phpUrl = SITE_BASE_URL + '/api.php?action=whatsapp_confirm&loan_id=' + resultadoAdmin.loanId + '&auth_code=' + resultadoAdmin.authCode + '&approved=' + (resultadoAdmin.aprobado ? '1' : '0');
      http.get(phpUrl, (resp) => {
        let d = '';
        resp.on('data', (c) => d += c);
        resp.on('end', () => logLine('confirm', 'Respuesta PHP (admin): ' + d));
      }).on('error', (e) => logLine('confirm', 'Error PHP: ' + String(e)));
      return;
    }
  });

  return c;
}

function destruirYRecrear() {
  if (shutdownEnCurso || reiniciando) return;
  reiniciando = true;
  clienteListo = false;
  const viejo = client;
  client = null;

  const crearNuevo = () => {
    reiniciando = false;
    client = crearCliente();
    client.initialize().catch((e) => logLine('init', 'Error al inicializar cliente: ' + String(e.message || e)));
  };

  if (viejo) {
    viejo.destroy().catch(() => {}).then(() => setTimeout(crearNuevo, 2000));
  } else {
    crearNuevo();
  }
}

async function enviarWhatsApp(telefono, mensaje) {
  const idPuro = String(telefono).replace(/\D/g, '');
  const chatId = idPuro + '@c.us';
  const intro = 'Envio a ' + idPuro;
  if (!clienteListo) throw new Error('WhatsApp no conectado');

  try {
    const viaNumero = await client.getNumberId(idPuro);
    if (viaNumero) {
      logLine('envio', intro + ' -> via getNumberId');
      const msg = await client.sendMessage(viaNumero._serialized, mensaje);
      return msg || { id: { _serialized: chatId }, ack: 0, fromMe: true, body: mensaje };
    }
  } catch (e) {
    logLine('envio', intro + ' -> getNumberId fallo: ' + String(e.message || e) + ', probando getChatById');
  }

  try {
    const chat = await client.getChatById(chatId);
    const msg = await chat.sendMessage(mensaje);
    return msg || { id: { _serialized: chatId }, ack: 0, fromMe: true, body: mensaje };
  } catch (e2) {
    logLine('envio', intro + ' -> getChatById fallo: ' + String(e2.message || e2));
    throw new Error(String(e2.message || e2));
  }
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

function limpiarBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function authOk(req) {
  if (!WA_API_KEY) return true;
  return String(req.headers['x-api-key'] || '') === WA_API_KEY;
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && req.url === '/qrstate') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ready: clienteListo, gen: genQr }));
    return;
  }

  if (req.method === 'GET' && req.url === '/health') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ ok: true, ready: clienteListo, uptime: process.uptime(), hora: ahora() }));
    return;
  }

  if (req.method === 'GET' && req.url === '/qr-img') {
    if (!qrPngBuf) { res.writeHead(404); res.end('no-qr'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-cache' });
    res.end(qrPngBuf);
    return;
  }

  if (req.method === 'GET' && req.url === '/qr') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    if (clienteListo) {
      res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Vincular WhatsApp</title><style>body{font-family:Arial;background:#0b141a;color:#e9edef;text-align:center;padding:40px;font-size:20px}</style></head><body>WhatsApp conectado</body></html>');
      return;
    }
    if (!qrPngBuf) {
      res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta http-equiv="refresh" content="3"><title>Vincular WhatsApp</title><style>body{font-family:Arial;background:#0b141a;color:#e9edef;text-align:center;padding:40px;font-size:18px}</style></head><body>Generando el codigo QR... espera unos segundos.</body></html>');
      return;
    }
    res.end('<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="refresh" content="18"><title>Vincular WhatsApp</title><style>body{font-family:Arial,Helvetica,sans-serif;background:#0b141a;color:#e9edef;text-align:center;padding:24px 12px;margin:0}h1{font-size:18px;margin:0 0 6px}.st{color:#7ff}img{max-width:min(320px,90vw);border:10px solid #fff;border-radius:14px;background:#fff}.paso{max-width:430px;margin:12px auto 0;color:#b9bec3;font-size:13px;line-height:1.5}.ref{color:#7ff;font-size:12px;margin-top:10px}</style></head><body><h1>Vincular el WhatsApp que envia los codigos</h1><p class="st">Escanea este codigo con el WhatsApp que enviara los codigos.</p><img src="/qr-img" alt="Codigo QR"><div class="paso">En el celular: <b>WhatsApp</b> &rsaquo; <b>Ajustes</b> &rsaquo; <b>Dispositivos vinculados</b> &rsaquo; <b>Vincular un dispositivo</b> y escanear este codigo.</div><div class="ref">Refresco automatico activo.</div></body></html>');
    return;
  }

  if (req.method === 'GET' && req.url === '/status') {
    res.end(JSON.stringify({
      ok: true,
      ready: clienteListo,
      numero: (client && client.info && client.info.wid && client.info.wid.user) || null,
      nombre: (client && client.info && client.info.me && client.info.me.name) || null,
      uptime: Math.round(process.uptime()),
      hora: ahora()
    }));
    return;
  }

  // Endpoints protegidos por WA_API_KEY (si esta definida)
  if (WA_API_KEY && req.headers['x-api-key'] !== WA_API_KEY) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'No autorizado' }));
    return;
  }

  if (req.method === 'POST' && req.url === '/send') {
    let raw = '';
    req.on('data', (c) => raw += c);
    req.on('end', async () => {
      try {
        const datos = JSON.parse(raw || '{}');
        const to = String(datos.to || '');
        const message = String(datos.message || '');
        if (!to || !message) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Faltan to o message' }));
          return;
        }
        if (!clienteListo) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'WhatsApp no conectado (escanea el QR).' }));
          return;
        }
        const enviado = await enviarConReintentos(to, message);
        const idMsg = String((enviado && enviado.id && enviado.id._serialized) || '');
        res.end(JSON.stringify({ ok: true, sid: idMsg, ack: (enviado && enviado.ack) || 0, to: to }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No se pudo enviar: ' + String(e.message || e).slice(0, 200) }));
      }
    });
    return;
  }

  if (req.method === 'POST' && req.url === '/whatsapp-confirm') {
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
        if (!loanId || !numero || !authCode) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'Faltan loan_id, numero o auth_code' }));
          return;
        }
        if (!clienteListo) {
          res.writeHead(503, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'WhatsApp no conectado (escanea el QR).' }));
          return;
        }
        const mensaje = 'Hola ' + studentName + ', tu solicitud del libro "' + bookTitle + '" fue registrada.\n\nTu codigo de autorizacion es: ' + authCode + '\n\nPresentalo al bibliotecario para completar el prestamo.';
        await enviarConReintentos(numero, mensaje);
        registrarConfirmacion(String(numero).replace(/\D/g, ''), loanId, authCode);
        res.end(JSON.stringify({ ok: true, msg: 'Enviado' }));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'No se pudo enviar: ' + String(e.message || e).slice(0, 200) }));
      }
    });
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'Ruta no valida' }));
});

server.listen(PUERTO, HOST, () => {
  logLine('srv', 'Servicio WhatsApp escuchando en http://' + HOST + ':' + PUERTO);
  logLine('srv', 'SITE_BASE_URL=' + SITE_BASE_URL + '  auth=' + WA_AUTH_PATH + '  apiKey=' + (WA_API_KEY ? 'si' : 'no'));
});

client = crearCliente();
client.initialize().catch((e) => logLine('init', 'Error al inicializar cliente: ' + String(e.message || e)));

process.on('SIGTERM', () => { logLine('srv', 'SIGTERM, cerrando'); process.exit(0); });
process.on('SIGINT', () => { logLine('srv', 'SIGINT, cerrando'); process.exit(0); });
