# Informe para Joaquín: revisión de Sozu Offline con Stellar-Raven

**Fecha:** 26 de octubre de 2026

**Origen:** análisis realizado con Stellar-Raven, compartido por Vini.
**Estado:** contrastado con `origin/main` (`b862dd1`), `origin/dev` (`de211cd`), documentación oficial de Stellar y dos transacciones de testnet consultadas en Horizon. No se efectuaron transacciones nuevas.

## Resumen

Stellar-Raven señaló una posible desconexión entre el onboarding de Android y el flujo de la bóveda que funcionó en testnet. En las pruebas, una cuenta Stellar clásica `G...` es propietaria del depósito y una clave P-256 firma los cheques. Según el análisis, la app calcula una dirección `C...` local a partir de la clave P-256, pero no despliega una cuenta contrato que pueda operar con esa dirección. Esto explicaría por qué el fondeo y el depósito desde la app no siguen el flujo ya probado.

Para la demo, la recomendación es **alinear la app con el contrato actual**: crear o gestionar una cuenta `G...`, financiarla con XLM, establecer la trustline de USDC de testnet, obtener USDC del faucet y usar esa cuenta como `owner` del depósito. La clave P-256 permanece como `device_key` para firmar el cheque offline. Esta vía conserva el layout congelado `SOZU1:`.

## Comprobación de los hallazgos de Stellar-Raven

| Área | Hallazgo del análisis | Comprobación necesaria |
| --- | --- | --- |
| Dirección de la app | **Confirmado en código.** `SozuWallet.ensure` calcula `SHA-256` de la clave P-256 comprimida y la codifica como `C...`; no despliega un contrato. `Vault.deposit` convierte los bytes de `owner` en una dirección de cuenta Ed25519 y exige `require_auth()`. | Comprobar en un dispositivo el flujo de creación; no transferir fondos a la `C...` calculada mientras no exista una cuenta contrato autorizable. |
| Onboarding y faucet | **Confirmado en el flujo Android examinado:** `SozuDeviceKey` llama `SozuWallet.ensure` dentro de `runCatching` y no hay llamada al faucet en esa función. **No verificado:** límites, PoW o Turnstile vigentes del servicio faucet. | Probar onboarding en un teléfono y consultar el servicio faucet actual. |
| Notas gastadas y TTL | **Confirmado:** el contrato no llama `extend_ttl` para `Config`, `Account` ni `Spent`. **Corrección al análisis inicial:** la documentación actual de Stellar indica restauración automática de entradas `persistent` archivadas cuando figuran en la transacción. La ausencia de `extend_ttl` no demuestra por sí sola que una nota pueda gastarse dos veces. Además, el cheque tiene fecha de expiración y el contrato la comprueba. | Probar con ledgers avanzados la restauración de `Spent` y el resultado del segundo `settle`; revisar costes y continuidad de la instancia. |
| Verificación P-256 | **Confirmado en código:** se llama `verify_prehash` de `p256` y luego `env.crypto().secp256r1_verify`. | Medir instrucciones/fees antes de calificar el impacto; estudiar una descompresión de clave sin segunda verificación. |
| Receptor | **Confirmado en código:** los 32 bytes del payee se convierten en cuenta Ed25519 `G...`. | Probar el receptor previsto y su trustline de USDC. |

## Evidencia de testnet comprobada

Horizon confirma que el depósito `8d28a366f5b2d7ce961fea170da2e0ffafae8260eb3540ff3648c57917c5b55a` fue una transacción exitosa en el ledger 5389695 y que el segundo cheque `7e914fbd6249a7e7ba9ccd5e44ee279337a85340222d34f6d371783c1a41a98d` fue una transacción exitosa en el ledger 5390145. El [registro de pruebas del repositorio](https://github.com/Sozu-Capital/sozu-offline/blob/dev/docs/evidence/vini-testnet-runs.md) atribuye al segundo cheque el resultado de contrato `note-used`, comisión cero y saldo USDC sin cambio. **Una transacción exitosa en Horizon no confirma por sí sola ese valor de retorno**: falta decodificar independientemente el resultado o los eventos del contrato en la red.

## Corrección sugerida para la demo

1. Usar una cuenta Stellar `G...` real como propietaria de la bóveda.
2. Completar el alta de testnet: XLM para crear la cuenta, trustline de USDC y fondeo mediante el faucet conforme a sus requisitos actuales.
3. Depositar desde esa cuenta con la clave P-256 del dispositivo registrada para firmar cheques.
4. Mantener intacto el layout `SOZU1:` y repetir en testnet las pruebas de `deposit`, primer `settle` y segundo `settle` del mismo `note id` con rechazo `note-used` y sin segunda comisión.
5. Probar la restauración de `Spent(note_id)` y la continuidad de `Config` ante el TTL, y medir los costes. La documentación oficial no respalda la afirmación de que el simple archivado permita gastar de nuevo una nota.

Una smart wallet basada en passkeys sería una vía arquitectónica posterior: requeriría desplegar una cuenta contrato real y revisar la interfaz de la bóveda. El análisis advierte que cambiar la representación de direcciones en el cheque entraría en conflicto con el layout congelado para esta demo.

## Mensaje breve para Joaquín

> Joaco, hice la revisión con Stellar-Raven y contrasté sus hallazgos con el código y transacciones de testnet. Confirmé la desconexión principal: Android calcula una `C...` local, mientras `Vault.deposit` exige autorización de una cuenta `G...` como owner. La vía corta para la demo es crear y financiar una `G...`, establecer la trustline de USDC y depositar desde ella; P-256 sigue firmando el cheque, sin cambiar `SOZU1:`. Horizon confirma las transacciones de depósito y segundo cheque, y el registro de pruebas reporta `note-used` sin segunda comisión. Corregí un punto del análisis: no hay `extend_ttl`, pero Stellar restaura automáticamente datos `persistent` archivados; aún hay que probar ese caso y sus costes, no afirmar que el TTL ya permite un doble gasto.

## Fuente y alcance

El análisis original fue proporcionado por Vini. La comprobación posterior leyó las ramas indicadas y consultó Horizon. El contrato desplegado no se comparó byte a byte con el código fuente; los límites y requisitos actuales del faucet tampoco se verificaron. [Guía oficial de pruebas TTL](https://developers.stellar.org/docs/build/guides/archival/test-ttl-extension) y [guía oficial de restauración](https://developers.stellar.org/docs/build/guides/archival/create-restoration-footprint-js).
