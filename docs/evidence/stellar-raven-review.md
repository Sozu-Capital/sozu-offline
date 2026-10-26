# Informe para Joaquín: revisión de Sozu Offline con Stellar-Raven

**Fecha:** 26 de octubre de 2026

**Origen:** análisis realizado con Stellar-Raven, compartido por Vini.
**Estado:** contraste inicial con `main` (`b862dd1`) y `dev` (`de211cd`), ampliado con decodificación directa del RPC de testnet y una prueba local de archivado con Soroban SDK 27.0.6. No se efectuaron transacciones nuevas.

## Resumen

Stellar-Raven señaló una posible desconexión entre el onboarding de Android y el flujo de la bóveda que funcionó en testnet. En las pruebas, una cuenta Stellar clásica `G...` es propietaria del depósito y una clave P-256 firma los cheques. Según el análisis, la app calcula una dirección `C...` local a partir de la clave P-256, pero no despliega una cuenta contrato que pueda operar con esa dirección. Esto explicaría por qué el fondeo y el depósito desde la app no siguen el flujo ya probado.

Para la demo, la recomendación es **alinear la app con el contrato actual**: crear o gestionar una cuenta `G...`, financiarla con XLM, establecer la trustline de USDC de testnet, obtener USDC del faucet y usar esa cuenta como `owner` del depósito. La clave P-256 permanece como `device_key` para firmar el cheque offline. Esta vía conserva el layout congelado `SOZU1:`.

## Comprobación de los hallazgos de Stellar-Raven

| Área | Hallazgo del análisis | Comprobación necesaria |
| --- | --- | --- |
| Dirección de la app | **Confirmado en código.** `SozuWallet.ensure` calcula `SHA-256` de la clave P-256 comprimida y la codifica como `C...`; no despliega un contrato. `Vault.deposit` convierte los bytes de `owner` en una dirección de cuenta Ed25519 y exige `require_auth()`. | Comprobar en un dispositivo el flujo de creación; no transferir fondos a la `C...` calculada mientras no exista una cuenta contrato autorizable. |
| Onboarding y faucet | **Confirmado en el flujo Android examinado:** `SozuDeviceKey` llama `SozuWallet.ensure` dentro de `runCatching` y no hay llamada al faucet en esa función. **No verificado:** límites, PoW o Turnstile vigentes del servicio faucet. | Probar onboarding en un teléfono y consultar el servicio faucet actual. |
| Notas gastadas y TTL | **Confirmado:** el contrato no llama `extend_ttl` para `Config`, `Account` ni `Spent`. **Prueba local aprobada:** después de superar el TTL, `settle` restaura los datos y devuelve `note-used`, con comisión cero. Se observaron lecturas de disco y escrituras de restauración. | Sigue pendiente una prueba de archivado real en testnet; la prueba local no equivale a esperar el TTL de la red. |
| Verificación P-256 | **Confirmado en código:** se llama `verify_prehash` de `p256` y luego `env.crypto().secp256r1_verify`. | Medir instrucciones/fees antes de calificar el impacto; estudiar una descompresión de clave sin segunda verificación. |
| Receptor | **Confirmado en código:** los 32 bytes del payee se convierten en cuenta Ed25519 `G...`. | Probar el receptor previsto y su trustline de USDC. |
| ID interno de bóveda | **Nuevo hallazgo confirmado en código y RPC:** la configuración desplegada usa 32 bytes `0x01`, pero `SozuCheque.vaultId()` de Android decodifica la dirección `C...` del contrato y utiliza esos otros bytes. Los cheques aceptados en testnet llevan el ID interno congelado. | Alinear Android con el ID de protocolo de la bóveda, conservando el layout. Cambiar solo el owner no resolvería este segundo bloqueo. |

## Evidencia de testnet comprobada

Además de comprobar el depósito exitoso en Horizon, se consultaron directamente las dos transacciones siguientes con `getTransaction` del RPC oficial de testnet:

