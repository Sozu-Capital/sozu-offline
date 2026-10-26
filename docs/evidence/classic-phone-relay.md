# Relay propio para los dos teléfonos de testnet

El endpoint codificado en la APK (`app.sozu.capital/api/offline/submit`) devolvía
404. La cuenta GitHub disponible solo tiene lectura en `sozu-wallet`. Para probar
la liquidación sin ese servicio se añadió `scripts/classic-phone-relay.mjs` a
este repositorio.

## Flujo de la prueba

1. En la APK, un teléfono firma el cheque y lo manda como texto privado por la
   malla al otro teléfono. El formato sigue siendo `SOZU1:`, 179 bytes de cuerpo,
   64 de firma P-256 low-S y 243 bytes de wire.
2. El teléfono con internet abre la página del relé, elige su cuenta y pega el
   texto `SOZU1:` completo. Se pulsa **Liquidar en testnet** para enviarlo.
3. El proceso Node del computador valida la firma y los campos del cheque,
   autoriza `settle` con la cuenta `G...` seleccionada y consulta la confirmación
   en el RPC de Stellar Testnet. Las semillas permanecen en los archivos y en
   la memoria local de ese proceso.
4. La página muestra el resultado real, la comisión y el hash en Stellar Expert.
   `/api/offline/ledger` expone los hashes confirmados y sus resultados.

El relé admite únicamente los dos owners provisionados, sus device keys y ambas
cuentas como receptores y settlers. Comprueba las claves y locks registrados en
la bóveda al arrancar. No carga el owner original de la demo ni su colateral.
El contrato continúa verificando el estado y el saldo disponible al liquidar.

## Arranque

Primero se crean y depositan las cuentas de ambos teléfonos. Cada directorio de
sesión local debe contener `wallet-claim.private.json` y `owner-receipt.json`.

Ejemplo PowerShell con rutas locales fuera de Git:

```powershell
$env:SOZU_RELAY_SESSIONS = 'C:\ruta-privada\telefono1;C:\ruta-privada\telefono2'
$env:SOZU_RELAY_LABELS = 'Daniloko;Vinicio'
$env:SOZU_RELAY_LOG = 'C:\ruta-privada\relay\events.jsonl'
$env:PORT = '3033'
node scripts/classic-phone-relay.mjs
```

El servidor escucha en `127.0.0.1:3033`. Para una prueba temporal desde los
teléfonos se puede exponer con un túnel HTTPS controlado por el operador:

```sh
cloudflared tunnel --url http://127.0.0.1:3033 --no-autoupdate
```

El hostname temporal cambia al crear otro túnel. La página depende de que el
computador y ambos procesos permanezcan activos. No se requiere una cuenta,
dominio ni servidor de Sozu Wallet para este recorrido manual.

## Reintentos y rechazos

Las solicitudes se serializan para evitar carreras de secuencia. Dos solicitudes
del mismo wire comparten el envío y conservan el resultado del primer uploader.
Los resultados confirmados se guardan en un JSONL local y se recuperan al
reiniciar; un reintento conserva su resultado incluso si el cheque ya expiró.
Si el proceso cae después de enviar pero antes de guardar la confirmación,
el contrato sigue protegiendo la nota, pero un reintento puede generar otra
transacción de rechazo y pagar su coste de red en XLM.
Un segundo cheque distinto para la misma nota se envía al contrato;
si devuelve `note-used`, la respuesta HTTP es 422, con comisión cero y el hash
de ese rechazo. La página no lo presenta como un pago aceptado.

Los errores de red devuelven 503 sin inventar un hash. Los cheques inválidos,
expirados, de otra red/bóveda, con comisión distinta de `100000` o pertenecientes
a cuentas ajenas se rechazan antes de enviar una transacción.

## Alcance comprobado y pendiente

- Seis pruebas HTTP locales cubren liquidación, ledger, rechazo previo al
  envío, reintentos concurrentes y después de expirar, URLs inválidas y segundo cheque con `note-used`. El submit de
  estas pruebas es un doble controlado, no una transacción de testnet.
- El servicio real comprobó los depósitos de ambos teléfonos al arrancar. Su
  página, `/health`, el ledger vacío y el rechazo de un POST vacío se verificaron
  también por HTTPS.
- Falta recibir un cheque real del teléfono para comprobar este recorrido
  completo contra la red. Ningún envío real se infiere de las pruebas locales.
- La selección del uploader es manual y de confianza del operador; no prueba
  criptográficamente qué teléfono abrió la página. La firma del cheque sí se
  verifica. No es un servicio multiusuario abierto.
- La APK instalada mantiene su URL de subida automática anterior. Este recorrido
  manual no requiere reinstalarla ni cambiar sus claves o depósitos.
- No se probó radio ESP32. El relé no altera `SOZU1:`, `SOZU2:` ni la bóveda.

Stellar Lab también permite invocar `settle` manualmente; la página local evita
que el operador tenga que preparar sus argumentos XDR o introducir una semilla
en el navegador. Referencias: [Stellar Lab](https://lab.stellar.org/) y
[Quick Tunnels de Cloudflare](https://developers.cloudflare.com/tunnel/get-started/quick-tunnels/).
