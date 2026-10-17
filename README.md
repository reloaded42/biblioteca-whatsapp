# Biblioteca WhatsApp - despliegue en Render

Servicio Node que conecta un WhatsApp (WhatsApp Web) y envía los códigos
OTP / avisos de la biblioteca. Lo consume el sitio PHP
(`https://bibliotecaiemr.infy.click`) vía `WHATSAPP_WEB_URL`.

## Requisitos
- Cuenta de GitHub (gratis). El repositorio conviene que sea **público** (así las Actions son ilimitadas y el keep-alive sale gratis).
- Cuenta en Render (https://dashboard.render.com, gratis).

## AVISO sobre el plan Free
Con el plan **Free**:
- El servicio se **duerme a los 15 min** sin uso (se despierta solo al recibir tráfico, tarda ~30-60 s).
- **No tiene disco**: al reiniciarse se pierde la sesión de WhatsApp y hay que **re-escanear el QR**.
- Tiene **512 MB de RAM**: Chromium puede quedarse corto. Si el despliegue se cae por memoria, habrá que pasar a **Starter (~7 USD/mes)**.

Para producción estable se recomienda **Starter + disco de 1 GB** (edita `render.yaml`: `plan: starter` y vuelve a poner el bloque `disk`).

## Pasos (sin instalar nada, todo por web)

### 1) Subir el código a GitHub
1. Entra a https://github.com y crea una cuenta (gratis).
2. Botón **+** → **New repository**.
3. Nombre: `biblioteca-whatsapp`. Marca **Public** → **Create repository**.
4. En la página del repo vacío: link **uploading an existing file**.
5. Arrastra **todos** los archivos/carpetas de la carpeta `D:\whatsapp-render`:
   `index.js`, `package.json`, `Dockerfile`, `.dockerignore`, `render.yaml`, `README.md` y la carpeta `.github`.
6. Botón **Commit changes**.

### 2) Crear el servicio en Render
1. Entra a https://dashboard.render.com y crea la cuenta (puedes entrar con GitHub).
2. **New +** → **Blueprint**.
3. Conecta GitHub y elige el repositorio `biblioteca-whatsapp`.
4. Render leerá `render.yaml` y creará el servicio. Pulsa **Apply / Create**.
5. Espera a que termine el **build** (varios minutos la primera vez).

Si el Blueprint no aparece, usa: **New +** → **Web Service** → conecta el repo
→ **Runtime: Docker** → Plan **Free** → **Create Web Service**.

### 2b) Variables de entorno (si lo creaste como Web Service, no por Blueprint)
- `SITE_BASE_URL` = `https://bibliotecaiemr.infy.click`
- `PUPPETEER_EXECUTABLE_PATH` = `/usr/bin/chromium`

### 3) Vincular WhatsApp (escanear QR)
1. Cuando el servicio esté "Live", abre `https://TU-SERVICIO.onrender.com/qr`
2. En el celular del WhatsApp que enviará los códigos:
   **WhatsApp → Ajustes → Dispositivos vinculados → Vincular un dispositivo**.
3. Escanea el QR de la página.
4. Comprueba `https://TU-SERVICIO.onrender.com/status` → debe decir `"ready": true`.

### 4) Avisar al sitio PHP (poner la URL de Render)
En el servidor, en `bibliotecaiemr/incluye/config.php`, cambia:
```php
define('WHATSAPP_WEB_URL', 'https://TU-SERVICIO.onrender.com');
```

## 5) Keep-alive (mantener el sitio despierto 24/7)
El archivo `.github/workflows/keepalive.yml` hace un ping cada 10 minutos para
que el servicio de Render no se duerma.
1. Edita `keepalive.yml` y cambia `https://TU-SERVICIO.onrender.com/health` por
   la URL real de tu servicio en Render.
2. Listo: el workflow se ejecuta solo (pestaña **Actions** del repo).

- Requisito: repositorio **público** (Actions ilimitadas). En repos privados cada
  ping consume ~1 min de los 2000 min/mes y no alcanza para 24/7.
- GitHub desactiva los workflows programados tras **60 días sin actividad** en el
  repo. Si ocurre: **Actions → keep-alive → Enable workflow**.
- Alternativa sin código (más fiable): monitor gratuito tipo
  https://uptimerobot.com o https://cron-job.org apuntando a la misma URL.

## Notas
- El `render.yaml` ya trae `plan: free` y el health check en `/health`.
- Con `autoDeploy: true`, cada vez que edites un archivo en GitHub se vuelve a desplegar.
- Al despertar de la siesta (free), la sesión puede haberse perdido: revisa `/status` y re-escanea el QR si hace falta.