| Transacción | Ledger | Retorno y eventos decodificados |
| --- | --- | --- |
| [Primer cheque](https://stellar.expert/explorer/testnet/tx/579418f7cba7d72bcb5c1d8523ad3d8c40485b4025c825b0609295f42c9c6b28) | 5390141 | `ok: true`, comisión `100000`; evento `settled` y transferencias USDC de `10000` por el pago y `100000` al settler. |
| [Segundo cheque](https://stellar.expert/explorer/testnet/tx/7e914fbd6249a7e7ba9ccd5e44ee279337a85340222d34f6d371783c1a41a98d) | 5390145 | `ok: false`, `reason: note-used`, comisión `0`; evento `rejected` y ninguna transferencia USDC. Las comisiones de red en XLM son independientes. |

Ambos corresponden a la nota `e435d4bd42beabc8efa5ac9a8b62ce0f`. El script decodifica las invocaciones `settle`, verifica que son dos cheques distintos de 243 bytes, valida sus firmas con `protocol/` y compara sus IDs con la configuración desplegada. Esta comprobación ya no depende solo del registro exportado por el script de envíos.

El [JSON de evidencia](vault-settle-rpc-proof.json) conserva los retornos, eventos, hashes de los cheques y la configuración pública consultada. Para repetir la consulta, mientras el RPC retenga esas transacciones:

```sh
node scripts/verify-vault-testnet-proof.mjs
```

El script solo lee: no construye, firma ni envía transacciones.

## Prueba local de archivado

`archived_spent_note_is_restored_and_still_rejects_a_second_fee`, en `contracts/vault/src/test.rs`, deposita, liquida el vector congelado, avanza la secuencia más allá del TTL y vuelve a llamar `settle`. Mantiene el timestamp para aislar el archivado de la expiración del cheque. El resultado sigue siendo `note-used`, la segunda cuenta recibe cero y la primera conserva su comisión. Las métricas de recursos confirman lecturas de disco y escrituras de restauración.

```sh
cargo test --manifest-path contracts/vault/Cargo.toml
```

Resultado local: 3 pruebas del contrato aprobadas; las 25 pruebas Node de protocolo, overlay y witness también aprobaron. La prueba usa autorización simulada y un token de prueba; no demuestra por sí sola el onboarding Android ni el comportamiento de autenticación del teléfono.

## Corrección sugerida para la demo

1. Usar una cuenta Stellar `G...` real como propietaria de la bóveda.
2. Completar el alta de testnet: XLM para crear la cuenta, trustline de USDC y fondeo mediante el faucet conforme a sus requisitos actuales.
3. Depositar desde esa cuenta con la clave P-256 del dispositivo registrada para firmar cheques.
4. Usar el ID interno de bóveda congelado (`01` repetido 32 veces) al firmar, manteniendo intacto el layout `SOZU1:`. La dirección del contrato sirve para invocar `deposit`/`settle`, no sustituye ese ID de protocolo.
5. Probar el flujo completo desde el teléfono con fondos nuevos. Los resultados históricos de testnet y la restauración local ya se comprobaron; siguen pendientes onboarding, archivado real en testnet y medición de costes de ese caso.

Una smart wallet basada en passkeys sería una vía arquitectónica posterior: requeriría desplegar una cuenta contrato real y revisar la interfaz de la bóveda. El análisis advierte que cambiar la representación de direcciones en el cheque entraría en conflicto con el layout congelado para esta demo.

## Mensaje breve para Joaquín

> Joaco, cerramos dos comprobaciones: el RPC confirma que el primer cheque pagó la comisión y que el segundo, distinto pero de la misma nota, devolvió `note-used` sin transferir USDC. La prueba local de archivado también conserva ese rechazo tras restaurar los datos. Además del owner `G...`, hay otro arreglo necesario en Android: usar el ID interno de la bóveda, que es distinto de su dirección de contrato. El layout `SOZU1:` sigue igual. Quedan pendientes el onboarding real del teléfono y una prueba de archivado en la red.

## Fuente y alcance

El análisis original fue proporcionado por Vini. La comprobación posterior leyó las ramas indicadas, consultó Horizon y decodificó retornos, invocaciones, eventos y configuración con el RPC. El contrato desplegado no se comparó byte a byte con el código fuente; los límites y requisitos actuales del faucet tampoco se verificaron. [Guía oficial de pruebas TTL](https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension) y [guía oficial de restauración](https://developers.stellar.org/docs/build/guides/archival/create-restoration-footprint-js).
